let currentIdentity = { user: '087', room: 'CR5' };
let roomActive = true;
let nextMessageId = 0;
const CODE_ROTATION_MS = 10 * 60 * 1000;
const inviteParams = new URLSearchParams(location.search.slice(1) || location.hash.slice(1));
const roomId = inviteParams.get('room') || (inviteParams.has('join') ? `legacy-${inviteParams.get('join')}` : 'cr5-private');
const roomEndedKey = `isotope-room-ended:${roomId}`;
const roomDataKey = `isotope-room-data:${roomId}`;
const hostTokenKey = `isotope-room-owner:${roomId}`;
const guestTokenKey = `isotope-room-guest:${roomId}`;
let storedHostToken = '';
try {
    storedHostToken = sessionStorage.getItem(hostTokenKey) || '';
} catch {
    storedHostToken = '';
}
const isRoomHost = Boolean(storedHostToken && readRoomRecord()?.hostToken === storedHostToken);
const isInviteRoute = inviteParams.has('join') && !isRoomHost;
const isEntryRoute = !inviteParams.has('join') && !inviteParams.has('room');
let roomCode = '';
let roomExpiresAt = 0;
let roomChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`isotope-room:${roomId}`) : null;
let roomTransport = null;
let relayReady = false;
let failedJoinAttempts = 0;
let joinLockedUntil = 0;
if(inviteParams.has('join')) {
    const roomName = inviteParams.get('join');
    document.getElementById('room-name').textContent = roomName;
    document.getElementById('join-room-name').textContent = roomName;
}

const MAX_ROOM_MEMBERS = 2;
const State = {
    currentUser: { id: '087', room: 'CR5', role: 'HOST' },
    members: [
        { id: '087', room: 'CR5', role: 'HOST', local: true }
    ],
    messageLifetime: 180,
    messages: []
};

function readRoomRecord() {
    try {
        return JSON.parse(localStorage.getItem(roomDataKey) || 'null');
    } catch {
        return null;
    }
}

function saveRoomRecord(record) {
    try {
        localStorage.setItem(roomDataKey, JSON.stringify(record));
        return true;
    } catch {
        return false;
    }
}

function generateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const randomValues = crypto.getRandomValues(new Uint8Array(8));
    return `CR5-${Array.from(randomValues, value => alphabet[value % alphabet.length]).join('')}`;
}

function showCodeExpiry() {
    const seconds = Math.max(0, Math.ceil((roomExpiresAt - Date.now()) / 1000));
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remainder = String(seconds % 60).padStart(2, '0');
    document.getElementById('code-expiry').textContent = `ROTATES IN ${minutes}:${remainder}`;
    if(isRoomHost && roomActive && seconds === 0) rotateRoomCode();
}

function rotateRoomCode() {
    if(!isRoomHost || !roomActive) return;
    roomCode = generateRoomCode();
    roomExpiresAt = Date.now() + CODE_ROTATION_MS;
    document.getElementById('login-code').textContent = roomCode;
    saveRoomRecord({ ...readRoomRecord(), code: roomCode, expiresAt: roomExpiresAt, endedAt: null });
    roomChannel?.postMessage({ type: 'code-rotated', roomId, expiresAt: roomExpiresAt });
    if(roomTransport && relayReady) {
        roomTransport.request('room.code.rotate', { code: roomCode, expiresAt: roomExpiresAt })
            .catch(error => activity(`Login code could not be updated on the relay: ${error.message}`, 'error'));
    }
    activity('Login code rotated. Share the new code with anyone joining.');
    showCodeExpiry();
}

