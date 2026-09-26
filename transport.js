class RoomTransport {
    constructor(onEvent) {
        this.onEvent = onEvent;
        this.socket = null;
        this.pendingRequests = new Map();
    }

    connect() {
        if(this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
        if(this.socket?.readyState === WebSocket.CONNECTING) {
            return new Promise((resolve, reject) => {
                this.socket.addEventListener('open', resolve, { once: true });
                this.socket.addEventListener('error', reject, { once: true });
            });
        }
        if(location.protocol !== 'http:' && location.protocol !== 'https:') {
            return Promise.reject(new Error('Open this page from the prototype server, not as a file.'));
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = new WebSocket(`${protocol}//${location.host}/ws`);

        return new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', () => reject(new Error('Could not connect to the room relay.')), { once: true });
            this.socket.addEventListener('message', event => this.handleMessage(event));
            this.socket.addEventListener('close', () => {
                this.pendingRequests.forEach(({ reject: rejectRequest, timeout }) => {
                    clearTimeout(timeout);
                    rejectRequest(new Error('The room relay connection closed.'));
                });
                this.pendingRequests.clear();
                this.onEvent({ type: 'connection.closed' });
            });
        });
    }

    request(type, details = {}) {
        const requestId = `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('The room relay did not respond in time.'));
            }, 10_000);
            this.pendingRequests.set(requestId, { resolve, reject, timeout });

            try {
                this.send(type, { ...details, requestId });
            } catch(error) {
                clearTimeout(timeout);
                this.pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    send(type, details = {}) {
        if(this.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('The room relay is not connected.');
        }
        this.socket.send(JSON.stringify({ type, ...details }));
    }

    handleMessage(event) {
        let packet;
        try {
            packet = JSON.parse(event.data);
        } catch {
            this.onEvent({ type: 'connection.error', message: 'The relay sent an unreadable message.' });
            return;
        }

        const pending = packet.requestId && this.pendingRequests.get(packet.requestId);
        if(pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(packet.requestId);
            if(packet.type === 'error') pending.reject(new Error(packet.message));
            else pending.resolve(packet);
            return;
        }

        this.onEvent(packet);
    }

    close() {
        this.socket?.close();
    }
}
