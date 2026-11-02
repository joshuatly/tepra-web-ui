// Wi-Fi / LAN transport for SR5900P-class printers (TEPRA PRO SR5900P / SR5900C / SR5900GS).
//
// These printers expose two channels on port 9100:
//
//   UDP 9100  control: status, lock ("start"), unlock ("stop"), data-stream notify.
//             Every packet starts with a 32-byte "TPRT" header (responses use "tprt").
//   TCP 9100  data: the raw print job (same command stream the SDK builds, see
//             buildNetworkJobBytes() in app/protocol.js).
//
// The sequence below follows what was captured from the official software and
// verified on real hardware by hikalium/sr5900p, uzuna/sr5900p and takonomura/tepra-web:
//
//   1. UDP status          → must be idle with no error
//   2. UDP lock   (0x0002) → body 02 00 00   (on a timeout, unlock anyway: only the reply
//                                             may have been lost)
//   3. pause, TCP connect :9100, pause
//   4. UDP notify (0x0101), then (0x0100) → body 10, pause
//   5. TCP write job bytes (the connection stays open)
//   6. UDP status poll until the printer stops printing
//   7. UDP unlock (0x0003) → body 03 00 00   (always, even on failure)
//   8. TCP close: after the unlock, so it never closes inside the print session

import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { parseStatusBody, deviceErrorCode } from '../app/status.js';
import { DEVICE_ERROR, PRINTER_STATUS, tapeWidthLabel } from '../app/models.js';

export const DEFAULT_PORT = 9100;
export const HEADER_SIZE = 32;
/** statusLength of the SR5900 family (AccessManager, 20-byte binary status) */
export const NET_STATUS_LENGTH = 20;