function initializeRoom() {
    document.body.classList.toggle('join-required', isInviteRoute || isEntryRoute);
    if(isEntryRoute) {
        document.getElementById('join-title').textContent = 'Enter code to join';
        document.getElementById('join-room-name').textContent = 'EXISTING ROOM';
        document.querySelector('.join-label').textContent = 'LOGIN CODE';
        document.getElementById('join-feedback').textContent = 'Enter the current code from your room invite, or create a room.';
        return;
    }
    if(isInviteRoute) {
        document.getElementById('join-feedback').textContent = 'Enter the current code shared by the room creator.';
        return;
    }

    const record = readRoomRecord();
    if(record?.endedAt) {
        document.getElementById('create-room-btn').hidden = false;
        scrubSession();
        activity('This room has ended. Create a new room to continue.', 'warn');
        return;
    }
    roomCode = record?.code || document.getElementById('login-code').textContent.trim();
    roomExpiresAt = record?.expiresAt || Date.now() + CODE_ROTATION_MS;
    document.getElementById('login-code').textContent = roomCode;
    if(!record) saveRoomRecord({ code: roomCode, expiresAt: roomExpiresAt, endedAt: null });
    if(roomExpiresAt <= Date.now()) rotateRoomCode();
    showCodeExpiry();
    setInterval(showCodeExpiry, 1000);
}

async function connectRoomRelay() {
    if(!roomTransport) roomTransport = new RoomTransport(handleRelayEvent);
    await roomTransport.connect();

    if(isRoomHost && !relayReady) {
        const result = await roomTransport.request('room.create', {
            roomId,
            code: roomCode,
            expiresAt: roomExpiresAt,
            hostToken: storedHostToken,
            member: { id: currentIdentity.user, room: currentIdentity.room, role: 'HOST' }
        });
        State.members = result.members.map(member => ({ ...member, local: member.role === 'HOST' }));
        renderRoomMembers();
        relayReady = true;
        document.getElementById('room-status').textContent = 'CONNECTED VIA RELAY';
        activity('Room connected to the plaintext relay. Share the invite link and code.');
    }
}

function handleRelayEvent(packet) {
    if(packet.type === 'connection.closed') {
        relayReady = false;
        activity('Relay connection closed. Messages cannot be sent until reconnected.', 'error');
        return;
    }
    if(packet.type === 'connection.error') {
        activity(packet.message, 'error');
        return;
    }
    if(packet.type === 'member.joined') {
        if(!State.members.some(member => member.role === packet.member.role)) {
            State.members.push({ ...packet.member, local: false });
            renderRoomMembers();
            activity(`User ${packet.member.id} joined the room.`);
        }
        return;
    }
    if(packet.type === 'member.left') {
        State.members = State.members.filter(member => member.role !== packet.member.role);
        renderRoomMembers();
        activity(`User ${packet.member.id} left the room.`, 'warn');
        return;
    }
    if(packet.type === 'room.message') {
        const payload = packet.message;
        const timeRemaining = Math.ceil((payload.sentAt + payload.ttlSeconds * 1000 - Date.now()) / 1000);
        if(timeRemaining > 0) sendMessage(payload.text, payload.senderId, payload.senderRoom, false, timeRemaining);
        return;
    }
    if(packet.type === 'room.code.rotated') {
        roomExpiresAt = packet.expiresAt;
        if(!isRoomHost) activity('Login code rotated by the room creator.');
        showCodeExpiry();
        return;
    }
    if(packet.type === 'room.ended') endSessionForInvitee();
}

