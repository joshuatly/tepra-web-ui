// ラベルの版下をプリンタの実ドット解像度で描画する。
// 出力キャンバスは「幅 = ラベル長方向 / 高さ = テープ幅方向」で、
// PrintController が扱うビットマップと同じ向き。

import { mmToDots } from './raster.js';
import { parseSections, layoutSections } from './layout.js';
import { drawIcon, isIconId } from './icons.js';

/**
 * @typedef {Object} LabelSpec
 * @property {string[]} lines        本文 (1 行 1 要素)。"---" の行でセクションを区切り、
 *                                   "[tabler:plug]" でアイコンを入れる (layout.js)
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
 * @property {boolean} [dividers]    セクションの間に縦線を引く
 * @property {number} [sectionGapMm] セクションの間隔
 * @property {HTMLImageElement|null} image
 * @property {'left'|'right'} imagePosition
 * @property {number} imageGapMm
 */

const MIN_LENGTH_DOTS = 8;
const DEFAULT_SECTION_GAP_MM = 2;

function fontString(spec, pxSize) {
  const style = spec.italic ? 'italic ' : '';
  const weight = spec.bold ? '700 ' : '400 ';
  return `${style}${weight}${pxSize}px ${spec.fontFamily}`;
}

/** 文字幅の測定。同じ大きさの測定が続くので font の設定を使い回す。 */
function measurer(ctx, spec) {
  let current = '';
  return (text, fontPx) => {
    const font = fontString(spec, fontPx);
    if (font !== current) { ctx.font = font; current = font; }
    return ctx.measureText(text).width;
  };
}

/** 本文の組版。maxWidth を渡すとそこに収まるよう縮める。 */
function layoutText(spec, ctx, maxWidth) {
  const heightDots = Math.max(1, Math.floor(spec.heightDots));
  return layoutSections(parseSections(spec.lines.join('\n')), {
    heightDots,
    innerDots: spec.border ? heightDots - 6 : heightDots,
    lineGapDots: spec.lineGapDots,
    fontScale: spec.fontScale,
    sectionGapDots: mmToDots(spec.sectionGapMm ?? DEFAULT_SECTION_GAP_MM, spec.dpi),
    align: spec.align,
    measure: measurer(ctx, spec),
    isIcon: isIconId,
    maxWidth,
  });
}

/**
 * 版下を描画して canvas を返す。
 * @param {LabelSpec} spec
 * @returns {{canvas:HTMLCanvasElement, lengthDots:number, heightDots:number}}
 */
export function renderLabel(spec) {
  const heightDots = Math.max(1, Math.floor(spec.heightDots));
  const padding = mmToDots(spec.paddingMm, spec.dpi);

  let imageWidth = 0;
  let imageGap = 0;
  if (spec.image) {
    const scale = heightDots / spec.image.naturalHeight;
    imageWidth = Math.ceil(spec.image.naturalWidth * scale);
    imageGap = mmToDots(spec.imageGapMm, spec.dpi);
  }
  const imageSpace = imageWidth + (imageWidth ? imageGap : 0);

  // まず測定用のコンテキストで必要な長さを求める。固定長なら、はみ出す本文は縮めて収める。
  const probe = document.createElement('canvas').getContext('2d');
  let lengthDots;
  let layout;
  if (spec.lengthMode === 'fixed') {
    lengthDots = Math.max(MIN_LENGTH_DOTS, mmToDots(spec.fixedLengthMm, spec.dpi));
    layout = layoutText(spec, probe, Math.max(1, lengthDots - padding * 2 - imageSpace));
  } else {
    layout = layoutText(spec, probe, null);
    lengthDots = Math.max(MIN_LENGTH_DOTS, layout.width + imageSpace + padding * 2);
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

  // 本文全体の置き場所。セクション内の行の揃えは layout が済ませている。
  const areaWidth = Math.max(0, textRight - textLeft);
  const free = areaWidth - layout.width;
  const left = textLeft + (spec.align === 'center' ? free / 2 : spec.align === 'right' ? free : 0);

  for (const section of layout.sections) {
    for (const line of section.lines) {
      ctx.font = fontString(spec, line.fontPx);
      for (const run of line.runs) {
        const x = left + line.x + run.x;
        if (run.icon) {
          drawIcon(ctx, run.icon, x, line.centerY - line.fontPx / 2, line.fontPx, { bold: spec.bold });
        } else {
          ctx.fillText(run.text, x, line.centerY);
        }
      }
    }
  }

  // セクションの区切り線は間隔のちょうど真ん中に、枠線の内側いっぱいに引く
  if (spec.dividers && layout.sections.length > 1) {
    const inset = spec.border ? 3 : 0;
    ctx.lineWidth = 2;
    for (let i = 1; i < layout.sections.length; i++) {
      const prev = layout.sections[i - 1];
      const x = Math.round(left + (prev.x + prev.width + layout.sections[i].x) / 2);
      ctx.beginPath();
      ctx.moveTo(x, inset);
      ctx.lineTo(x, heightDots - inset);
      ctx.stroke();
    }
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
