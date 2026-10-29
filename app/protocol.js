// TEPRA (King Jim) 印字コマンドの組み立て。
// libTepraPrint.so の CommandFilter::* を JavaScript に書き直したもの。
// フレーム仕様と各コマンドの意味は PROTOCOL.md を参照。

const ESC = 0x1b;
const LBRACE = 0x7b; // '{'
const RBRACE = 0x7d; // '}'

/**
 * 共通フレーム: 1B 7B <len> <cmd> <params...> <chk> 7D
 *   len = cmd 以降 '}' までのバイト数 = params.length + 3
 *   chk = (cmd + Σparams) & 0xFF
 */
export function frame(cmd, params = []) {
  const len = params.length + 3;
  let sum = cmd;
  for (const p of params) sum += p;
  return Uint8Array.from([ESC, LBRACE, len, cmd, ...params, sum & 0xff, RBRACE]);
}

const u16le = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

export const TapeCut = { EACH_LABEL: 0, AFTER_JOB: 1, NONE: 2 };

/**
 * ページ環境コマンドを組み立てられる commandLevel。
 * 2 だけは 'W' + 'O' + 't' が未解析 (該当機種も無い)。
 */
export const SUPPORTED_COMMAND_LEVELS = [1, 3, 4, 5, 6, 7, 8];
export const PrintSpeed = { HIGH: 0, LOW: 1, MIDDLE: 2 };

// ---- 単発コマンド -------------------------------------------------------

/** プリンタリセット (AccessManager.resetPrinter) */
export const cmdReset = () => frame(0x21);

/** ステータス単発要求 (requestAccessForStatus / 第2世代以降) */
export const cmdRequestStatusOnce = () => frame(0x49, [0x00, 0x00]);

/** 印刷中の自動ステータス通知を有効化 (setRequestStatus) */
export const cmdRequestStatusAuto = () => frame(0x49, [0x05, 0x00]);

/** 印刷終了 (OPERATION_SEND_PRINT_END) */
export const cmdPrintEnd = () => frame(0x40);

/** テープ送り (OPERATION_SEND) */
export const cmdTapeFeed = () => frame(0x2b, [0x00]);

/** テープ送り + カット (OPERATION_SEND_AND_CUT) */
export const cmdTapeFeedAndCut = () => frame(0x2b, [0x01]);

/** ページ終了 (フォームフィード) */
export const cmdFormFeed = () => Uint8Array.from([0x0c]);

/** ラスタ 1 行の転送ヘッダ: ESC . 0 0 0 1 nL nH */
export function cmdRasterHeader(widthDots) {
  return Uint8Array.from([0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, widthDots & 0xff, (widthDots >> 8) & 0xff]);
}

// ---- ジョブ環境 ---------------------------------------------------------

/**
 * makeCommand 'C' 分岐が組み立てる 4 バイト値 (LE32)。
 * PROTOCOL.md 2.1 の表と同じ。
 */
export function tapeCutValue(tapeCut, halfCut) {
  let base;
  if (tapeCut === TapeCut.EACH_LABEL) base = halfCut === 1 ? 0x01010200 : 0x01010100;
  else if (tapeCut === TapeCut.AFTER_JOB) base = 0x01010000;
  else if (tapeCut === TapeCut.NONE) base = 0x00000000;
  else base = 0x01000000;

  if (tapeCut === TapeCut.NONE) return base >>> 0;
  if (halfCut === 1) return (base | 2) >>> 0;
  if (halfCut === 0) return (base | 1) >>> 0;
  return base >>> 0;
}

/** 濃度コマンド。density は -5..+5、範囲外は 0 に落ちる (makeCommand 'D')。 */
export function cmdDensity(density) {
  const v = density + 5;
  return frame(0x44, [v >= 0 && v <= 10 ? v : 0]);
}

/** makeCommand 's' の速度値 */
export function printSpeedValue(speed, allowMiddle) {
  if (speed === PrintSpeed.LOW) return 1;
  if (allowMiddle && speed === PrintSpeed.MIDDLE) return 2;
  return 0;
}

