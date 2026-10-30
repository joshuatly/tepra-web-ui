// フォント一覧の取得と、canvas に描く前の読み込み待ち。
//
// 一覧は Local Font Access API (`window.queryLocalFonts()`) で取る。
// Chrome / Edge 103 以降で使え、初回に「フォント」の許可ダイアログが出る。
// localhost は secure context 扱いなので、そのまま呼べる。
//
// 非対応ブラウザ (Safari / Firefox) では代表的な同梱フォントを列挙し、
// 実際に入っているものだけを残す。

import { t } from './i18n.js';

/** 存在判定・カバー判定に使う文字。かな・漢字・ラテン・記号を混ぜている。 */
const SAMPLE = 'あアa禁WM1@#';

let probeCtx = null;
function probe() {
  if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
  return probeCtx;
}

/**
 * 総称ファミリと CSS 全体キーワード。
 * 同じ名前のフォントが入っていても総称として解釈されないよう、必ず引用符で囲む。
 */
const RESERVED_FAMILY = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default',
]);

/** CSS の font-family に埋め込める形にする */
export function cssFamily(family) {
  const name = String(family || '').trim();
  if (!name) return 'sans-serif';
  // 引用符なしで書けるのは英数字とハイフンだけ、かつ予約語でないとき
  if (/^[A-Za-z][\w-]*$/.test(name) && !RESERVED_FAMILY.has(name.toLowerCase())) return name;
  return `"${name.replace(/["\\]/g, '')}"`;
}

function widthWith(fontList, text, px = 72) {
  const ctx = probe();
  ctx.font = `${px}px ${fontList}`;
  return ctx.measureText(text).width;
}

/**
 * そのフォントが実際に入っているか。
 *
 * document.fonts.check() はローカルフォントに対しては未インストールでも true を
 * 返してしまうので使えない。総称フォントを指定したときと描画幅が変わるかで見る。
 */
export function fontExists(family) {
  const quoted = cssFamily(family);
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    if (widthWith(`${quoted}, ${generic}`, SAMPLE) !== widthWith(generic, SAMPLE)) return true;
  }
  return false;
}

// 「そのフォントに日本語のグリフがあるか」は描画幅からは判定できない。
// 全角は書体を問わず 1em 送りなので、フォールバックで代替されても幅が変わらない。
// 実測 (72px, 'あア漢'):
//   Hiragino Sans 216 / Klee 216 / Impact 216 / Arial 216 / 存在しないファミリ 216
// ラテン文字は書体ごとに幅が違うので、下の fontExists は成立する。

/** Local Font Access API が使えるか */
export function hasLocalFontApi() {
  return typeof window.queryLocalFonts === 'function';
}

/** 許可の状態。'granted' / 'denied' / 'prompt' / null (問い合わせ不可) */
export async function localFontPermission() {
  if (!navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' });
    return status.state;
  } catch {
    return null;
  }
}

/**
 * インストール済みフォントのファミリ名を取る。
 * 許可されていなければ例外を投げる (呼び出しはユーザー操作の中から)。
 * @returns {Promise<string[]>}
 */
export async function queryLocalFamilies() {
  if (!hasLocalFontApi()) throw new Error(t('This browser does not support the Local Font Access API'));
  const faces = await window.queryLocalFonts();
  // 1 ファミリに複数のフェイス (Regular / Bold / …) があるのでまとめる
  const families = new Set();
  for (const face of faces) {
    if (face.family) families.add(face.family);
  }
  return sortFamilies([...families]);
}

/** 非対応ブラウザ用。よく入っているものを挙げて、実在するものだけ残す。 */
const KNOWN_FAMILIES = [
  // 日本語 (macOS)
  'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Hiragino Kaku Gothic Pro',
  'Hiragino Maru Gothic ProN', 'Hiragino Mincho ProN', 'Hiragino Sans GB',
  'YuGothic', 'Yu Gothic', 'YuMincho', 'Yu Mincho', 'Osaka',
  'Klee', 'Klee One', 'Tsukushi A Round Gothic', 'Tsukushi B Round Gothic',
  'Toppan Bunkyu Gothic', 'Toppan Bunkyu Mincho', 'Toppan Bunkyu Midashi Gothic',
  // 日本語 (Windows)
  'Meiryo', 'Meiryo UI', 'MS Gothic', 'MS PGothic', 'MS Mincho', 'MS PMincho',
  'BIZ UDGothic', 'BIZ UDPGothic', 'BIZ UDMincho', 'BIZ UDPMincho',
  'UD Digi Kyokasho N-R', 'Yu Gothic UI',
  // 日本語 (追加インストールされていることが多いもの)
  'Noto Sans JP', 'Noto Serif JP', 'Source Han Sans', 'Source Han Serif',
  'Kozuka Gothic Pr6N', 'Kozuka Mincho Pr6N', 'IPAexGothic', 'IPAexMincho',
  // ラテン
  'Helvetica', 'Helvetica Neue', 'Arial', 'Arial Black', 'Avenir', 'Avenir Next',
  'Futura', 'Gill Sans', 'Optima', 'Georgia', 'Times New Roman', 'Palatino',
  'Baskerville', 'Didot', 'Rockwell', 'Copperplate', 'Impact', 'Verdana',
  'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Cambria', 'Garamond',
  // 等幅
  'SF Mono', 'Menlo', 'Monaco', 'Courier New', 'Consolas', 'Andale Mono',
];

/** API が使えないときの一覧 */
export function knownFamilies() {
  return sortFamilies(KNOWN_FAMILIES.filter(fontExists));
}

/**
 * 名前から日本語書体らしさを見るだけの目安。
 *
 * グリフの有無は判定できない (上のコメント参照) ので、これは並び順にしか使わない。
 * 取りこぼしても一覧の下の方に回るだけで、選べなくなるわけではない。
 */
const JAPANESE_NAME =
  /hiragino|ヒラギノ|yu ?(gothic|mincho)|游|meiryo|メイリオ|\bms ?p?(gothic|mincho)\b|osaka|noto ?(sans|serif) ?(jp|cjk)|source ?han|klee|toppan|凸版|tsukushi|筑紫|biz ?ud|ipa(ex|mj)?|kozuka|小塚|shippori|zen |kaisei|sawarabi|dela|rounded ?m\+|明朝|ゴシック|丸ゴ|角ゴ|教科書|ud ?digi|jis|hannari|kokoro|mplus|m\+ ?/i;

/** 日本語書体らしい名前を先に、あとは名前順 */
export function sortFamilies(list) {
  const ja = (name) => (JAPANESE_NAME.test(name) ? 0 : 1);
  return [...list].sort((a, b) => (ja(a) - ja(b)) || a.localeCompare(b, 'ja'));
}

/**
 * canvas に描く前の読み込み待ち。
 *
 * インストール済みフォントは即座に解決するが、後から FontFace を足したときや
 * ブラウザが遅延読み込みする場合に効く。失敗しても描画自体は続けたいので握り潰す。
 * @param {string} cssFont ctx.font に渡すのと同じ文字列
 */
export async function ensureFontLoaded(cssFont, text = SAMPLE) {
  try {
    await document.fonts.load(cssFont, text);
  } catch {
    /* 指定が読めない形でも描画は試みる */
  }
}
