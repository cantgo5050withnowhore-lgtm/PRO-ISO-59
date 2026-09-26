const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 4173;
const MAX_ROOM_MEMBERS = 2;
const MAX_ACTIVE_ROOMS = 1000;
const MAX_MESSAGE_LENGTH = 4000;
const ROOM_LIFETIME_MS = 10 * 60 * 1000;
const ROOT = __dirname;
const PUBLIC_FILES = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/transport.js', ['transport.js', 'text/javascript; charset=utf-8']]
]);
const rooms = new Map();
const authAttempts = new Map();

const server = http.createServer(async (request, response) => {
    if(request.method !== 'GET') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET' });
        response.end('Method not allowed');
        return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const publicFile = PUBLIC_FILES.get(pathname);
    if(!publicFile) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    try {
        const [fileName, contentType] = publicFile;
        const content = await readFile(path.join(ROOT, fileName));
        response.writeHead(200, {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        });
        response.end(content);
    } catch(error) {
        console.error(`Failed to serve ${pathname}:`, error);
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Could not load the prototype page.');
    }
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (request, socket, head) => {
    let pathname;
    let origin;
    try {
        pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
        origin = new URL(request.headers.origin);
    } catch {
        socket.destroy();
        return;
    }
    if(pathname !== '/ws' || !request.headers.host || origin.host !== request.headers.host
        || !['http:', 'https:'].includes(origin.protocol)) {
        socket.destroy();
        return;
    }
    webSocketServer.handleUpgrade(request, socket, head, client => {
        webSocketServer.emit('connection', client);
    });
});

function send(client, packet) {
    if(client.readyState === 1) client.send(JSON.stringify(packet));
}

function respond(client, requestPacket, packet) {
    send(client, { ...packet, requestId: requestPacket.requestId });
}

function findRoomByCode(code) {
    pruneRooms();
    return Array.from(rooms.values()).find(room => room.code === code);
}

function pruneRooms() {
    const now = Date.now();
    for(const [roomId, room] of rooms) {
        if(room.expiresAt <= now) {
            rooms.delete(roomId);
            room.clients.forEach(client => {
                client.room = null;
                client.roomMember = null;
                client.close(1000, 'Room expired');
            });
        }
    }
}

function allowCodeAttempt(client) {
    const key = client._socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = (authAttempts.get(key) || []).filter(time => now - time < 60_000);
    if(attempts.length >= 10) {
        authAttempts.set(key, attempts);
        return false;
    }
    attempts.push(now);
    authAttempts.set(key, attempts);
    return true;
}

function validCode(code) {
    return typeof code === 'string' && /^CR5-[A-HJ-NP-Z2-9]{8}$/.test(code);
}

function safeTokenMatch(left, right) {
    if(typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{48}$/i.test(left)
        || !/^[a-f0-9]{48}$/i.test(right)) return false;
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function roomMembers(room) {
    return Array.from(room.clients, client => client.roomMember);
}

function broadcast(room, packet, except = null) {
    room.clients.forEach(client => {
        if(client !== except) send(client, packet);
    });
}

function detach(client) {
    const room = client.room;
    if(!room) return;
    const member = client.roomMember;
    room.clients.delete(client);
    client.room = null;
    client.roomMember = null;
    if(room.clients.size) {
        broadcast(room, { type: 'member.left', member });
    } else {
        rooms.delete(room.id);
    }
}

function validMember(member, expectedRole) {
    return member && typeof member.id === 'string' && typeof member.room === 'string'
        && member.id.length > 0 && member.id.length <= 32 && member.room.length > 0 && member.room.length <= 32
        && (expectedRole === 'HOST' ? member.role === 'HOST' : member.role === 'GUEST');
}

webSocketServer.on('connection', client => {
    client.on('message', raw => {
        let packet;
        try {
            packet = JSON.parse(raw.toString());
        } catch {
            respond(client, {}, { type: 'error', message: 'Invalid JSON packet.' });
            return;
        }
        if(!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.type !== 'string') {
            respond(client, packet || {}, { type: 'error', message: 'Invalid packet.' });
            return;
        }

        if(packet.type === 'room.lookup') {
            if(!allowCodeAttempt(client)) {
                respond(client, packet, { type: 'error', message: 'Too many code attempts. Try again in one minute.' });
                return;
            }
            if(!validCode(packet.code)) {
                respond(client, packet, { type: 'error', message: 'No active room has that code.' });
                return;
            }
            const room = findRoomByCode(packet.code);
            if(!room) {
                respond(client, packet, { type: 'error', message: 'No active room has that code.' });
                return;
            }
            respond(client, packet, { type: 'room.found', roomId: room.id });
            return;
        }

        if(packet.type === 'room.create') {
            const { roomId, code, expiresAt, member, hostToken } = packet;
            if(typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(roomId) || !validCode(code)
                || !safeTokenMatch(hostToken, hostToken) || !validMember(member, 'HOST')) {
                respond(client, packet, { type: 'error', message: 'Room creation details are incomplete.' });
                return;
            }

            let room = rooms.get(roomId);
            if(room && (room.code !== code || !safeTokenMatch(room.hostToken, hostToken))) {
                respond(client, packet, { type: 'error', message: 'This room is already active on another host session.' });
                return;
            }
            if(!room) {
                pruneRooms();
                if(rooms.size >= MAX_ACTIVE_ROOMS) {
                    respond(client, packet, { type: 'error', message: 'The relay is full. Try again later.' });
                    return;
                }
                if(Array.from(rooms.values()).some(activeRoom => activeRoom.code === code)) {
                    respond(client, packet, { type: 'error', message: 'Could not create a unique room code. Try again.' });
                    return;
                }
                const requestedExpiry = Number(expiresAt);
                if(!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now()) {
                    respond(client, packet, { type: 'error', message: 'The room expiry is invalid.' });
                    return;
                }
                room = {
                    id: roomId,
                    code,
                    hostToken,
                    expiresAt: Math.min(requestedExpiry, Date.now() + ROOM_LIFETIME_MS),
                    clients: new Set()
                };
                rooms.set(roomId, room);
            }
            if(client.room === room && client.roomMember?.role !== 'HOST') {
                respond(client, packet, { type: 'error', message: 'This connection is not the room host.' });
                return;
            }
            if(client.room !== room) {
                const previousHost = Array.from(room.clients).find(existing => existing.roomMember?.role === 'HOST');
                if(previousHost) {
                    detach(previousHost);
                    previousHost.close(1000, 'Host reconnected');
                }
                if(room.clients.size >= MAX_ROOM_MEMBERS) {
                    respond(client, packet, { type: 'error', message: 'This room already has two connected members.' });
                    return;
                }
                detach(client);
                client.room = room;
                client.roomMember = member;
                room.clients.add(client);
                broadcast(room, { type: 'member.joined', member }, client);
            }
            respond(client, packet, { type: 'room.created', roomId, expiresAt: room.expiresAt, members: roomMembers(room) });
            return;
        }

        if(packet.type === 'room.join') {
            if(!allowCodeAttempt(client)) {
                respond(client, packet, { type: 'error', message: 'Too many code attempts. Try again in one minute.' });
                return;
            }
            const room = packet.roomId ? rooms.get(packet.roomId) : findRoomByCode(packet.code);
            if(!room || room.expiresAt <= Date.now() || !validCode(packet.code) || room.code !== packet.code) {
                respond(client, packet, { type: 'error', message: 'The room is unavailable or the login code is incorrect.' });
                return;
            }
            if(!validMember(packet.member, 'GUEST')) {
                respond(client, packet, { type: 'error', message: 'Guest details are incomplete.' });
                return;
            }
            if(client.room !== room && room.clients.size >= MAX_ROOM_MEMBERS) {
                respond(client, packet, { type: 'error', message: 'This room is full.' });
                return;
            }
            detach(client);
            client.room = room;
            client.roomMember = packet.member;
            room.clients.add(client);
            respond(client, packet, { type: 'room.joined', roomId: room.id, expiresAt: room.expiresAt, members: roomMembers(room) });
            broadcast(room, { type: 'member.joined', member: packet.member }, client);
            return;
        }

        if(packet.type === 'room.code.rotate') {
            if(!client.room || client.room.clients.size === 0 || client.roomMember?.role !== 'HOST'
                || !validCode(packet.code) || !Number.isFinite(Number(packet.expiresAt))) {
                respond(client, packet, { type: 'error', message: 'Only the room host can rotate the login code.' });
                return;
            }
            client.room.code = packet.code;
            client.room.expiresAt = Math.min(Number(packet.expiresAt), Date.now() + ROOM_LIFETIME_MS);
            broadcast(client.room, { type: 'room.code.rotated', expiresAt: client.room.expiresAt });
            respond(client, packet, { type: 'room.code.updated' });
            return;
        }

        if(packet.type === 'room.message') {
            if(!client.room || client.room.id !== packet.roomId || typeof packet.text !== 'string'
                || packet.text.length === 0 || packet.text.length > MAX_MESSAGE_LENGTH) {
                respond(client, packet, { type: 'error', message: 'Message is invalid or you are not in that room.' });
                return;
            }
            broadcast(client.room, {
                type: 'room.message',
                message: {
                    id: String(packet.id || `${Date.now()}`),
                    senderId: client.roomMember.id,
                    senderRoom: client.roomMember.room,
                    text: packet.text,
                    sentAt: Date.now(),
                    ttlSeconds: 180
                }
            }, client);
            return;
        }

        if(packet.type === 'room.leave') {
            detach(client);
            respond(client, packet, { type: 'room.left' });
            return;
        }

        if(packet.type === 'room.end') {
            if(!client.room || client.roomMember?.role !== 'HOST') {
                respond(client, packet, { type: 'error', message: 'Only the room host can end this room.' });
                return;
            }
            const room = client.room;
            broadcast(room, { type: 'room.ended' }, client);
            rooms.delete(room.id);
            room.clients.forEach(memberClient => {
                if(memberClient === client) return;
                memberClient.room = null;
                memberClient.close(1000, 'Room ended');
            });
            room.clients.clear();
            client.room = null;
            respond(client, packet, { type: 'room.ended' });
            return;
        }

        respond(client, packet, { type: 'error', message: 'Unknown relay command.' });
    });

    client.on('close', () => detach(client));
    client.on('error', error => console.error('WebSocket client error:', error.message));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`PRO-ISO prototype available at http://localhost:${PORT}/`);
    console.log('For off-network access, expose this port through a trusted HTTPS tunnel or reverse proxy.');
});

setInterval(() => {
    pruneRooms();
    for(const [address, attempts] of authAttempts) {
        const recentAttempts = attempts.filter(time => Date.now() - time < 60_000);
        if(recentAttempts.length) authAttempts.set(address, recentAttempts);
        else authAttempts.delete(address);
    }
}, 60_000).unref();
