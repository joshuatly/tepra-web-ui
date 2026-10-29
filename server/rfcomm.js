// Bluetooth Classic (RFCOMM/SPP) を OS のシリアルポート越しではなく直接扱うトランスポート。
// 本ツール唯一の通信経路。
//
// 仮想シリアルポート (/dev/cu.*, COM*) を経由しない利点:
//   - stty も O_NONBLOCK の小細工も要らない
//   - RFCOMM チャネルを自分で選べる。SR-R2500P のように SPP 以外のプロファイル
//     (Apple の "Wireless iAP") を同時に出している機種で正しい方に繋げる
//   - 繋がらない / 切れたことがその場でエラーになる
//     (シリアル経路は書き込みが成功したように見えたまま無反応になる)
//
// 経路は OS で分かれる。
//
//   macOS  : server/native/tepra-bt.swift (IOBluetooth) を子プロセスとして使う。
//            IOBluetooth の openRFCOMMChannelSync() は CFRunLoop が回っている
//            メインスレッドからしか成功せず、非メインスレッドからは必ず
//            kIOReturnError (0xE00002BC) を返す。bluetooth-serial-port を含む
//            既存の Node ライブラリは専用 dispatch queue で接続するため
//            macOS では繋がらない。Node のメインスレッドは libuv のループなので
//            アドオンからこの条件を満たすのが難しく、別プロセスに任せている。
//   その他 : bluetooth-serial-port (Linux=BlueZ / Windows=Bluetooth API)。
//
// どちらの経路も「ペアリング済みの端末に RFCOMM で繋いでバイト列を流す」だけの
// 同じインタフェースに揃えてある。

import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transport, looksLikeTepra } from './transport.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = path.join(HERE, 'native', 'tepra-bt.swift');
const HELPER_BINARY = path.join(HERE, 'native', 'build', 'tepra-bt');

const IS_MAC = process.platform === 'darwin';

/** DeviceConnectionBluetooth.DEVICE_CONNECTION_OPEN_INTERVAL と同じ */
const REOPEN_INTERVAL_MS = 500;

/**
 * bluetooth-serial-port のネイティブ側は書き込み長を UInt16 で受けるので
 * 64KiB 以上は壊れる。macOS ヘルパにも同じ刻みで渡しておく。
 */
const WRITE_CHUNK = 4096;

// ---------------------------------------------------------- SDP の見分け ----

/** SerialPortServiceClass。16/32/128bit のどの表記でも拾えるようにする。 */
const SPP_CLASS = /^(0000)?1101(00001000800000805f9b34fb)?$/i;

/**
 * SDP のサービス名から「これは SPP ではない」と分かるもの。
 *
 * SR-R2500P は RFCOMM を 2 本出していて、ch1 が Apple の MFi プロファイル
 * "Wireless iAP"、ch6 が SerialPort (UUID 0x1101)。
 */
const NON_SPP_SERVICE =
  /\biap\b|wireless iap|headset|hands[-\s]?free|handsfree|a2dp|avrcp|audio|obex|ftp|phonebook|message access|sim access|\bpan\b|\bnap\b|network|dial-?up|\bdun\b|\bhid\b|keyboard|mouse/i;

/** 逆に SPP らしいと分かる名前 */
const SPP_SERVICE = /serial|\bspp\b|printer|print/i;

export function normalizeAddress(address) {
  const raw = String(address || '').trim().toLowerCase();
  // macOS の IOBluetooth はハイフン区切り、BlueZ / Windows はコロン区切り
  return IS_MAC ? raw.replace(/:/g, '-') : raw.replace(/-/g, ':');
}