export const Cmd = {
  STATUS: 0x0001,
  LOCK: 0x0002,
  UNLOCK: 0x0003,
  DATA_STREAM: 0x0100,
  DATA_NOTIFY: 0x0101,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHex = (bytes) => Buffer.from(bytes).toString('hex').replace(/(..)(?!$)/g, '$1 ');

/**
 * Pause between the steps of a print session (before and after the TCP connect, and
 * between the data-stream notify and the job bytes). uzuna/sr5900p uses 500 ms and notes
 * that the printer has only been used with these pauses.
 */
export const STEP_PAUSE_MS = 500;

/** 32-byte request header: "TPRT" 0 1 0x20 cmd len ip token (all BE32) */
export function makePacket(cmd, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf.write('TPRT', 0, 'ascii');
  buf.writeUInt32BE(0x00, 4);
  buf.writeUInt32BE(0x01, 8);
  buf.writeUInt32BE(0x20, 12);
  buf.writeUInt32BE(cmd >>> 0, 16);
  buf.writeUInt32BE(payload.length, 20);
  // 24..31: ip address / token, zero in requests
  Buffer.from(payload).copy(buf, HEADER_SIZE);
  return buf;
}

/** Splits a UDP response into header and body. Returns null if it is not a TPRT packet. */
export function parsePacket(msg) {
  if (!msg || msg.length < HEADER_SIZE) return null;
  const sig = msg.subarray(0, 4).toString('ascii');
  if (sig.toUpperCase() !== 'TPRT') return null;
  return {
    header: msg.subarray(0, HEADER_SIZE),
    cmd: msg.readUInt32BE(16),
    body: msg.subarray(HEADER_SIZE),
  };
}

/** Parses the 20-byte network status body into the same shape the Bluetooth path uses. */
export function parseNetworkStatus(body) {
  if (body.length !== NET_STATUS_LENGTH) {
    throw new Error(`Unexpected status length ${body.length} (expected ${NET_STATUS_LENGTH}): ${toHex(body)}`);
  }
  const s = parseStatusBody(new Uint8Array(body), NET_STATUS_LENGTH);
  // The network status has no receive-buffer field
  s.RB = s.RB ?? 0;
  s.raw = toHex(body);
  return s;
}

/** Printer states in which a job is still in progress */
const BUSY_STATES = new Set([1, 2, 3, 6, 16, 17, 18]);

export function isBusy(status) {
  return BUSY_STATES.has(status.ST);
}

export function describeStatus(s) {
  const state = PRINTER_STATUS[s.ST] ?? `state 0x${s.ST.toString(16)}`;
  const code = deviceErrorCode(s);
  const err = code ? `, error: ${DEVICE_ERROR[code] ?? `code ${code}`}` : '';
  return `${state}, tape ${tapeWidthLabel(s.tapeWidthCode)}${err}`;
}

/** Error for a request the printer did not answer; `code` is 'ETIMEDOUT'. */
export class UdpTimeout extends Error {
  constructor(message) { super(message); this.name = 'UdpTimeout'; this.code = 'ETIMEDOUT'; }
}

/** Resolves a host name to the IPv4 address replies will come from. */
async function resolveIPv4(host) {
  if (net.isIPv4(host)) return host;
  try {
    return (await dns.promises.lookup(host, { family: 4 })).address;
  } catch (err) {
    throw new Error(`Cannot resolve printer address ${host}: ${err.message}`);
  }
}

/**
 * Sends one UDP request and waits for the matching response.
 * A fresh socket per request keeps late replies from a previous request from
 * being mistaken for this one. A reply only counts when it comes from the printer's
 * address and echoes the request's command in its header (bytes 16..19); anything
 * else (a stray packet from another host, a late reply to another command) is skipped.
 */
export async function udpRequest(host, port, cmd, { timeoutMs = 1500, retries = 2 } = {}) {
  const packet = makePacket(cmd);
  const address = await resolveIPv4(host);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let attempt = 0;
    let timer = null;
    let done = false;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      fn(value);
    };

    const send = () => {
      attempt++;
      sock.send(packet, port, address, (err) => {
        if (err) finish(reject, new Error(`UDP send to ${host}:${port} failed: ${err.message}`));
      });
      timer = setTimeout(() => {
        if (attempt <= retries) send();
        else finish(reject, new UdpTimeout(`No UDP response from ${host}:${port} (timed out)`));
      }, timeoutMs);
    };

    sock.on('error', (err) => finish(reject, new Error(`UDP error: ${err.message}`)));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== address) return;
      const p = parsePacket(msg);
      if (!p || p.cmd !== cmd) return;
      finish(resolve, p);
    });
    sock.bind(0, send);
  });
}

/** IPv4 broadcast addresses of the host's interfaces, plus the limited broadcast. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 0xff))).join('.'));
    }
  }
  return [...out];
}

/**
 * Broadcasts a status request and collects every printer that answers.
 * Only works when the server shares the printer's L2 network
 * (in Docker that means `network_mode: host`).
 */
