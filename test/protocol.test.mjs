// APK から読み取った既知のバイト列と、protocol.js の出力を突き合わせる。
// 実行: node test/protocol.test.mjs

import assert from 'node:assert/strict';
import {
  frame, cmdReset, cmdRequestStatusOnce, cmdRequestStatusAuto, cmdPrintEnd,
  cmdTapeFeed, cmdTapeFeedAndCut, cmdRasterHeader, cmdDensity,
  jobEnvironmentCommand, pageEnvironmentCommand, tapeCutValue, TapeCut, buildJobBytes,
  cmdPrintSpeed, cmdHalfCutContinuous, cmdObjectType, cmdImageMode, PrintSpeed,
  SUPPORTED_COMMAND_LEVELS,
} from '../app/protocol.js';
import {
  JOB_FORMAT, normalizeDesign, createItem, itemLabel, serializeJob, parseJob,
} from '../app/joblist.js';
import { toRasterRows, THRESHOLD, contentMarginDots, mmToDots } from '../app/raster.js';
import { printableDots, tapeWidthFromStatusCode, findPrinter } from '../app/models.js';
import { extractStatus, frameLength, parseAsciiStatus } from '../app/status.js';

let passed = 0;
function check(name, actual, expected) {
  const a = Array.from(actual);
  const e = Array.from(expected);
  try {
    assert.deepEqual(a, e);
    passed++;
  } catch {
    const hex = (x) => x.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.error(`FAIL ${name}\n  expected: ${hex(e)}\n  actual:   ${hex(a)}`);
    process.exitCode = 1;
  }
}