async function joinRoom(event) {
    event.preventDefault();
    const feedback = document.getElementById('join-feedback');
    const enteredCode = document.getElementById('join-code-input').value.trim().toUpperCase();
    if(Date.now() < joinLockedUntil) {
        feedback.textContent = `Too many attempts. Try again in ${Math.ceil((joinLockedUntil - Date.now()) / 1000)} seconds.`;
        return;
    }
    const submit = document.querySelector('.join-submit');
    submit.disabled = true;
    feedback.textContent = 'Connecting to the room relay...';
    try {
        await connectRoomRelay();
        if(isEntryRoute) {
            const room = await roomTransport.request('room.lookup', { code: enteredCode });
            if(!room.roomId) throw new Error('The relay did not return a room ID.');
            sessionStorage.setItem('isotope-pending-room-join', JSON.stringify({ roomId: room.roomId, code: enteredCode }));
            const roomName = 'CR5 / PRIVATE';
            location.assign(`${location.href.split(/[?#]/)[0]}?join=${encodeURIComponent(roomName)}&room=${encodeURIComponent(room.roomId)}`);
            return;
        }

        const guestMember = { id: '214', room: 'NX2', role: 'GUEST' };
        const joined = await roomTransport.request('room.join', { roomId, code: enteredCode, member: guestMember });
        roomCode = enteredCode;
        roomExpiresAt = joined.expiresAt || Date.now() + CODE_ROTATION_MS;
        State.members = joined.members.map(member => ({ ...member, local: member.role === 'GUEST' }));
        renderRoomMembers();
        relayReady = true;
        roomActive = true;
        currentIdentity = { user: guestMember.id, room: guestMember.room };
        State.currentUser = { ...guestMember };
        document.body.classList.remove('join-required');
        document.getElementById('room-invite-controls').hidden = true;
        document.getElementById('room-invite-section').hidden = true;
        document.getElementById('end-session-btn').hidden = true;
        document.getElementById('room-status').textContent = 'CONNECTED VIA RELAY';
        document.getElementById('composer-label').textContent = `PRO-ISO:user ${currentIdentity.user} ${currentIdentity.room}:`;
        activity('Joined room through the plaintext relay.');
        showCodeExpiry();
    } catch(error) {
        failedJoinAttempts++;
        if(failedJoinAttempts >= 5) {
            joinLockedUntil = Date.now() + 30_000;
            failedJoinAttempts = 0;
        }
        feedback.textContent = error.message;
        if(roomTransport && !relayReady) roomTransport.close();
    } finally {
        submit.disabled = false;
    }
}

document.getElementById('join-form').addEventListener('submit', joinRoom);
try {
    const pendingJoin = JSON.parse(sessionStorage.getItem('isotope-pending-room-join') || 'null');
    if(pendingJoin?.roomId === roomId && isInviteRoute) {
        sessionStorage.removeItem('isotope-pending-room-join');
        document.getElementById('join-code-input').value = pendingJoin.code;
        document.getElementById('join-form').requestSubmit();
    }
} catch {
    sessionStorage.removeItem('isotope-pending-room-join');
}
window.addEventListener('storage', event => {
    if(event.key !== roomDataKey || !event.newValue) return;
    const record = JSON.parse(event.newValue);
    if(record.endedAt) endSessionForInvitee();
    else if(record.code && record.code !== roomCode) {
        roomExpiresAt = record.expiresAt;
    }
    if(isRoomHost && record.guestSessionToken && record.guestExpiresAt > Date.now() && !State.members.some(member => member.role === 'GUEST')) {
        State.members.push({ id: '214', room: 'NX2', role: 'GUEST', local: false });
        renderRoomMembers();
    } else if(isRoomHost && (!record.guestSessionToken || record.guestExpiresAt <= Date.now())) {
        State.members = State.members.filter(member => member.role !== 'GUEST');
        renderRoomMembers();
    }
});

function releaseGuestSeat() {
    if(isRoomHost) return;
    clearInterval(window.roomGuestHeartbeat);
    try {
        const record = readRoomRecord();
        const token = sessionStorage.getItem(guestTokenKey);
        if(record?.guestSessionToken && token === record.guestSessionToken) {
            delete record.guestSessionToken;
            delete record.guestExpiresAt;
            saveRoomRecord(record);
            roomChannel?.postMessage({ type: 'member-left', roomId, userId: '214' });
        }
        sessionStorage.removeItem(guestTokenKey);
    } catch {
        // An abandoned seat expires automatically after its heartbeat stops.
    }
}

window.addEventListener('pagehide', releaseGuestSeat);

function getLocalSignalLevel() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(!connection) return null;
    const typeLevels = { 'slow-2g': 1, '2g': 1, '3g': 2, '4g': 4 };
    if(typeLevels[connection.effectiveType]) return typeLevels[connection.effectiveType];
    if(Number.isFinite(connection.downlink)) return connection.downlink >= 5 ? 4 : connection.downlink >= 1.5 ? 3 : connection.downlink >= 0.5 ? 2 : 1;
    return null;
}