export function discover({ port = DEFAULT_PORT, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const packet = makePacket(Cmd.STATUS);
    const finish = () => {
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      const p = parsePacket(msg);
      if (!p || found.has(rinfo.address)) return;
      let status = null;
      try { status = parseNetworkStatus(p.body); } catch { /* not an SR5900-style reply */ }
      found.set(rinfo.address, {
        host: rinfo.address,
        port: rinfo.port,
        status,
        summary: status ? describeStatus(status) : `reply ${p.body.length} B`,
      });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      for (const addr of broadcastAddresses()) {
        sock.send(packet, port, addr, () => {});
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

export class PrintCancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'PrintCancelled'; }
}

/**
 * One network printer. Emits 'log' ({message, kind}) and 'progress'
 * ({phase, done, total}) while printing.
 */
export class NetworkPrinter extends EventEmitter {
  /**
   * @param {string} host
   * @param {{port?:number, stepPauseMs?:number, timeoutMs?:number, retries?:number}} [opts]
   *   timeoutMs / retries apply to each UDP request (see udpRequest)
   */
  constructor(host, { port = DEFAULT_PORT, stepPauseMs = STEP_PAUSE_MS, timeoutMs, retries } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.stepPauseMs = stepPauseMs;
    this.requestOpts = { ...(timeoutMs !== undefined && { timeoutMs }), ...(retries !== undefined && { retries }) };
    this.busy = false;
    this._cancel = false;
    this._socket = null;
  }

  get address() { return `${this.host}:${this.port}`; }

  log(message, kind = 'info') {
    this.emit('log', { message, kind });
  }

  async request(cmd, opts) {
    return udpRequest(this.host, this.port, cmd, { ...this.requestOpts, ...opts });
  }

  async status() {
    const { body } = await this.request(Cmd.STATUS);
    return parseNetworkStatus(body);
  }

  cancel() {
    if (!this.busy) return false;
    this._cancel = true;
    if (this._socket) this._socket.destroy(new PrintCancelled());
    return true;
  }

  _checkCancel() {
    if (this._cancel) throw new PrintCancelled();
  }

  _checkError(s) {
    const code = deviceErrorCode(s);
    if (code !== 0) {
      throw new Error(`Printer error: ${DEVICE_ERROR[code] ?? `code ${code}`}`);
    }
  }

  /**
   * Runs a whole print job.
   * @param {Uint8Array} bytes  output of buildNetworkJobBytes()
   * @param {{pages?:number, tapeCode?:number}} [opts]
   *   pages    number of labels in the job (used to detect completion)
   *   tapeCode tape width code the job was rendered for; refuses to print on a mismatch
   */
  async print(bytes, { pages = 1, tapeCode = null } = {}) {
    if (this.busy) throw new Error('Another job is already printing on this printer');
    this.busy = true;
    this._cancel = false;
    const progress = (phase, done = 0, total = bytes.length) => this.emit('progress', { phase, done, total });

    try {
      progress('Checking printer status');
      const first = await this.status();
      this.log(`Printer status: ${describeStatus(first)}`);
      this._checkError(first);
      if (isBusy(first)) throw new Error(`Printer is busy (${PRINTER_STATUS[first.ST] ?? first.ST})`);
      if (first.tapeWidthCode <= 0) throw new Error('No tape cartridge detected');
      if (tapeCode && first.tapeWidthCode !== tapeCode) {
        throw new Error(`Loaded tape is ${tapeWidthLabel(first.tapeWidthCode)} but the label was laid out for `
          + `${tapeWidthLabel(tapeCode)}. Pick the matching tape width and try again.`);
      }

      this._checkCancel();
      const lock = await this._lock();
      if (!(lock.body.length >= 1 && lock.body[0] === 0x02 && (lock.body[1] ?? 0) === 0)) {
        throw new Error(`Printer refused the print session (reply ${toHex(lock.body)}). `
          + 'Is another app (e.g. TEPRA SPC / the phone app) using it?');
      }

      try {
        await this._sendAndWait(bytes, pages, progress);
      } finally {
        await this._unlock();
        // closed only now, so the data connection never closes inside the print session
        await this._closeData();
      }
    } finally {
      this.busy = false;
      this._cancel = false;
      this._socket = null;
    }
  }

  /**
   * Opens the print session. When the request times out the printer may still have
   * taken the lock with only its reply lost, so an unlock is sent before giving up;
   * otherwise the printer would stay locked for every later job.
   */
  async _lock() {
    try {
      return await this.request(Cmd.LOCK);
    } catch (err) {
      if (err.code === 'ETIMEDOUT') {
        this.log('No reply to the print-session request; releasing it in case it arrived', 'warn');
        await this._unlock();
      }
      throw err;
    }
  }

  async _unlock() {
    try {
      const unlock = await this.request(Cmd.UNLOCK);
      if (unlock.body[0] !== 0x03) this.log(`Unexpected unlock reply: ${toHex(unlock.body)}`, 'warn');
    } catch (err) {
      this.log(`Unlock failed: ${err.message}`, 'warn');
    }
  }

  async _closeData() {
    const sock = this._socket;
    if (!sock || sock.destroyed) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { sock.destroy(); resolve(); }, 3000);
      sock.end(() => { clearTimeout(timer); resolve(); });
    });
  }

  async _sendAndWait(bytes, pages, progress) {
    progress('Opening data connection');
    await sleep(this.stepPauseMs);
    const sock = await this._connectTcp();
    this._socket = sock;
    // Status bytes may also arrive on the data channel; they are informational only
    sock.on('data', () => {});
    // The connection stays open while the printer prints; a reset from the printer then
    // must not crash the server (write errors are reported by _write)
    sock.on('error', (err) => {
      if (!this._cancel) this.log(`Data connection: ${err.message}`, 'warn');
    });

    await sleep(this.stepPauseMs);
    this._checkCancel();
    await this.request(Cmd.DATA_NOTIFY);
    const stream = await this.request(Cmd.DATA_STREAM);
    if (stream.body[0] !== 0x10) this.log(`Data-stream reply was ${toHex(stream.body)} (usually 10)`, 'warn');
    await sleep(this.stepPauseMs);

    this._checkCancel();
    await this._write(sock, bytes, progress);
    progress('Data sent, printing', bytes.length);
    this.log(`Sent ${bytes.length.toLocaleString()} bytes to ${this.address}`);

    await this._waitForCompletion(pages, progress, bytes.length);
  }

  _connectTcp(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`TCP connect to ${this.address} timed out`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`TCP connect to ${this.address} failed: ${err.message}`));
      });
    });
  }

  /** Writes in chunks, honouring back-pressure, so progress is meaningful. */
  async _write(sock, bytes, progress) {
    const CHUNK = 16 * 1024;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let failure = null;
    const onError = (err) => { failure = err; };
    sock.on('error', onError);
    try {
      for (let off = 0; off < buf.length; off += CHUNK) {
        if (failure) throw failure;
        this._checkCancel();
        const ok = sock.write(buf.subarray(off, off + CHUNK));
        if (!ok) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Printer stopped accepting data (write timed out)')), 30000);
            sock.once('drain', () => { clearTimeout(timer); resolve(); });
            sock.once('close', () => { clearTimeout(timer); reject(failure || new Error('Data connection closed')); });
          });
        }
        progress('Sending data', Math.min(off + CHUNK, buf.length));
      }
      if (failure) throw failure;
    } catch (err) {
      if (this._cancel) throw new PrintCancelled();
      throw err;
    } finally {
      sock.off('error', onError);
    }
  }

  /**
   * Polls until the printer has finished. The printer may still be digesting the
   * job right after the TCP close, so "idle" only counts once it has been busy,
   * or once the printed-page counter shows the whole job, or after a grace period.
   */
  async _waitForCompletion(pages, progress, total) {
    const deadline = Date.now() + 60000 + pages * 20000;
    const graceUntil = Date.now() + 8000;
    let sawBusy = false;
    let lastState = -1;

    await sleep(500);
    for (;;) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the printer to finish');
      let s;
      try {
        s = await this.status();
      } catch (err) {
        this.log(`Status poll failed: ${err.message}`, 'warn');
        await sleep(1000);
        continue;
      }
      this.emit('status', s);
      if (s.ST !== lastState) {
        lastState = s.ST;
        this.log(`Printer: ${describeStatus(s)}`);
      }
      this._checkError(s);
      if (isBusy(s)) {
        sawBusy = true;
        progress(`Printing (${s.PP}/${pages})`, total);
      } else if (sawBusy || s.PP >= pages || Date.now() > graceUntil) {
        progress('Done', total);
        return s;
      }
      if (this._cancel) {
        this.log('Cancel requested; the printer finishes the label it is on', 'warn');
        throw new PrintCancelled();
      }
      await sleep(400);
    }
  }
}
