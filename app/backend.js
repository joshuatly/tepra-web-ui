// バックエンド (server/index.js) 越しにプリンタと通信するクライアント。
// 経路は Bluetooth Classic (RFCOMM) 直結のみ。
// PrintJob が使う connect / disconnect / send / waitStatus を提供する。

export class BackendLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.lastStatus = null;
    this.totalWritten = 0;
    this._statusWaiters = [];
    this._events = null;
  }

  get connected() { return !!this.device; }

  log(message, kind = 'info') {
    this.dispatchEvent(new CustomEvent('log', { detail: { message, kind } }));
  }

  /** バックエンドが動いているか / Bluetooth が使えるか */
  static async probe() {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`Backend is not responding (${res.status})`);
    return res.json();
  }

  /** ペアリング済みの Bluetooth 端末 */
  static async listDevices() {
    const res = await fetch('/api/devices');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not list devices');
    return body.devices;
  }

  /**
   * バックエンドからのイベント (ステータス / ログ / 切断) を購読する。
   * connect() が自動で呼ぶ。ページ読み込み時に張りっぱなしにはしない。
   */
  openEventStream() {
    if (this._events) return;
    const es = new EventSource('/api/events');
    this._events = es;
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handleEvent(msg);
    };
    es.onerror = () => {
      // EventSource は自動再接続する。切れている間はログだけ出す。
      this.log('Lost the event stream from the backend (reconnecting)', 'warn');
    };
  }

  closeEventStream() {
    if (this._events) { this._events.close(); this._events = null; }
  }

  _handleEvent(msg) {
    switch (msg.type) {
      case 'log':
        this.log(`[backend] ${msg.message}`, msg.kind);
        break;
      case 'status': {
        this.lastStatus = msg.status;
        this.dispatchEvent(new CustomEvent('status', { detail: msg.status }));
        const waiters = this._statusWaiters;
        this._statusWaiters = [];
        for (const w of waiters) w.resolve(msg.status);
        break;
      }
      case 'connected':
        this.device = msg.device;
        this.dispatchEvent(new CustomEvent('connected', { detail: msg.device }));
        break;
      case 'disconnected':
        this.device = null;
        this.dispatchEvent(new CustomEvent('disconnected'));
        break;
      case 'hello':
        if (msg.device) this.device = msg.device;
        break;
      default:
        break;
    }
  }

  /**
   * @param {{id:string, model:string, channel?:number}} target
   *   channel は RFCOMM のチャネル番号。省略するとバックエンドが SDP から決める。
   */
  async connect(target) {
    this.openEventStream();
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: target.id,
        model: target.model,
        channel: target.channel ?? null,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Connection failed');
    this.device = body.device;
    return this.device;
  }

  async disconnect() {
    await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
    this.device = null;
  }

  async send(bytes) {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Send failed (${res.status})`);
    this.totalWritten += body.written || bytes.length;
    this.dispatchEvent(new CustomEvent('progress', { detail: { written: this.totalWritten } }));
  }

  waitStatus(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this._statusWaiters.push(waiter);
      setTimeout(() => {
        const i = this._statusWaiters.indexOf(waiter);
        if (i !== -1) {
          this._statusWaiters.splice(i, 1);
          reject(new Error('Status response timed out'));
        }
      }, timeoutMs);
    });
  }
}