/**
 * CommandFilter::makeJobEnvironmentCommand
 * @param {{tapeCut:number, halfCut:number, density:number}} params
 */
export function jobEnvironmentCommand(params) {
  return concat([
    frame(0x40),                                        // '@'  初期化
    frame(0x7b, [0x00, 0x00, 0x53, 0x54]),              // '{'  ジョブ開始 "ST"
    frame(0x43, u32le(tapeCutValue(params.tapeCut, params.halfCut))), // 'C'
    cmdDensity(params.density),                         // 'D'
    frame(0x47),                                        // 'G'
  ]);
}

/**
 * 's' 印字速度。makeCommand の 's' 分岐 (ParameterKeyPrintSpeed) より。
 *   speed == 1 (低速)                 → 1
 *   arg フラグあり && speed == 2 (中速) → 2
 *   それ以外                           → 0
 * arg フラグは commandLevel ごとに固定で、level 3 は 0、level 4/6/7/8 は 1。
 */
export function cmdPrintSpeed(speed, allowMiddle) {
  return frame(0x73, [printSpeedValue(speed, allowMiddle)]);
}

/**
 * 'X' 連続ハーフカット (ParameterKeyHalfCutContinuous)。
 * makeCommand @ 0x3cb18。makeCommand の第 3 引数は使わず、
 * パラメータ表から引いた値が 1 かどうかだけを見る。
 */
export function cmdHalfCutContinuous(on) {
  return frame(0x58, [on ? 1 : 0]);
}

/** 'o' オブジェクト種別 (ParameterKeyObjectType)。commandLevel 4 のみ。 */
export function cmdObjectType(objectType) {
  return frame(0x6f, [objectType & 0xff, 0x00]);
}

/** 'H' 画像処理モード。commandLevel 3/4/7 では固定値 5。 */
export const cmdImageMode = () => frame(0x48, [0x05]);

/**
 * commandLevel ごとの追加コマンド。
 * makePageEnvironmentCommand @ 0x3d858 の分岐をそのまま写したもの。
 * 先頭の 'L' + 'T' 18 バイトは commandLevel 非依存。
 *
 * | level | 追加分                            | 機種 |
 * |---|---|---|
 * | 1 | なし                                  | SR5500P |
 * | 3 | H(5) + s(中速なし) + X                | SR5900P / C / GS |
 * | 4 | H(5) + s(中速あり) + X + y? + o       | SR-R7900P |
 * | 5 | y? のみ                               | SR-R2500P / SR-MK1 / SR-R5600 系 |
 * | 6 | s(中速あり) + X + y?                  | – |
 * | 7 | H(5) + s(中速あり) + X + y?           | – |
 * | 8 | s(中速あり)                           | – |
 *
 * level 2 の 'W' + 'O' + 't' は該当機種が無いため未実装。
 */
function pageEnvironmentTail(level, opts) {
  const { priorityPrint = false, printSpeed = PrintSpeed.HIGH,
    halfCutContinuous = false, objectType = 0, omitHalfCutContinuousOff = false } = opts;
  const speed = (allowMiddle) => cmdPrintSpeed(printSpeed, allowMiddle);
  const priority = () => (priorityPrint ? [frame(0x79)] : []);

  switch (level) {
    case 1: return [];
    case 3: return [cmdImageMode(), speed(false),
      // Captured SR5900P Wi-Fi traffic ends the page header at 's' and has no 'X'
      ...(omitHalfCutContinuousOff && !halfCutContinuous ? [] : [cmdHalfCutContinuous(halfCutContinuous)])];
    case 4: return [cmdImageMode(), speed(true), cmdHalfCutContinuous(halfCutContinuous),
      ...priority(), cmdObjectType(objectType)];
    case 5: return priority();
    case 6: return [speed(true), cmdHalfCutContinuous(halfCutContinuous), ...priority()];
    case 7: return [cmdImageMode(), speed(true), cmdHalfCutContinuous(halfCutContinuous),
      ...priority()];
    case 8: return [speed(true)];
    default: throw new Error(`Page environment command for commandLevel ${level} is not implemented`);
  }
}