function renderRoomMembers() {
    const memberList = document.getElementById('member-list');
    const count = document.getElementById('room-member-count');
    memberList.replaceChildren();
    count.textContent = `(${State.members.length}/${MAX_ROOM_MEMBERS})`;

    State.members.forEach(member => {
        const button = document.createElement('button');
        button.className = `member-btn${member.local ? ' self' : ''}${member.id === currentIdentity.user ? ' active' : ''}`;
        button.type = 'button';
        button.setAttribute('aria-label', `User ${member.id}, ${member.local ? 'you, ' : ''}${member.role.toLowerCase()}`);
        if(member.local) button.addEventListener('click', () => setIdentity(member.id, member.room));

        const dot = document.createElement('span');
        dot.className = 'member-dot';
        const copy = document.createElement('span');
        copy.className = 'member-copy';
        copy.append(`User ${member.id}`);
        const role = document.createElement('span');
        role.className = 'member-id';
        role.textContent = `${member.local ? 'YOU / ' : ''}${member.role}`;
        copy.appendChild(role);

        const level = member.local ? getLocalSignalLevel() : null;
        const signal = document.createElement('span');
        signal.className = 'signal-status';
        signal.setAttribute('aria-label', level === null ? 'Network signal unavailable' : `Estimated network signal: ${level} of 4 bars`);
        const bars = document.createElement('span');
        bars.className = 'signal-bars';
        bars.setAttribute('aria-hidden', 'true');
        bars.dataset.level = String(level ?? 0);
        for(let index = 1; index <= 4; index++) {
            const bar = document.createElement('span');
            bar.style.setProperty('--bar-height', `${4 + index * 2.5}px`);
            bars.appendChild(bar);
        }
        signal.append(bars, level === null ? 'N/A' : `${level}/4`);
        button.append(dot, copy, signal);
        memberList.appendChild(button);
    });
}

function addRoomMember(member) {
    if(State.members.length >= MAX_ROOM_MEMBERS) {
        activity('Room is full. Only two people can join this room.', 'warn');
        return false;
    }
    State.members.push(member);
    renderRoomMembers();
    return true;
}

function activity(message, type = 'info') {
    const logs = document.getElementById('activity-log');
    const row = document.createElement('div');
    row.className = 'activity-line';
    row.textContent = `${new Date().toLocaleTimeString()} // ${message}`;
    if(type === 'warn') row.style.color = 'var(--term-amber)';
    if(type === 'error') row.style.color = '#e58c82';
    logs.prepend(row);
    while(logs.children.length > 8) logs.lastElementChild.remove();
}

function scrubSession() {
    roomActive = false;
    State.messages.forEach(message => {
        clearInterval(message.timerId);
        message.text = null;
    });
    State.messages.length = 0;
    document.querySelectorAll('.message-line').forEach(message => message.remove());
    document.querySelectorAll('#enc-recipient, #enc-payload, #enc-key, #dec-sender, #dec-cipher, #dec-key').forEach(input => {
        input.value = '';
    });
    document.getElementById('my-pub-key').value = '';
    document.getElementById('decrypted-output').textContent = 'Session data cleared.';
    document.getElementById('message-input').value = '';
    document.getElementById('message-input').disabled = true;
    document.querySelector('.send-btn').disabled = true;
    document.getElementById('session-expiry').textContent = 'Session ended';
    document.getElementById('room-status').textContent = 'SESSION ENDED';
}

function endSessionForInvitee() {
    if(!roomActive) return;
    if(document.body.classList.contains('join-required')) {
        roomActive = false;
        document.getElementById('join-feedback').textContent = 'This room has ended. Ask the creator for a new invite.';
        document.querySelector('.join-submit').disabled = true;
        return;
    }
    releaseGuestSeat();
    scrubSession();
    activity('SESSION ENDED by the room creator.', 'error');
    document.getElementById('create-room-btn').hidden = false;
    roomChannel?.close();
    relayReady = false;
    roomTransport?.close();
}

