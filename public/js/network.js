export class Network {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
    this.queue = [];
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
        this.queue.forEach(m => this.ws.send(JSON.stringify(m)));
        this.queue = [];
      };
      this.ws.onerror = reject;
      this.ws.onclose = () => {
        this.connected = false;
        (this.handlers['close'] || []).forEach(h => h({}));
      };
      this.ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data);
          (this.handlers[msg.type] || []).forEach(h => h(msg));
          (this.handlers['*'] || []).forEach(h => h(msg));
        } catch {}
      };
    });
  }

  on(type, fn) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(fn);
    return this;
  }

  send(msg) {
    if (!this.connected) { this.queue.push(msg); return; }
    this.ws.send(JSON.stringify(msg));
  }
}