function checkEq(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

// ---- PrintController / AccessManager* の定数 -----------------------------

// PrintController.OPERATION_SEND_PRINT_END
check('印刷終了', cmdPrintEnd(), [0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d]);
// PrintController.OPERATION_SEND
check('テープ送り', cmdTapeFeed(), [0x1b, 0x7b, 0x04, 0x2b, 0x00, 0x2b, 0x7d]);
// PrintController.OPERATION_SEND_AND_CUT
check('送り+カット', cmdTapeFeedAndCut(), [0x1b, 0x7b, 0x04, 0x2b, 0x01, 0x2c, 0x7d]);
// AccessManagerBluetooth.resetPrinter
check('リセット', cmdReset(), [0x1b, 0x7b, 0x03, 0x21, 0x21, 0x7d]);
// AccessManagerBluetooth2.requestAccessForStatus
check('ステータス単発', cmdRequestStatusOnce(), [0x1b, 0x7b, 0x05, 0x49, 0x00, 0x00, 0x49, 0x7d]);
// AccessManagerBluetooth2.setRequestStatus
check('ステータス自動', cmdRequestStatusAuto(), [0x1b, 0x7b, 0x05, 0x49, 0x05, 0x00, 0x4e, 0x7d]);
// PrintController.makeRasterCommand(384)
check('ラスタヘッダ', cmdRasterHeader(384), [0x1b, 0x2e, 0x00, 0x00, 0x00, 0x01, 0x80, 0x01]);
// AccessManagerBluetooth2.getBatteryType の 1B 7B 04 55 01 56 7D
check('汎用フレーム(U,1)', frame(0x55, [0x01]), [0x1b, 0x7b, 0x04, 0x55, 0x01, 0x56, 0x7d]);

// ---- makeJobEnvironmentCommand ------------------------------------------

// libTepraPrint.so 0x1b550 の固定 16 バイト + C + D + 0x1b6d8 の 6 バイト
const job = jobEnvironmentCommand({ tapeCut: TapeCut.EACH_LABEL, halfCut: 0, density: 0 });
check('ジョブ環境 先頭16B', job.subarray(0, 16), [
  0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d,
  0x1b, 0x7b, 0x07, 0x7b, 0x00, 0x00, 0x53, 0x54, 0x22, 0x7d,
]);
check('ジョブ環境 Cコマンド', job.subarray(16, 26), [0x1b, 0x7b, 0x07, 0x43, 0x01, 0x01, 0x01, 0x01, 0x47, 0x7d]);
check('ジョブ環境 Dコマンド', job.subarray(26, 33), [0x1b, 0x7b, 0x04, 0x44, 0x05, 0x49, 0x7d]);
check('ジョブ環境 Gコマンド', job.subarray(33), [0x1b, 0x7b, 0x03, 0x47, 0x47, 0x7d]);
checkEq('ジョブ環境の総バイト数', job.length, 39);

// makeCommand 'C' の値表 (PROTOCOL.md 2.1)
checkEq('C: 毎ラベル/ハーフなし', tapeCutValue(0, 0), 0x01010101);
checkEq('C: 毎ラベル/ハーフあり', tapeCutValue(0, 1), 0x01010202);
checkEq('C: ジョブ後/ハーフなし', tapeCutValue(1, 0), 0x01010001);
checkEq('C: ジョブ後/ハーフあり', tapeCutValue(1, 1), 0x01010002);
checkEq('C: カットなし', tapeCutValue(2, 0), 0x00000000);

// makeCommand 'D': density + 5、範囲外は 0
check('濃度 0', cmdDensity(0), [0x1b, 0x7b, 0x04, 0x44, 0x05, 0x49, 0x7d]);
check('濃度 -5', cmdDensity(-5), [0x1b, 0x7b, 0x04, 0x44, 0x00, 0x44, 0x7d]);
check('濃度 +5', cmdDensity(5), [0x1b, 0x7b, 0x04, 0x44, 0x0a, 0x4e, 0x7d]);
check('濃度 範囲外', cmdDensity(9), [0x1b, 0x7b, 0x04, 0x44, 0x00, 0x44, 0x7d]);

// ---- makePageEnvironmentCommand (commandLevel 5) -------------------------

const page = pageEnvironmentCommand(0x1234, 7, false);
checkEq('ページ環境は18バイト', page.length, 18);
check('ページ環境 Lコマンド', page.subarray(0, 10),
  [0x1b, 0x7b, 0x07, 0x4c, 0x34, 0x12, 0x00, 0x00, (0x4c + 0x34 + 0x12) & 0xff, 0x7d]);
check('ページ環境 Tコマンド', page.subarray(10),
  [0x1b, 0x7b, 0x05, 0x54, 0x07, 0x00, 0x5b, 0x7d]);
check('ページ環境 優先印字あり', pageEnvironmentCommand(1, 0, true).subarray(18),
  [0x1b, 0x7b, 0x03, 0x79, 0x79, 0x7d]);

// ---- bitmapToRaster ------------------------------------------------------

// 幅(=ラベル長) 2 / 高さ(=テープ幅) 8 のパターン。
// テープ幅方向は反転するので、y=7 の画素がビット7 (MSB) に来る。
{
  const width = 2, height = 8;
  const gray = new Uint8ClampedArray(width * height).fill(255);
  gray[7 * width + 0] = 0;   // x=0, y=7 → 行0 の bit7
  gray[0 * width + 1] = 0;   // x=1, y=0 → 行1 の bit0
  const { rows, widthDots, lengthDots } = toRasterRows({ width, height, gray });
  checkEq('ラスタ行数', lengthDots, 2);
  checkEq('ラスタ幅', widthDots, 8);
  check('ラスタ 行0', rows[0], [0b10000000]);
  check('ラスタ 行1', rows[1], [0b00000001]);

  const flipped = toRasterRows({ width, height, gray }, { flip: true });
  check('ラスタ 反転 行0', flipped.rows[0], [0b00000001]);
}

// しきい値は 0x8C 未満が黒
{
  const gray = Uint8ClampedArray.from([THRESHOLD - 1, THRESHOLD]);
  const { rows } = toRasterRows({ width: 1, height: 2, gray });
  check('しきい値 139/140', rows[0], [0b01000000]); // y=1(=140) は白, y=0(=139) が bit6
}

// ---- 機種テーブル --------------------------------------------------------

checkEq('SR-R5600P 12mm', printableDots(4, 180, 18), 72);
checkEq('SR-MK1 24mm 例外', printableDots(6, 360, 7), 256);
checkEq('SR5900P 36mm', printableDots(7, 360, 4), 384);
checkEq('SR-R7900P 18mm (300dpi)', printableDots(5, 300, 6), 180);
checkEq('TWコード 0x03 → 12mm', tapeWidthFromStatusCode(0x03), 4);
checkEq('TWコード 0x5b → 4mm', tapeWidthFromStatusCode(0x5b), 1);
checkEq('TWコード 0x00 → なし', tapeWidthFromStatusCode(0x00), 0);
checkEq('SR-R5600P はレベル5', findPrinter('SR-R5600P').commandLevel, 5);

// ---- 余白計算 ------------------------------------------------------------

checkEq('1mm@180dpi', mmToDots(1, 180), 7);
checkEq('余白はラベル長で頭打ち', contentMarginDots(100, 180, 20), 20);

// ---- ステータス解析 ------------------------------------------------------

{
  const f = new Uint8Array(36);
  f[0] = 0x40;
  const b = 13;
  f[b + 1] = 0x00;  // ST = Idle
  f[b + 2] = 0x00;  // ER
  f[b + 6] = 0x53;  // TW = 12mm
  f[b + 7] = 0x01;  // TR
  f[b + 12] = 0x00; f[b + 13] = 0x03;  // PP = 3
  f[b + 14] = 0x00; f[b + 15] = 0x00; f[b + 16] = 0x10; f[b + 17] = 0x00; // RB = 4096
  const s = extractStatus(f, 22).status;
  checkEq('ステータス ST', s.ST, 0);
  checkEq('ステータス テープ幅コード', s.tapeWidthCode, 4);
  checkEq('ステータス PP', s.PP, 3);
  checkEq('ステータス RB', s.RB, 4096);
}

// ---- ステータス長ごとのフレーム切り出し ----------------------------------

checkEq('BLE(22) のフレーム長', frameLength(22), 36);
checkEq('SR-R2500P(78) のフレーム長', frameLength(78), 92); // 実機の応答 = 13 + 78 + 1
checkEq('SR5900P(20) のフレーム長', frameLength(20), 33);

// ゴミの後ろに 78 バイト版のフレームが続くケース
{
  const noise = Uint8Array.from([0x00, 0x40, 0x01, 0x02]); // 途中の 0x40 に釣られないこと
  const frame = new Uint8Array(92);
  frame[0] = 0x40;
  const b = 13;
  frame[b + 1] = 0x02;   // ST = Printing
  frame[b + 2] = 0x21;   // ER = カバーオープン
  frame[b + 3] = 0x53;   // TW = 12mm
  frame[b + 12] = 0x00; frame[b + 13] = 0x05;              // PP = 5
  frame[b + 30] = 0x00; frame[b + 31] = 0x02;              // PPN = 2
  frame[b + 58] = 0x04;                                     // BTW
  const buf = new Uint8Array(noise.length + frame.length);
  buf.set(noise); buf.set(frame, noise.length);

  const found = extractStatus(buf, 78);
  checkEq('78: フレームを検出', !!found, true);
  checkEq('78: ST', found.status.ST, 2);
  checkEq('78: ER', found.status.ER, 0x21);
  checkEq('78: テープ幅コード', found.status.tapeWidthCode, 4);
  checkEq('78: PP', found.status.PP, 5);
  checkEq('78: PPN', found.status.PPN, 2);
  checkEq('78: BSN は12バイト', found.status.BSN.length, 12);
  checkEq('78: 消費バイト数', found.consumed, buf.length);
}

// フレームに満たなければ null
checkEq('78: 未達なら null', extractStatus(new Uint8Array(91), 78), null);

// 実機 (SR-R2500P) の 92 バイト応答をそのまま消費できること。
// 1 バイトでも残すと次のフレームがずれる。
{
  const one = new Uint8Array(92);
  one[0] = 0x40;
  one[13 + 1] = 0x00;   // ST = Idle
  one[13 + 3] = 0x03;   // TW = 12mm
  one[91] = 0x8c;       // 末尾の余分な 1 バイト
  const two = new Uint8Array(184);
  two.set(one); two.set(one, 92);

  const first = extractStatus(two, 78, false, { allowUnanchored: true });
  checkEq('78: 実機フレームを検出', !!first, true);
  checkEq('78: 実機フレームを 92 バイト消費', first.consumed, 184);

  const single = extractStatus(one, 78, false, { allowUnanchored: true });
  checkEq('78: 単体でも 92 バイト消費', single.consumed, 92);
  checkEq('78: 実機のテープ幅コード', single.status.tapeWidthCode, 4);
}

// 先頭にゴミが 1 バイト残っている状態で、0x40 を無視して先頭から読まないこと
{
  const buf = new Uint8Array(92);
  buf[0] = 0x8c;        // 前のフレームの余り
  buf[1] = 0x40;        // ここから次のフレームが始まる (まだ 91 バイトしかない)
  checkEq('78: ずれたまま解析しない', extractStatus(buf, 78, false, { allowUnanchored: true }), null);
}

// statusLength 22 のフレーム (BLE 機種。接続経路は持たないが解析は共通)
{
  const frame = new Uint8Array(36);
  frame[0] = 0x40;
  frame[13 + 1] = 0x05;
  frame[13 + 6] = 0x0b;  // 4mm
  const s = extractStatus(frame, 22).status;
  checkEq('22: ST', s.ST, 5);
  checkEq('22: 4mm と判定', s.tapeWidthCode, 1);
  checkEq('22: 36 バイト消費', extractStatus(frame, 22).consumed, 36);
}

// 第一世代 Bluetooth の ASCII ステータス
{
  const text = '@BDC ST\r\nST:02;ER:00;TW:03;TR:01;\r\n';
  const frame = new Uint8Array(64);
  for (let i = 0; i < text.length; i++) frame[i] = text.charCodeAt(i);
  frame[63] = 0xff;
  const s = parseAsciiStatus(frame);
  checkEq('ASCII: ST', s.ST, 2);
  checkEq('ASCII: TW', s.TW, 3);
  checkEq('ASCII: テープ幅コード', s.tapeWidthCode, 4); // TW 0x03 → 12mm
  const found = extractStatus(frame, 8, true);
  checkEq('ASCII: 切り出せる', found !== null && found.status.ST === 2, true);
}

// ---- commandLevel ごとのページ環境コマンド --------------------------------
// makePageEnvironmentCommand @ 0x3d858 の分岐を逆アセンブルして確認したもの。

// 'X' 連続ハーフカット (makeCommand @ 0x3cb18)
check('X: OFF', cmdHalfCutContinuous(false), [0x1b, 0x7b, 0x04, 0x58, 0x00, 0x58, 0x7d]);
check('X: ON', cmdHalfCutContinuous(true), [0x1b, 0x7b, 0x04, 0x58, 0x01, 0x59, 0x7d]);

// 's' 印字速度。中速 (2) は arg フラグがある level でのみ出る
check('s: 高速', cmdPrintSpeed(PrintSpeed.HIGH, true), [0x1b, 0x7b, 0x04, 0x73, 0x00, 0x73, 0x7d]);
check('s: 低速', cmdPrintSpeed(PrintSpeed.LOW, true), [0x1b, 0x7b, 0x04, 0x73, 0x01, 0x74, 0x7d]);
check('s: 中速 (許可あり)', cmdPrintSpeed(PrintSpeed.MIDDLE, true), [0x1b, 0x7b, 0x04, 0x73, 0x02, 0x75, 0x7d]);
check('s: 中速 (許可なしは 0 に落ちる)', cmdPrintSpeed(PrintSpeed.MIDDLE, false),
  [0x1b, 0x7b, 0x04, 0x73, 0x00, 0x73, 0x7d]);

// 'H' は level 3/4/7 で固定値 5
check('H: 固定値 5', cmdImageMode(), [0x1b, 0x7b, 0x04, 0x48, 0x05, 0x4d, 0x7d]);
check('o: オブジェクト種別', cmdObjectType(0), [0x1b, 0x7b, 0x05, 0x6f, 0x00, 0x00, 0x6f, 0x7d]);

// 先頭 18 バイト (L + T) は commandLevel によらず同じ
{
  const head = pageEnvironmentCommand(0x1234, 7, { commandLevel: 5 }).subarray(0, 18);
  for (const level of SUPPORTED_COMMAND_LEVELS) {
    check(`level ${level}: 先頭 18 バイトは共通`,
      pageEnvironmentCommand(0x1234, 7, { commandLevel: level }).subarray(0, 18), head);
  }
}

// level 1 (SR5500P) は追加なし
checkEq('level 1: 追加コマンドなし',
  pageEnvironmentCommand(1, 0, { commandLevel: 1 }).length, 18);

// level 3 (SR5900P / C / GS) = H(5) + s + X
check('level 3: H + s + X',
  pageEnvironmentCommand(1, 0, { commandLevel: 3, printSpeed: PrintSpeed.LOW }).subarray(18), [
    0x1b, 0x7b, 0x04, 0x48, 0x05, 0x4d, 0x7d,   // H(5)
    0x1b, 0x7b, 0x04, 0x73, 0x01, 0x74, 0x7d,   // s(低速)
    0x1b, 0x7b, 0x04, 0x58, 0x00, 0x58, 0x7d,   // X(OFF)
  ]);
check('level 3: 中速は使えない (0 になる)',
  pageEnvironmentCommand(1, 0, { commandLevel: 3, printSpeed: PrintSpeed.MIDDLE }).subarray(25, 32),
  [0x1b, 0x7b, 0x04, 0x73, 0x00, 0x73, 0x7d]);
checkEq('level 3: y は付かない',
  pageEnvironmentCommand(1, 0, { commandLevel: 3, priorityPrint: true }).length, 18 + 7 * 3);

// level 4 (SR-R7900P) = H(5) + s + X + y? + o
check('level 4: H + s + X + o',
  pageEnvironmentCommand(1, 0, { commandLevel: 4, printSpeed: PrintSpeed.MIDDLE,
    halfCutContinuous: true }).subarray(18), [
    0x1b, 0x7b, 0x04, 0x48, 0x05, 0x4d, 0x7d,   // H(5)
    0x1b, 0x7b, 0x04, 0x73, 0x02, 0x75, 0x7d,   // s(中速。level 4 は許可あり)
    0x1b, 0x7b, 0x04, 0x58, 0x01, 0x59, 0x7d,   // X(ON)
    0x1b, 0x7b, 0x05, 0x6f, 0x00, 0x00, 0x6f, 0x7d, // o
  ]);
check('level 4: 優先印字は X と o の間',
  pageEnvironmentCommand(1, 0, { commandLevel: 4, priorityPrint: true }).subarray(39, 45),
  [0x1b, 0x7b, 0x03, 0x79, 0x79, 0x7d]);

// level 5 (SR-R2500P / SR-MK1) は従来どおり
checkEq('level 5: 追加なし', pageEnvironmentCommand(1, 0, { commandLevel: 5 }).length, 18);
check('level 5: 優先印字のみ',
  pageEnvironmentCommand(1, 0, { commandLevel: 5, priorityPrint: true }).subarray(18),
  [0x1b, 0x7b, 0x03, 0x79, 0x79, 0x7d]);

// 未解析の level は例外にする (黙って違うバイト列を送らない)
{
  let threw = false;
  try { pageEnvironmentCommand(1, 0, { commandLevel: 2 }); } catch { threw = true; }
  checkEq('level 2: 未実装なので例外', threw, true);
}

// ---- ジョブ (複数ラベル) --------------------------------------------------

function fakePage(lengthDots, widthDots = 72) {
  const bytesPerRow = (widthDots + 7) >> 3;
  const rows = Array.from({ length: lengthDots }, () => new Uint8Array(bytesPerRow).fill(0xa5));
  return { lengthDots, widthDots, marginDots: 7, rows };
}

// 1 ジョブに複数ページを積める (ページ環境 + ラスタ + FF がページ数ぶん並ぶ)
{
  const opts = { copies: 1, tapeCut: 0, halfCut: 0, density: 0, priorityPrint: false };
  const pages = [fakePage(10), fakePage(20), fakePage(30)];
  const one = buildJobBytes([pages[0]], opts);
  const all = buildJobBytes(pages, opts);

  const perPage = (p) => 18 + p.rows.length * (8 + p.rows[0].length) + 1; // ページ環境 + ラスタ + FF
  const envelope = 6 + 8 + 39 + 6;                                        // reset/status/ジョブ環境/印刷終了
  checkEq('ジョブ: 1 ページのバイト数', one.length, envelope + perPage(pages[0]));
  checkEq('ジョブ: 3 ページのバイト数', all.length,
    envelope + pages.reduce((n, p) => n + perPage(p), 0));

  // 包み (先頭のリセットと末尾の印刷終了) はページ数によらず 1 組だけ
  check('ジョブ: 先頭はリセット', all.subarray(0, 6), [0x1b, 0x7b, 0x03, 0x21, 0x21, 0x7d]);
  check('ジョブ: 末尾は印刷終了', all.subarray(all.length - 6), [0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d]);

  // セット数はページ列の繰り返しになる
  const twice = buildJobBytes(pages, { ...opts, copies: 2 });
  checkEq('ジョブ: 2 セットは中身が 2 倍', twice.length - envelope, (all.length - envelope) * 2);
}

// ---- ジョブの保存ファイル -------------------------------------------------

// 既定値で埋まる
{
  const d = normalizeDesign({});
  checkEq('版下: 既定の文字サイズ', d.fontScale, 85);
  checkEq('版下: 既定の揃え', d.align, 'center');
  checkEq('版下: 既定のフォント', d.fontFamily, 'sans-serif');
  checkEq('版下: 画像なし', d.imageDataUrl, null);
}

// 範囲外・不正な値は丸める / 捨てる
{
  const d = normalizeDesign({
    text: 'あ'.repeat(5000),
    fontScale: 9999,
    lineGapDots: -5,
    align: 'justify',
    lengthMode: 'stretch',
    fixedLengthMm: 'abc',
    paddingMm: -3,
    border: 'yes',
    imageDataUrl: 'javascript:alert(1)',
    imagePosition: 'top',
  });
  checkEq('版下: 本文の長さを切り詰める', d.text.length, 2000);
  checkEq('版下: 文字サイズを丸める', d.fontScale, 100);
  checkEq('版下: 行間を丸める', d.lineGapDots, 0);
  checkEq('版下: 不正な揃えは既定に', d.align, 'center');
  checkEq('版下: 不正な長さモードは既定に', d.lengthMode, 'auto');
  checkEq('版下: 数値でなければ既定に', d.fixedLengthMm, 40);
  checkEq('版下: 余白を丸める', d.paddingMm, 0);
  checkEq('版下: 真偽値にする', d.border, true);
  checkEq('版下: data URL 以外の画像は捨てる', d.imageDataUrl, null);
  checkEq('版下: 不正な画像位置は既定に', d.imagePosition, 'left');
}

// 画像は data URL のみ通す
{
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  checkEq('版下: PNG の data URL は通る', normalizeDesign({ imageDataUrl: png }).imageDataUrl, png);
  checkEq('版下: SVG は通さない',
    normalizeDesign({ imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).imageDataUrl, null);
  checkEq('版下: http URL は通さない',
    normalizeDesign({ imageDataUrl: 'https://example.com/a.png' }).imageDataUrl, null);
}

// 保存 → 読み込みで往復する
{
  const items = [
    createItem({ text: 'あああ', fontFamily: 'Hiragino Sans', border: true }, { copies: 3 }),
    createItem({ text: 'Label 2', lengthMode: 'fixed', fixedLengthMm: 60 }, { name: '住所ラベル' }),
  ];
  const json = serializeJob(items, {
    printer: 'SR-R2500P', tapeCode: 4, tapeCut: 1, halfCut: 0, density: 2, sets: 3,
  });
  const back = parseJob(json);

  checkEq('ジョブ: 項目数', back.items.length, 2);
  checkEq('ジョブ: 本文', back.items[0].design.text, 'あああ');
  checkEq('ジョブ: フォント', back.items[0].design.fontFamily, 'Hiragino Sans');
  checkEq('ジョブ: 枚数', back.items[0].copies, 3);
  checkEq('ジョブ: 名前', back.items[1].name, '住所ラベル');
  checkEq('ジョブ: 固定長', back.items[1].design.fixedLengthMm, 60);
  checkEq('ジョブ: 機種', back.printer, 'SR-R2500P');
  checkEq('ジョブ: テープ幅コード', back.tapeCode, 4);
  checkEq('ジョブ: カット設定', back.print.tapeCut, 1);
  checkEq('ジョブ: 濃度', back.print.density, 2);
  checkEq('ジョブ: セット数', back.print.sets, 3);
  checkEq('ジョブ: id は振り直す', back.items[0].id !== back.items[1].id, true);
}

// 見出し
{
  checkEq('見出し: 名前があればそれ',
    itemLabel(createItem({ text: 'あ' }, { name: '名前' })), '名前');
  checkEq('見出し: 本文の 1 行目',
    itemLabel(createItem({ text: '\n  \n二行目' })), '二行目');
  checkEq('見出し: 空なら注記', itemLabel(createItem({ text: '   ' })), '(empty label)');
  checkEq('見出し: 画像のみ',
    itemLabel(createItem({ text: '', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' })),
    '(image only)');
}

// 壊れたファイルは受け付けない
for (const [name, text] of [
  ['JSON でない', 'not json'],
  ['配列だけ', '[]'],
  ['format 違い', '{"format":"other","items":[{}]}'],
  ['items が無い', `{"format":"${JOB_FORMAT}"}`],
  ['items が空', `{"format":"${JOB_FORMAT}","items":[]}`],
  ['null', 'null'],
]) {
  let threw = false;
  try { parseJob(text); } catch { threw = true; }
  checkEq(`ジョブ: 読み込みを拒否 (${name})`, threw, true);
}

if (process.exitCode) console.error(`\n${passed} 件成功、失敗あり`);
else console.log(`すべて成功 (${passed} 件)`);