roomChannel?.addEventListener('message', event => {
    if(event.data?.roomId !== roomId) return;
    if(event.data.type === 'session-ended') endSessionForInvitee();
    if(event.data.type === 'code-rotated' && !isRoomHost) {
        roomExpiresAt = event.data.expiresAt;
        if(!document.body.classList.contains('join-required')) activity('Login code rotated by the room creator.');
    }
    if(isRoomHost && event.data.type === 'member-joined' && !State.members.some(member => member.role === 'GUEST')) {
        State.members.push({ ...event.data.member, local: false });
        renderRoomMembers();
    }
    if(isRoomHost && event.data.type === 'member-left') {
        State.members = State.members.filter(member => member.role !== 'GUEST');
        renderRoomMembers();
    }
});

try {
    if(localStorage.getItem(roomEndedKey)) endSessionForInvitee();
} catch {
    // Storage can be unavailable for local files; the live tab channel still works.
}

function noteInterruption(message) {
    activity(`INTERRUPTION // ${message}`, 'warn');
}

window.addEventListener('offline', () => noteInterruption('Network connection lost.'));
window.addEventListener('online', () => noteInterruption('Network connection restored.'));
window.addEventListener('blur', () => noteInterruption('Chat tab lost focus.'));
window.addEventListener('focus', () => noteInterruption('Chat tab is active again.'));
document.addEventListener('visibilitychange', () => {
    noteInterruption(document.hidden ? 'Chat tab is hidden.' : 'Chat tab is visible.');
});

function logTerminal(prefix, message, type = 'info') {
    activity(`[${prefix}] ${message}`, type === 'err' ? 'error' : type === 'warn' ? 'warn' : 'info');
}

function updateComposerLabel() {
    document.getElementById('composer-label').textContent = `PRO-ISO:user ${currentIdentity.user} ${currentIdentity.room}:`;
    State.currentUser.id = currentIdentity.user;
    State.currentUser.room = currentIdentity.room;
    renderRoomMembers();
}

function setIdentity(user, room) {
    currentIdentity = { user, room };
    updateComposerLabel();
    activity(`Identity switched to user ${user}.`);
    document.getElementById('message-input').focus();
}

function createMessage(text, userId = State.currentUser.id, roomId = State.currentUser.room) {
    return {
        id: `msg-${Date.now()}-${++nextMessageId}`,
        sender: `PRO-ISO:user ${userId} ${roomId}`,
        userId,
        text,
        timeRemaining: State.messageLifetime,
        timerId: null
    };
}

function handleSendMessage(inputEl) {
    const text = inputEl.value.trim();
    if(!text || !roomActive) return;
    if(sendMessage(text)) inputEl.value = '';
}

function sendMessage(text, userId = State.currentUser.id, roomName = State.currentUser.room, relay = true, timeRemaining = State.messageLifetime) {
    const content = String(text || '').trim();
    if(!content || !roomActive) return null;
    if(relay) {
        if(!relayReady || !roomTransport) {
            activity('Message not sent: the room relay is not connected.', 'error');
            return null;
        }
    }
    const message = createMessage(content, userId, roomName);
    message.timeRemaining = timeRemaining;
    if(relay) {
        try {
            roomTransport.send('room.message', { roomId, id: message.id, text: content });
        } catch(error) {
            activity(`Message not sent: ${error.message}`, 'error');
            return null;
        }
    }
    State.messages.push(message);
    renderMessage(message);
    startMessageScrubber(message);
    activity(`Message sent by user ${userId}; auto-erases in ${State.messageLifetime}s.`);
    return message;
}

