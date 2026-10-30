// 印刷ジョブ (複数ラベル) のデータ構造と、保存ファイルの読み書き。
//
// 項目が持つのは「版下の設定」だけで、機種とテープ幅は持たない。
// 印刷するときの機種・テープ幅で毎回描き直すので、
//   - テープを 12mm から 18mm に替えても同じジョブをそのまま流せる
//   - 保存した JSON を別の機種の環境へ持って行ける
// ラスタを持ち回らないぶんファイルも小さい。

import { t } from './i18n.js';

export const JOB_FORMAT = 'tepra-web/job@1';

/** 保存ファイルに埋め込む画像の上限 (data URL の文字数) */
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

/** canvas に描いても安全な画像形式。SVG は外部参照を持てるので除く。 */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/;

const ALIGNS = ['left', 'center', 'right'];
const LENGTH_MODES = ['auto', 'fixed'];
const IMAGE_POSITIONS = ['left', 'right'];

// ---- 値の正規化 (読み込んだ JSON は信用しない) ---------------------------

function str(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function num(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_CHARS) return null;
  return IMAGE_DATA_URL.test(value) ? value : null;
}

/**
 * 版下の設定。UI から読んだものも、ファイルから来たものもここを通す。
 * @param {object} raw
 */
export function normalizeDesign(raw = {}) {
  return {
    text: str(raw.text, 2000),
    fontFamily: str(raw.fontFamily, 200) || 'sans-serif',
    bold: !!raw.bold,
    italic: !!raw.italic,
    fontScale: num(raw.fontScale, 40, 100, 85),
    lineGapDots: num(raw.lineGapDots, 0, 24, 2),
    align: oneOf(raw.align, ALIGNS, 'center'),
    lengthMode: oneOf(raw.lengthMode, LENGTH_MODES, 'auto'),
    fixedLengthMm: num(raw.fixedLengthMm, 4, 1000, 40),
    paddingMm: num(raw.paddingMm, 0, 50, 2),
    tapeMarginMm: num(raw.tapeMarginMm, 0, 50, 1),
    border: !!raw.border,
    dither: !!raw.dither,
    flip: !!raw.flip,
    imageDataUrl: imageUrl(raw.imageDataUrl),
    imagePosition: oneOf(raw.imagePosition, IMAGE_POSITIONS, 'left'),
  };
}

/** 一覧に出す短い見出し。本文の 1 行目から作る。 */
export function itemLabel(item) {
  if (item.name) return item.name;
  const firstLine = item.design.text.split('\n').find((l) => l.trim());
  if (firstLine) return firstLine.trim().slice(0, 24);
  return item.design.imageDataUrl ? t('(image only)') : t('(empty label)');
}

let counter = 0;
function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  counter += 1;
  return `item-${Date.now()}-${counter}`;
}

/**
 * @param {object} design
 * @param {{name?:string, copies?:number}} [opts]
 */
export function createItem(design, opts = {}) {
  return {
    id: newId(),
    name: str(opts.name, 80),
    copies: Math.round(num(opts.copies, 1, 99, 1)),
    design: normalizeDesign(design),
  };
}

function normalizeItem(raw = {}) {
  return createItem(raw.design ?? raw, { name: raw.name, copies: raw.copies });
}

// ---- 保存 / 読み込み ------------------------------------------------------

/**
 * @param {object[]} items
 * @param {{printer:string, tapeCode:number, tapeCut:number, halfCut:number,
 *          density:number, sets:number}} settings
 */
export function serializeJob(items, settings) {
  return JSON.stringify({
    format: JOB_FORMAT,
    savedAt: new Date().toISOString(),
    printer: settings.printer,
    tapeCode: settings.tapeCode,
    print: {
      tapeCut: settings.tapeCut,
      halfCut: settings.halfCut,
      density: settings.density,
      sets: settings.sets,
    },
    items: items.map((item) => ({
      name: item.name,
      copies: item.copies,
      design: item.design,
    })),
  }, null, 2);
}

/**
 * 保存ファイルを読む。壊れていれば例外。
 * @returns {{items:object[], printer:string|null, tapeCode:number|null, print:object}}
 */
export function parseJob(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t('Not valid JSON'));
  }
  if (!data || typeof data !== 'object') throw new Error(t('Top level is not an object'));
  if (data.format !== JOB_FORMAT) {
    throw new Error(t('Unsupported format ({format})', { format: str(data.format, 40) || t('unknown') }));
  }
  if (!Array.isArray(data.items)) throw new Error(t('Missing items'));
  if (!data.items.length) throw new Error(t('The job has no items'));
  if (data.items.length > 500) throw new Error(t('Too many items (max 500)'));

  const print = data.print && typeof data.print === 'object' ? data.print : {};
  return {
    items: data.items.map(normalizeItem),
    printer: typeof data.printer === 'string' ? data.printer : null,
    tapeCode: Number.isFinite(Number(data.tapeCode)) ? Number(data.tapeCode) : null,
    print: {
      tapeCut: num(print.tapeCut, 0, 2, 0),
      halfCut: num(print.halfCut, 0, 1, 0),
      density: num(print.density, -5, 5, 0),
      sets: Math.round(num(print.sets, 1, 99, 1)),
    },
  };
}