/**
 * SDP のサービス一覧から、SPP として試す価値のあるチャネルを優先順に並べる。
 *
 * macOS ヘルパは getRFCOMMChannelID() の戻り値を見るので channel は信用できるが、
 * bluetooth-serial-port の listPairedDevices() は戻り値を見ずに未初期化の変数を
 * そのまま返すため、RFCOMM を持たないレコード (DeviceID 0x1200 など) がゴミの
 * 番号を報告する。そのため「候補を順に接続してみて通ったものを採る」前提で並べる。
 *
 * @param {{channel?:number,name?:string,classes?:string[]}[]} services
 * @param {number|null} preferred 先頭に置くチャネル (明示指定 / 前回成功したもの)
 */
export function candidateChannels(services = [], preferred = null) {
  const byClass = [];   // サービスクラス UUID が 0x1101 = 確実に SPP
  const byName = [];
  const unnamed = [];
  const rest = [];
  const blocked = new Set();

  for (const s of services) {
    const ch = Number(s?.channel);
    if (!Number.isInteger(ch) || ch < 1 || ch > 30) continue;
    const name = s.name || '';
    const classes = Array.isArray(s.classes) ? s.classes : [];

    if (classes.some((c) => SPP_CLASS.test(c))) byClass.push(ch);
    else if (classes.length) blocked.add(ch);   // 別のサービスだと分かっている
    else if (SPP_SERVICE.test(name)) byName.push(ch);
    else if (NON_SPP_SERVICE.test(name)) blocked.add(ch);
    else if (!name) unnamed.push(ch);           // TEPRA の SPP レコードは名前を持たない
    else rest.push(ch);
  }

  // 1 本の RFCOMM チャネルに 2 つのサービスは載らない。SPP でないと分かっている
  // 番号と同じものが名前なしで出てきたら、それは上記の未初期化バグによる複製。
  const usable = (ch) => !blocked.has(ch) || byClass.includes(ch);

  const ordered = [];
  const queue = [
    preferred,
    ...byClass,
    ...byName.filter(usable),
    // 名前のない候補にはゴミが混ざるので、番号の小さい方から試す
    ...unnamed.filter(usable).sort((a, b) => a - b),
    ...rest.filter(usable),
  ];
  for (const ch of queue) {
    if (Number.isInteger(ch) && ch >= 1 && !ordered.includes(ch)) ordered.push(ch);
  }
  return ordered;
}

// ------------------------------------------------- macOS: ヘルパプロセス ----

let helperBuild = null;

/** ヘルパを (必要なら) ビルドして実行ファイルのパスを返す */
export async function ensureHelper() {
  if (helperBuild) return helperBuild;
  helperBuild = (async () => {
    const [srcStat, binStat] = await Promise.all([
      fsp.stat(HELPER_SOURCE).catch(() => null),
      fsp.stat(HELPER_BINARY).catch(() => null),
    ]);
    if (!srcStat) throw new Error(`${HELPER_SOURCE} is missing`);
    if (binStat && binStat.mtimeMs >= srcStat.mtimeMs) return HELPER_BINARY;

    try {
      await execFileAsync('swiftc', ['--version']);
    } catch {
      throw new Error(
        'swiftc not found, cannot build the Bluetooth helper. '
        + 'Run xcode-select --install in a terminal.',
      );
    }

    await fsp.mkdir(path.dirname(HELPER_BINARY), { recursive: true });
    try {
      await execFileAsync('swiftc', ['-O', HELPER_SOURCE, '-o', HELPER_BINARY]);
    } catch (err) {
      throw new Error(`Failed to build the Bluetooth helper: ${err.stderr || err.message}`);
    }
    return HELPER_BINARY;
  })();
  helperBuild = helperBuild.catch((err) => { helperBuild = null; throw err; });
  return helperBuild;
}

/** ヘルパの list を叩いてペアリング済み端末を得る */
async function helperList() {
  const bin = await ensureHelper();
  const { stdout } = await execFileAsync(bin, ['list'], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout || '[]');
}

/** 子プロセスとの 4 バイト BE 長フレーム */
function frame(bytes) {
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([head, Buffer.from(bytes)]);
}