function renderMessage(message) {
    const chatContainer = document.getElementById('transcript');
    const messageElement = document.createElement('div');
    messageElement.id = message.id;
    messageElement.className = 'terminal-line message-line terminal-message';

    const header = document.createElement('span');
    header.className = `terminal-prefix ${message.userId === '087' ? 'self' : 'guest'}`;
    header.textContent = `${message.sender}:`;

    const body = document.createElement('span');
    body.className = 'terminal-text';
    body.textContent = message.text;

    const timer = document.createElement('span');
    timer.className = 'line-expiry';
    timer.append('erases in ');
    const timerCount = document.createElement('span');
    timerCount.className = 'timer-count';
    timerCount.textContent = message.timeRemaining;
    timer.append(timerCount, 's');
    body.appendChild(timer);

    messageElement.append(header, body);
    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function startMessageScrubber(message) {
    message.timerId = setInterval(() => {
        message.timeRemaining--;
        const messageElement = document.getElementById(message.id);
        const timer = messageElement?.querySelector('.timer-count');
        if(timer) timer.textContent = message.timeRemaining;
        if(message.timeRemaining <= 0) purgeSingleMessage(message.id);
    }, 1000);
}

function purgeSingleMessage(messageId) {
    const index = State.messages.findIndex(message => message.id === messageId);
    if(index === -1) return;

    const [message] = State.messages.splice(index, 1);
    clearInterval(message.timerId);
    message.text = null;

    const messageElement = document.getElementById(messageId);
    if(messageElement) {
        messageElement.style.opacity = '0';
        setTimeout(() => messageElement.remove(), 300);
    }
    activity(`Scrubbed payload ${messageId} from memory.`);
}

document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-btn');
    if(!sendButton || !messageInput) return;

    sendButton.addEventListener('click', () => handleSendMessage(messageInput));
    messageInput.addEventListener('keydown', event => {
        if(event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSendMessage(messageInput);
        }
    });
});

function toggleCrypto(forceOpen) {
    const drawer = document.getElementById('crypto-drawer');
    drawer.hidden = typeof forceOpen === 'boolean' ? !forceOpen : !drawer.hidden;
}

function switchTab(tabName) {
    document.querySelectorAll('.drawer-tab').forEach((tab, index) => tab.classList.toggle('active', ['encrypt', 'decrypt', 'keys'][index] === tabName));
    document.querySelectorAll('.drawer-content').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tabName}`));
}

function executeEncrypt() {
    activity('Encryption is not implemented in this prototype. Use the main chat to send plaintext test messages.', 'warn');
}

function executeDecrypt() {
    activity('Decryption is not implemented; no ciphertext is processed by this prototype.', 'warn');
}

async function copyText(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        activity(`${label} copied to clipboard.`);
    } catch {
        activity(`Clipboard unavailable. Share manually: ${text}`, 'warn');
    }
}

function copyInvite() {
    copyText(createInviteUrl().href, 'Room invite link');
}

function createInviteUrl() {
    const invite = new URL(location.href);
    invite.search = '';
    invite.hash = new URLSearchParams({ join: document.getElementById('room-name').textContent, room: roomId }).toString();
    return invite;
}

function shareInviteOnWhatsApp() {
    const inviteUrl = createInviteUrl();
    const message = `Join my PRO-ISO room: ${inviteUrl.href}\nOpen the link and enter the current room code I'll send you.`;
    const shareUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
}

function createNewRoom() {
    const randomValues = crypto.getRandomValues(new Uint8Array(16));
    const nextRoomId = `room-${Array.from(randomValues, value => value.toString(16).padStart(2, '0')).join('')}`;
    const nextCode = generateRoomCode();
    const tokenValues = crypto.getRandomValues(new Uint8Array(24));
    const hostToken = Array.from(tokenValues, value => value.toString(16).padStart(2, '0')).join('');
    const nextRoomName = 'CR5 / PRIVATE';
    try {
        localStorage.removeItem(`isotope-room-ended:${nextRoomId}`);
        localStorage.setItem(`isotope-room-data:${nextRoomId}`, JSON.stringify({ code: nextCode, expiresAt: Date.now() + CODE_ROTATION_MS, endedAt: null, hostToken }));
        sessionStorage.setItem(`isotope-room-owner:${nextRoomId}`, hostToken);
    } catch {
        activity('Room could not be created because browser storage is unavailable.', 'error');
        return;
    }
    const invite = new URL(location.href);
    invite.search = new URLSearchParams({ join: nextRoomName, room: nextRoomId }).toString();
    invite.hash = '';
    location.assign(invite.href);
}

