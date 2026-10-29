// トランスポートの土台。
//
// 実体は server/rfcomm.js の RfcommTransport (Bluetooth Classic 直結) だけ。
// ここには「受信バイト列を溜めてステータスフレームに切り出す」共通部分を置く。

import { EventEmitter } from 'node:events';
import { extractStatus } from '../app/status.js';

/** TEPRA の機種名 (Bluetooth のデバイス名との照合用) */
const MODEL_HINTS = [
  'SR-R5600P', 'SR-R5600C', 'SR-R5600GS', 'SR-R7900P', 'SR-R2500P',
  'SR5900P', 'SR5900C', 'SR5900GS', 'SR5500P', 'SR-MK1', 'TEPRA',
];

export function looksLikeTepra(name) {
  if (!name) return false;
  const upper = name.toUpperCase();
  return MODEL_HINTS.some((m) => upper.includes(m.toUpperCase()));
}

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * 共通インタフェース。
 * イベント: 'data'(Uint8Array) / 'status'(object) / 'log'({message,kind}) / 'closed'
 */
export class Transport extends EventEmitter {
  constructor() {
    super();
    this.statusLength = 78;
    this.asciiStatus = false;
    this.debugRaw = false;
    this._buffer = new Uint8Array(0);
    this.lastStatus = null;
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this._warnedUnanchored = false;
  }

  log(message, kind = 'info') {
    this.emit('log', { message, kind });
  }

  /** 受信データを溜めてステータスフレームを切り出す */
  _ingest(chunk) {
    this.bytesReceived += chunk.length;
    const merged = new Uint8Array(this._buffer.length + chunk.length);
    merged.set(this._buffer);
    merged.set(chunk, this._buffer.length);
    this._buffer = merged;
    this.emit('data', chunk);
    if (this.debugRaw) {
      this.log(`RX ${chunk.length}B: ${toHex(chunk.subarray(0, 64))}${chunk.length > 64 ? ' …' : ''}`);
    }

    for (;;) {
      // プレフィクスが 0x40 で始まる保証がない機種があるので、
      // 0x40 がどこにも無いときだけ先頭から読む経路も許可する。
      const found = extractStatus(this._buffer, this.statusLength, this.asciiStatus, {
        allowUnanchored: !this.asciiStatus && this.statusLength !== 22,
      });
      if (!found) break;
      if (!found.anchored && !this._warnedUnanchored) {
        this._warnedUnanchored = true;
        this.log(`Status frame did not start with 0x40 (0x${found.frame[0].toString(16)}). `
          + 'Parsing from the start of the buffer.', 'warn');
      }
      this._buffer = this._buffer.subarray(found.consumed).slice();
      this.lastStatus = found.status;
      this.emit('status', found.status);
    }
    if (this._buffer.length > 8192) this._buffer = this._buffer.subarray(this._buffer.length - 1024).slice();
  }
}
