// プリンタのステータス応答フレームの切り出しと解析。
// フロントエンドとバックエンドの両方から使う (Node / ブラウザ共通の ESM)。
//
// 元実装:
//   AccessManager.parseStatusFromLwStatus()            statusLength 8/12/20/24/78 (バイナリ)
//   AccessManagerBLE.parseStatusFromLwStatus()         statusLength 22 (バイナリ)
//   AccessManagerBluetooth.parseStatusFromLwStatus()   第一世代 BT (64 バイトの ASCII)

import { tapeWidthFromStatusCode } from './models.js';

/** ステータス本体の前に付くプレフィクス長 (AccessManagerBLE.PREFIX_LENGTH) */
export const PREFIX_LENGTH = 13;

/** 対応しているバイナリステータス長 */
export const BINARY_STATUS_LENGTHS = [8, 12, 20, 22, 24, 78];

/**
 * 1 フレームの総バイト数。
 *
 * 22 と 78 は本体の後ろに 1 バイト余分が付く。
 *   22 … 13 + 22 + 1 = 36 (AccessManagerBLE が固定長で受信している)
 *   78 … 13 + 78 + 1 = 92 (SR-R2500P 実機の応答。末尾 1 バイトはチェックサムらしい)
 *
 * AccessManagerBluetooth2 は「91 バイト以上たまったらオフセット 13 から読む」
 * という実装なので余りを気にしないが、こちらはストリームから切り出す都合上
 * 実際の長さで消費しないと 1 バイトずつ残って後続のフレームがずれる。
 */
export function frameLength(statusLength) {
  return PREFIX_LENGTH + statusLength + (statusLength === 22 || statusLength === 78 ? 1 : 0);
}

const be16 = (b, i) => (b[i] << 8) + b[i + 1];
const be32 = (b, i) => (((b[i] << 24) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]) >>> 0);

/**
 * ステータス本体 (プレフィクスを除いた部分) を解析する。
 * @param {Uint8Array} b
 * @param {number} statusLength
 */
export function parseStatusBody(b, statusLength) {
  const s = { statusLength, ST: 0, ER: 0, ER2: 0, PP: 0 };

  if (statusLength === 22) {
    // AccessManagerBLE
    Object.assign(s, {
      ST: b[1], ER: b[2], ER2: b[2], EI2: b[4], EJ2: b[5],
      TW: b[6], TR: b[7], TS: b[8], T8S: b[9], T8O: b[10], T8T: b[11],
      PP: be16(b, 12), RB: be32(b, 14), WA: b[18], VER: b[19], RES: be16(b, 20),
    });
  } else if (statusLength >= 8) {
    // AccessManager (8/12/20/24/78 共通の先頭部分)
    Object.assign(s, { ST: b[1], ER: b[2], ER2: b[2], TW: b[3], TR: b[4], EI: b[5] });
    if (statusLength >= 12) {
      Object.assign(s, { TO: b[8], IR: b[9], RR: b[10], EJ: b[11] });
    }
    if (statusLength >= 20) {
      Object.assign(s, {
        PP: be16(b, 12), ER2: b[14], EI2: b[15], EJ2: b[16],
        TC: b[17], RC: b[18], JI: b[19],
      });
    }
    if (statusLength >= 24) {
      Object.assign(s, { TS: b[20], T8S: b[21], T8O: b[22], T8T: b[23] });
    }
    if (statusLength === 78) {
      Object.assign(s, {
        T8B: b[24], RB: be32(b, 25), WA: b[29], PPN: be16(b, 30), TWS: b[32],
        BR: b[33], BTLM: be32(b, 34), BTLI: be32(b, 38), BTUL: be32(b, 42),
        BLT: be16(b, 46), BLC: be16(b, 48), BTR: be32(b, 50), BRR: be32(b, 54),
        BTW: b[58], BTK: be16(b, 59), BPS: b[61], BO: b[62], BPD: b[63],
        BHD: b[64], RES3: b[65],
      });
      const serial = [];
      for (let i = 0; i < 12; i++) serial.push(b[66 + i]);
      s.BSN = serial;
    }
  }

  s.tapeWidthCode = tapeWidthFromStatusCode(s.TW ?? 0);
  return s;
}

/** AccessManagerBluetooth.parseStatusCode(): "ST:xx" 形式から 16 進 2 桁を読む */
function parseAsciiCode(text, key) {
  const at = text.lastIndexOf(key);
  if (at === -1) return 0;
  const v = parseInt(text.substr(at + 3, 2), 16);
  return Number.isNaN(v) ? 0 : v;
}

/** 第一世代 Bluetooth の 64 バイト ASCII ステータス */
export function parseAsciiStatus(frame) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(frame.subarray(0, 63));
  const s = { statusLength: 8, PP: 0 };
  for (const key of ['ST', 'ER', 'TW', 'TR', 'EI', 'TO', 'IR', 'RR', 'EJ', 'WR', 'RV', 'CT', 'OP']) {
    s[key] = parseAsciiCode(text, key);
  }
  s.ER2 = s.ER;
  s.tapeWidthCode = tapeWidthFromStatusCode(s.TW);
  return s;
}

/**
 * 受信バッファからステータスフレームを 1 つ取り出す。
 * AccessManager* と同じく「必要バイト数を後ろに残す最後の 0x40」を先頭とみなす。
 *
 * BLE (22) と第一世代 Bluetooth は先頭が 0x40 であることを実装が確認している。
 * 一方 AccessManagerBluetooth2 (78) は 0x40 を見ずに「91 バイト以上たまったら
 * オフセット 13 から読む」だけなので、プレフィクスが 0x40 で始まる保証がない。
 * そのため anchored な探索に失敗したときはバッファ先頭から読む経路を用意する。
 *
 * @param {Uint8Array} buf
 * @param {number} statusLength
 * @param {boolean} ascii 第一世代 Bluetooth の ASCII 形式か
 * @param {{allowUnanchored?:boolean}} [opts]
 * @returns {{status:object, frame:Uint8Array, consumed:number, anchored:boolean}|null}
 */
export function extractStatus(buf, statusLength, ascii = false, opts = {}) {
  const size = ascii ? 64 : frameLength(statusLength);
  for (let i = buf.length - size; i >= 0; i--) {
    if (buf[i] !== 0x40) continue;
    const frame = buf.subarray(i, i + size);
    if (ascii && frame[63] !== 0xff) continue;
    const status = ascii
      ? parseAsciiStatus(frame)
      : parseStatusBody(frame.subarray(PREFIX_LENGTH), statusLength);
    return { status, frame, consumed: i + size, anchored: true };
  }

  // 0x40 がどこかに居るなら、それはこれから頭になるフレームの可能性が高い。
  // 先頭から読んでしまうと 1 バイトずれたまま解析することになるので、
  // 「0x40 がバッファのどこにも無い」ときだけ先頭からの解析を許す。
  if (!ascii && opts.allowUnanchored && buf.length >= size && !buf.includes(0x40)) {
    const frame = buf.subarray(0, size);
    return {
      status: parseStatusBody(frame.subarray(PREFIX_LENGTH), statusLength),
      frame,
      consumed: size,
      anchored: false,
    };
  }
  return null;
}