class HelperBackend {
  constructor(owner) {
    this.owner = owner;
    this.proc = null;
    this._rx = Buffer.alloc(0);
    this._stderr = '';
    this._closing = false;
    this._opened = false;
  }

  async list() {
    return helperList();
  }

  /** @returns {Promise<{mtu:number}>} */
  async connect(address, channel) {
    const bin = await ensureHelper();
    const proc = spawn(bin, ['connect', address, String(channel)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // チャネルを順に試すので、前の試行の状態を持ち越さない
    this.proc = proc;
    this._rx = Buffer.alloc(0);
    this._stderr = '';
    this._closing = false;
    this._opened = false;

    proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    const opened = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      const timer = setTimeout(
        () => finish(reject, new Error('No response from the helper')),
        25000,
      );

      proc.stderr.on('data', (chunk) => {
        this._stderr += chunk.toString('utf8');
        let at;
        while ((at = this._stderr.indexOf('\n')) !== -1) {
          const line = this._stderr.slice(0, at).trim();
          this._stderr = this._stderr.slice(at + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { this.owner.log(`[helper] ${line}`); continue; }
          if (event.event === 'open' && event.ok) {
            clearTimeout(timer);
            this._opened = true;
            finish(resolve, { mtu: event.mtu });
          } else if (event.event === 'error') {
            clearTimeout(timer);
            finish(reject, new Error(event.message || 'Could not open RFCOMM'));
          } else if (event.event === 'writeError') {
            this.owner.log(`Send error (code ${event.code})`, 'err');
          } else if (event.event === 'closed') {
            this.owner.log('The printer closed the connection', 'warn');
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        finish(reject, new Error(`Could not start the helper: ${err.message}`));
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        finish(reject, new Error(`Helper exited (code ${code})`));
        if (this.proc === proc) {
          this.proc = null;
          // 接続できなかった試行の終了を「切断」として上げない
          if (!this._closing && this._opened) this.owner.emit('closed');
        }
      });
    });

    return opened;
  }

  _onStdout(chunk) {
    this._rx = this._rx.length ? Buffer.concat([this._rx, chunk]) : chunk;
    for (;;) {
      if (this._rx.length < 4) return;
      const size = this._rx.readUInt32BE(0);
      if (this._rx.length < 4 + size) return;
      const payload = this._rx.subarray(4, 4 + size);
      this._rx = this._rx.subarray(4 + size);
      this.owner._ingest(new Uint8Array(payload));
    }
  }

  /** stdin パイプの空きを待つ = プリンタまでの送信完了待ちになる */
  writeChunk(chunk, stallTimeoutMs) {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) throw new Error('Not connected to a printer');
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(
          'The printer is not accepting data. '
          + 'Check that it is powered on and not connected to another device.',
        ));
      }, stallTimeoutMs);
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      if (!proc.stdin.write(frame(chunk), (err) => err && done(err))) {
        proc.stdin.once('drain', () => done(null));
      } else {
        done(null);
      }
    });
  }

  get connected() {
    return !!(this.proc && this.proc.stdin.writable);
  }

  async close() {
    this._closing = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    // stdin を閉じるとヘルパが RFCOMM を閉じて終了する
    proc.stdin.end();
    await Promise.race([
      new Promise((r) => proc.once('exit', r)),
      sleep(2000),
    ]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
}

// --------------------------------- Linux / Windows: ネイティブライブラリ ----

let nativeModule;
let nativeError = null;

/** bluetooth-serial-port を読み込む。入っていなければ null。 */
export function loadRfcomm() {
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('bluetooth-serial-port');
  } catch (err) {
    nativeModule = null;
    nativeError = err;
  }
  return nativeModule;
}

class LibraryBackend {
  constructor(owner) {
    this.owner = owner;
    this.sp = null;
    this._closing = false;
  }