/**
 * CommandFilter::makePageEnvironmentCommand。
 * @param {number} pageLengthDots 印字方向のドット数
 * @param {number} marginDots     先頭余白ドット数
 * @param {{commandLevel?:number, priorityPrint?:boolean, printSpeed?:number,
 *          halfCutContinuous?:boolean, objectType?:number}|boolean} [opts]
 *   後方互換のため boolean を渡すと commandLevel 5 の priorityPrint として扱う。
 */
export function pageEnvironmentCommand(pageLengthDots, marginDots, opts = {}) {
  const options = typeof opts === 'boolean' ? { priorityPrint: opts } : opts;
  const level = options.commandLevel ?? 5;
  return concat([
    frame(0x4c, u32le(pageLengthDots)), // 'L' ページ長
    frame(0x54, u16le(marginDots)),     // 'T' 先頭余白
    ...pageEnvironmentTail(level, options),
  ]);
}

// ---- ジョブ全体 ---------------------------------------------------------

/**
 * 1 ページ分のラスタデータを組み立てる。
 * @param {Uint8Array[]} rows 各要素が ceil(widthDots/8) バイトのパック済み行
 * @param {number} widthDots  テープ幅方向のドット数
 */
export function rasterBlock(rows, widthDots) {
  const header = cmdRasterHeader(widthDots);
  const rowBytes = (widthDots + 7) >> 3;
  const out = new Uint8Array(rows.length * (header.length + rowBytes));
  let o = 0;
  for (const row of rows) {
    out.set(header, o); o += header.length;
    out.set(row, o); o += rowBytes;
  }
  return out;
}

/**
 * 印刷ジョブ全体のバイト列を作る (ステータス応答待ちを挟まないオフライン版)。
 * BLE 送信時は sendJob() 側が同じ順序で待ち合わせながら送る。
 */
export function buildJobBytes(pages, opts) {
  const parts = [cmdReset(), cmdRequestStatusAuto(), jobEnvironmentCommand(opts)];
  for (let copy = 0; copy < opts.copies; copy++) {
    for (const page of pages) {
      parts.push(pageEnvironmentCommand(page.lengthDots, page.marginDots, opts));
      parts.push(rasterBlock(page.rows, page.widthDots));
      parts.push(cmdFormFeed());
    }
  }
  parts.push(cmdPrintEnd());
  return concat(parts);
}

/**
 * Job bytes for the TCP 9100 (Wi-Fi / LAN) data channel of SR5900P-class printers.
 *
 * Over the network the printer reports its status on the UDP 9100 control channel,
 * so the reset ('!') and auto-status ('I') frames used on Bluetooth are not sent.
 * The resulting stream is byte-for-byte what the official software sends
 * (see hikalium/sr5900p and takonomura/tepra-web):
 *
 *   @  {ST  C  D  G  |  L  T  H  s  <raster>  FF  |  ...  |  @
 */
export function buildNetworkJobBytes(pages, opts) {
  const pageOpts = { ...opts, omitHalfCutContinuousOff: true };
  const parts = [jobEnvironmentCommand(opts)];
  for (let copy = 0; copy < opts.copies; copy++) {
    for (const page of pages) {
      parts.push(pageEnvironmentCommand(page.lengthDots, page.marginDots, pageOpts));
      parts.push(rasterBlock(page.rows, page.widthDots));
      parts.push(cmdFormFeed());
    }
  }
  parts.push(cmdPrintEnd());
  return concat(parts);
}

export function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function toHex(bytes, bytesPerLine = 16) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += bytesPerLine) {
    const slice = bytes.subarray(i, i + bytesPerLine);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(bytesPerLine * 3 - 1)}  |${ascii}|`);
  }
  return lines.join('\n');
}
