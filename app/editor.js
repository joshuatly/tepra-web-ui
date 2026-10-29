// ラベルの版下をプリンタの実ドット解像度で描画する。
// 出力キャンバスは「幅 = ラベル長方向 / 高さ = テープ幅方向」で、
// PrintController が扱うビットマップと同じ向き。

import { mmToDots } from './raster.js';

/**
 * @typedef {Object} LabelSpec
 * @property {string[]} lines        本文 (1 行 1 要素)
 * @property {string} fontFamily
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {number} fontScale      行スロットに対する文字の高さ比 (0.5〜1.0)
 * @property {number} lineGapDots    行間 (ドット)
 * @property {'left'|'center'|'right'} align
 * @property {number} heightDots     テープの印字可能ドット数
 * @property {number} dpi
 * @property {'auto'|'fixed'} lengthMode
 * @property {number} fixedLengthMm
 * @property {number} paddingMm      版下の左右余白
 * @property {boolean} border        枠線
 * @property {HTMLImageElement|null} image
 * @property {'left'|'right'} imagePosition
 * @property {number} imageGapMm
 */

const MIN_LENGTH_DOTS = 8;

function fontString(spec, pxSize) {
  const style = spec.italic ? 'italic ' : '';
  const weight = spec.bold ? '700 ' : '400 ';
  return `${style}${weight}${pxSize}px ${spec.fontFamily}`;
}

/** 各行のフォントサイズ (px) と縦位置 (ベースライン) を決める */
function layoutLines(spec) {
  const lines = spec.lines.length ? spec.lines : [''];
  const inner = spec.border ? spec.heightDots - 6 : spec.heightDots;
  const totalGap = spec.lineGapDots * (lines.length - 1);
  const slot = Math.max(4, (inner - totalGap) / lines.length);
  const fontPx = Math.max(4, Math.floor(slot * spec.fontScale));
  const top = (spec.heightDots - (slot * lines.length + totalGap)) / 2;
  return lines.map((text, i) => ({
    text,
    fontPx,
    // ベースラインは中央揃え (textBaseline = 'middle') で扱う
    centerY: top + slot * i + slot / 2 + spec.lineGapDots * i,
  }));
}

function measureContentWidth(ctx, spec, layout) {
  let max = 0;
  for (const l of layout) {
    ctx.font = fontString(spec, l.fontPx);
    max = Math.max(max, ctx.measureText(l.text).width);
  }
  return Math.ceil(max);
}

/**
 * 版下を描画して canvas を返す。
 * @param {LabelSpec} spec
 * @returns {{canvas:HTMLCanvasElement, lengthDots:number, heightDots:number}}
 */
export function renderLabel(spec) {
  const heightDots = Math.max(1, Math.floor(spec.heightDots));
  const padding = mmToDots(spec.paddingMm, spec.dpi);

  // まず測定用のコンテキストで必要な長さを求める
  const probe = document.createElement('canvas').getContext('2d');
  const layout = layoutLines(spec);
  const textWidth = measureContentWidth(probe, spec, layout);

  let imageWidth = 0;
  let imageGap = 0;
  if (spec.image) {
    const scale = heightDots / spec.image.naturalHeight;
    imageWidth = Math.ceil(spec.image.naturalWidth * scale);
    imageGap = mmToDots(spec.imageGapMm, spec.dpi);
  }

  const contentWidth = textWidth + imageWidth + (imageWidth ? imageGap : 0);
  let lengthDots;
  if (spec.lengthMode === 'fixed') {
    lengthDots = Math.max(MIN_LENGTH_DOTS, mmToDots(spec.fixedLengthMm, spec.dpi));
  } else {
    lengthDots = Math.max(MIN_LENGTH_DOTS, contentWidth + padding * 2);
  }

  const canvas = document.createElement('canvas');
  canvas.width = lengthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lengthDots, heightDots);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.textBaseline = 'middle';

  if (spec.border) {
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, lengthDots - 2, heightDots - 2);
  }

  // 画像
  let textLeft = padding;
  let textRight = lengthDots - padding;
  if (spec.image && imageWidth > 0) {
    if (spec.imagePosition === 'left') {
      ctx.drawImage(spec.image, padding, 0, imageWidth, heightDots);
      textLeft = padding + imageWidth + imageGap;
    } else {
      ctx.drawImage(spec.image, lengthDots - padding - imageWidth, 0, imageWidth, heightDots);
      textRight = lengthDots - padding - imageWidth - imageGap;
    }
  }

  const areaWidth = Math.max(0, textRight - textLeft);
  for (const l of layout) {
    if (!l.text) continue;
    ctx.font = fontString(spec, l.fontPx);
    const w = ctx.measureText(l.text).width;
    let x = textLeft;
    if (spec.align === 'center') x = textLeft + (areaWidth - w) / 2;
    else if (spec.align === 'right') x = textRight - w;
    ctx.fillText(l.text, x, l.centerY);
  }

  return { canvas, lengthDots, heightDots };
}

/**
 * 生成済みキャンバスをプレビュー用に拡大して別キャンバスへ描く。
 * ラベルは「左から右へ」読める向きのまま表示する。
 */
export function drawPreview(target, source, scale) {
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
}

/** 2 値化した結果をプレビューに反映する (実際に印字されるドット) */
export function drawBinarizedPreview(target, img, scale) {
  const { width, height, gray } = img;
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const octx = off.getContext('2d');
  const id = octx.createImageData(width, height);
  for (let i = 0, p = 0; p < gray.length; p++, i += 4) {
    const v = gray[p] < 0x8c ? 0 : 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  octx.putImageData(id, 0, 0);
  drawPreview(target, off, scale);
}