  async list() {
    const bt = loadRfcomm();
    if (!bt) return [];
    const sp = new bt.BluetoothSerialPort();
    const paired = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        sp.listPairedDevices((devices) => done(Array.isArray(devices) ? devices : []));
      } catch {
        done([]);
      }
      setTimeout(() => done([]), 15000);
    });
    return paired;
  }

  async connect(address, channel) {
    const bt = loadRfcomm();
    if (!bt) throw new Error(rfcommUnavailableReason());

    const sp = await new Promise((resolve, reject) => {
      const port = new bt.BluetoothSerialPort();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { port.close(); } catch { /* 失敗した接続の後始末 */ }
        reject(err instanceof Error ? err : new Error(String(err || 'Could not connect')));
      };
      const timer = setTimeout(() => fail(new Error('Connection timed out')), 20000);
      port.connect(address, channel, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(port);
      }, (err) => { clearTimeout(timer); fail(err); });
    });

    this.sp = sp;
    this._closing = false;
    sp.on('data', (buf) => this.owner._ingest(new Uint8Array(buf)));
    sp.on('failure', (err) => {
      if (this._closing) return;
      this.owner.log(`Bluetooth receive error: ${err?.message || err}`, 'err');
    });
    sp.on('closed', () => {
      if (this._closing) return;
      this.sp = null;
      this.owner.emit('closed');
    });
    return { mtu: 0 };
  }

  writeChunk(chunk, stallTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.sp || !this.sp.isOpen()) { reject(new Error('Not connected to a printer')); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(
          'The printer is not accepting data. '
          + 'Check that it is powered on and not connected to another device.',
        ));
      }, stallTimeoutMs);
      this.sp.write(Buffer.from(chunk), (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // ライブラリは未接続時に cb.call(err) と呼ぶ (引数なし) ので isOpen() でも見る
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else if (!this.sp || !this.sp.isOpen()) reject(new Error('Connection lost while sending'));
        else resolve();
      });
    });
  }

  get connected() {
    return !!(this.sp && this.sp.isOpen());
  }

  async close() {
    this._closing = true;
    const sp = this.sp;
    this.sp = null;
    if (!sp) return;
    try { sp.close(); } catch { /* 既に閉じている */ }
    sp.removeAllListeners();
  }
}

// ------------------------------------------------------------- 利用可否 ----

/** RFCOMM 経路が使えるか (使えないなら理由を返す) */
export async function rfcommUnavailableReason() {
  if (IS_MAC) {
    try {
      await ensureHelper();
      return null;
    } catch (err) {
      return err.message;
    }
  }
  if (loadRfcomm()) return null;
  const detail = nativeError ? `: ${nativeError.message.split('\n')[0]}` : '';
  return `bluetooth-serial-port is not available${detail}`;
}

export async function rfcommAvailable() {
  return (await rfcommUnavailableReason()) === null;
}

// ------------------------------------------------------------- 本体 ----

export class RfcommTransport extends Transport {
  /**
   * @param {string} address 例 "74-c9-0f-be-9d-e8"。"アドレス@チャネル" でも指定できる
   * @param {{channel?:number|null}} [opts]
   */
  constructor(address, opts = {}) {
    super();
    const [addr, chanPart] = String(address || '').split('@');
    this.address = normalizeAddress(addr);
    this.kind = 'rfcomm';
    this.channel = Number(opts.channel ?? chanPart) || null;
    this.chunkSize = WRITE_CHUNK;
    this.mtu = 0;
    this._backend = IS_MAC ? new HelperBackend(this) : new LibraryBackend(this);
    this._writeChain = Promise.resolve();
  }

  static available() {
    return rfcommAvailable();
  }

  /** ペアリング済みの端末を並べる。RFCOMM は事前ペアリングが前提。 */
  static async list() {
    const backend = IS_MAC ? new HelperBackend({ log() {} }) : new LibraryBackend({ log() {} });
    let paired;
    try {
      paired = await backend.list();
    } catch {
      return [];
    }

    const out = (paired || []).map((d) => {
      const services = Array.isArray(d.services) ? d.services : [];
      const channels = candidateChannels(services);
      return {
        transport: 'rfcomm',
        id: d.address,
        name: d.name || d.address,
        detail: channels.length ? `${d.address} (ch ${channels.join(',')})` : d.address,
        channels,
        services,
        likely: looksLikeTepra(d.name),
      };
    });

    out.sort((a, b) => (b.likely - a.likely) || a.name.localeCompare(b.name));
    return out;
  }