function copyLoginCode() {
    if(isRoomHost) copyText(document.getElementById('login-code').textContent, 'Login code');
}

async function scanRoom() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const network = navigator.onLine ? 'online' : 'offline';
    const quality = connection?.effectiveType || 'not reported by browser';
    const throughput = Number.isFinite(connection?.downlink) ? `${connection.downlink} Mbps` : 'throughput unavailable';
    const roundTrip = Number.isFinite(connection?.rtt) ? `${connection.rtt} ms RTT` : 'latency unavailable';
    const focus = document.hasFocus() ? 'focused' : 'not focused';
    const visibility = document.visibilityState;
    const secure = isSecureContext ? 'secure context' : 'local/insecure context';
    const permissions = navigator.permissions?.query
        ? await Promise.all(['camera', 'microphone', 'geolocation', 'notifications'].map(async name => {
            try {
                const result = await navigator.permissions.query({ name });
                return `${name} ${result.state}`;
            } catch {
                return `${name} unsupported`;
            }
        }))
        : ['permission status unavailable'];
    activity(`SCAN // ${network}; ${quality}; ${throughput}; ${roundTrip}; tab ${visibility}/${focus}; ${secure}; ${permissions.join(', ')}.`);
    activity('SCAN LIMIT // Browser-local checks only; remote devices, traffic, and external processes are not visible here.');
}

async function leaveRoom() {
    releaseGuestSeat();
    try {
        if(relayReady && roomTransport) await roomTransport.request('room.leave');
    } catch(error) {
        activity(`Could not leave the relay cleanly: ${error.message}`, 'error');
    }
    relayReady = false;
    roomTransport?.close();
    roomActive = false;
    document.getElementById('room-status').textContent = 'ROOM LEFT';
    document.getElementById('message-input').disabled = true;
    document.querySelector('.send-btn').disabled = true;
    activity(`User ${currentIdentity.user} left the room.`, 'warn');
}

async function endSession() {
    if(!isRoomHost || !roomActive) return;
    const endedAt = Date.now();
    roomChannel?.postMessage({ type: 'session-ended', roomId, endedAt });
    try {
        localStorage.setItem(roomEndedKey, String(endedAt));
        saveRoomRecord({ ...readRoomRecord(), code: roomCode, expiresAt: roomExpiresAt, endedAt });
    } catch {
        // The message channel still notifies invite tabs currently open in this browser.
    }
    try {
        if(relayReady && roomTransport) await roomTransport.request('room.end');
    } catch(error) {
        activity(`The relay could not notify other devices: ${error.message}`, 'error');
    }
    scrubSession();
    activity('SESSION ENDED. Session data cleared; closing this tab.', 'error');
    roomChannel?.close();
    roomTransport?.close();
    setTimeout(() => {
        window.close();
        if(!window.closed) {
            document.getElementById('room-status').textContent = 'SESSION ENDED - CLOSE THIS TAB';
            document.getElementById('create-room-btn').hidden = false;
            activity('This browser did not allow the page to close itself. Close this tab to exit.', 'warn');
        }
    }, 150);
}

function generateNewKeys() {
    const randomHex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
    document.getElementById('my-pub-key').value = `0x${randomHex}`;
    activity('Demo public key rotated. No private key or real cryptographic operation is configured.');
}

updateComposerLabel();
renderRoomMembers();
initializeRoom();
if(isRoomHost && roomActive) {
    connectRoomRelay().catch(error => activity(`Could not connect to the room relay: ${error.message}`, 'error'));
}
if(isInviteRoute) {
    const inviteEnded = localStorage.getItem(roomEndedKey);
    if(inviteEnded) endSessionForInvitee();
}
const localConnection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
localConnection?.addEventListener('change', renderRoomMembers);
activity('Volatile session armed for 180 seconds per message.');
