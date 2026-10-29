// Client for Wi-Fi / LAN printers (SR5900P family) through the backend.
//
// Unlike Bluetooth there is no long-lived connection: the backend opens a print
// session per job (UDP lock, TCP data, UDP status polling, unlock). "Connecting"
// in the UI just means the printer answered a status request.

export class NetworkLink extends EventTarget {
  constructor() {
    super();
    this.kind = 'network';
    this.device = null;   // { id, name, host, port, model }
    this.lastStatus = null;
    this._events = null;
  }

  get connected() { return !!this.device; }

  log(message, kind = 'info') {
    this.dispatchEvent(new CustomEvent('log', { detail: { message, kind } }));
  }

  static async listPrinters() {
    const res = await fetch('/api/printers');
    return (await res.json()).printers || [];
  }

  static async savePrinter(printer) {
    const res = await fetch('/api/printers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(printer),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not save the printer');
    return body;
  }

  static async removePrinter(id) {
    const res = await fetch(`/api/printers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not remove the printer');
    return body.printers;
  }

  static async discover() {
    const res = await fetch('/api/net/discover');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Discovery failed');
    return body.printers;
  }

  _query(extra = {}) {
    const q = new URLSearchParams({ host: this.device.host, port: String(this.device.port), ...extra });
    return q.toString();
  }

  openEventStream() {
    if (this._events) return;
    const es = new EventSource('/api/events');
    this._events = es;
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!this.device) return;
      const mine = msg.host === this.device.host && msg.port === this.device.port;
      if (msg.type === 'log') this.log(`[server] ${msg.message}`, msg.kind);
      else if (msg.type === 'net-progress' && mine) {
        this.dispatchEvent(new CustomEvent('progress', { detail: msg }));
      } else if (msg.type === 'net-status' && mine) {
        this._setStatus(msg.status);
      }
    };
  }

  closeEventStream() {
    if (this._events) { this._events.close(); this._events = null; }
  }

  _setStatus(status) {
    this.lastStatus = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  /** @param {{id?:string, name?:string, host:string, port?:number, model:string}} printer */
  async connect(printer) {
    this.device = { port: 9100, ...printer };
    try {
      await this.fetchStatus();
    } catch (err) {
      this.device = null;
      throw err;
    }
    this.openEventStream();
    return this.device;
  }

  async disconnect() {
    this.closeEventStream();
    this.device = null;
  }

  async fetchStatus() {
    const res = await fetch(`/api/net/status?${this._query()}`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`${body.error || 'No response'}. Check the printer's IP address, that it is on `
        + 'and on the same network.');
    }
    this._setStatus(body.status);
    return body.status;
  }

  /**
   * Sends a complete job (from buildNetworkJobBytes) and resolves once the printer is done.
   * @param {Uint8Array} bytes
   * @param {{pages:number, tapeCode:number}} info
   */
  async print(bytes, { pages, tapeCode }) {
    const res = await fetch(`/api/net/print?${this._query({ pages: String(pages), tape: String(tapeCode) })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 499) {
      const err = new Error('Cancelled');
      err.name = 'PrintAborted';
      throw err;
    }
    if (!res.ok) throw new Error(body.error || `Print failed (${res.status})`);
  }

  async cancel() {
    await fetch(`/api/net/cancel?${this._query()}`, { method: 'POST' }).catch(() => {});
  }
}