  /** この端末が出している RFCOMM チャネルを SDP から拾う */
  async _discoverChannels() {
    if (this.channel) return [this.channel];

    // 前回通ったチャネルがあればそこから試す
    const remembered = RfcommTransport._lastGoodChannel.get(this.address) || null;

    const devices = await RfcommTransport.list();
    const me = devices.find((d) => normalizeAddress(d.id) === this.address);
    if (me && me.channels.length) return candidateChannels(me.services, remembered);
    if (remembered) return [remembered];
    return [];
  }

  async open() {
    // 閉じた直後に開き直すと RFCOMM を張り直せないことがある
    const since = Date.now() - (RfcommTransport._lastSessionEnd.get(this.address) || 0);
    if (since < REOPEN_INTERVAL_MS) await sleep(REOPEN_INTERVAL_MS - since);

    const reason = await rfcommUnavailableReason();
    if (reason) throw new Error(reason);

    const channels = await this._discoverChannels();
    if (!channels.length) {
      throw new Error(
        `Could not determine the RFCOMM channel for ${this.address}. `
        + 'Re-pair it in the OS Bluetooth settings or specify the channel explicitly.',
      );
    }

    const errors = [];
    let opened = null;
    for (const channel of channels) {
      try {
        opened = await this._backend.connect(this.address, channel);
        this.channel = channel;
        RfcommTransport._lastGoodChannel.set(this.address, channel);
        break;
      } catch (err) {
        errors.push(`ch${channel}: ${err.message}`);
        if (channels.length > 1) this.log(`Could not connect on RFCOMM ch${channel}`, 'warn');
        await this._backend.close().catch(() => {});
        await sleep(300);
      }
    }

    if (!opened) {
      throw new Error(
        `Could not connect to ${this.address} (${errors.join(' / ')}). `
        + 'Check that the printer is powered on and no other device is connected.',
      );
    }

    this.mtu = opened.mtu || 0;
    this.log(`Connected to ${this.address} on RFCOMM ch${this.channel}`
      + `${this.mtu ? ` (MTU ${this.mtu})` : ''}`);
  }

  /**
   * 送信。呼び出しが重ならないよう直列化する。
   * バックエンド側で送信完了を待つので、これがそのままフロー制御になる。
   */
  write(bytes, stallTimeoutMs = 15000) {
    const run = async () => {
      if (!this._backend.connected) throw new Error('Not connected to a printer');
      for (let offset = 0; offset < bytes.length; offset += this.chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + this.chunkSize, bytes.length));
        await this._backend.writeChunk(chunk, stallTimeoutMs);
        this.bytesSent += chunk.length;
      }
      return bytes.length;
    };
    // 直前の送信が失敗しても鎖を切らない
    const next = this._writeChain.then(run, run);
    this._writeChain = next.catch(() => {});
    return next;
  }

  async close() {
    await this._writeChain.catch(() => {});
    await this._backend.close().catch(() => {});
    RfcommTransport._lastSessionEnd.set(this.address, Date.now());
  }
}

/** 同じ端末を閉じた時刻。閉じた直後の再接続を避けるために使う。 */
RfcommTransport._lastSessionEnd = new Map();

/** 前回接続できた RFCOMM チャネル。次回はここから試す。 */
RfcommTransport._lastGoodChannel = new Map();

/** ビルド済みヘルパの場所 (診断用) */
export const HELPER_PATHS = { source: HELPER_SOURCE, binary: HELPER_BINARY, exists: () => fs.existsSync(HELPER_BINARY) };
