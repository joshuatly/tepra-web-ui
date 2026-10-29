// Server-side "print this PNG" used by POST /api/print/image.
// The browser UI does its own layout; this path is for scripts and home automation.

import { printableDots } from '../app/models.js';
import { toRasterRows, contentMarginDots, mmToDots } from '../app/raster.js';

/** Box-filter downscale so the image height fits the tape. */
function scaleGray(img, factor) {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  const out = new Uint8ClampedArray(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { sum += img.gray[yy * img.width + xx]; n++; }
      }
      out[y * w + x] = sum / n;
    }
  }
  return { width: w, height: h, gray: out };
}

function rotate90(img) {
  const { width, height, gray } = img;
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = gray[y * width + x];
    }
  }
  return { width: height, height: width, gray: out };
}

/**
 * Lays a grayscale image onto the tape: the image's height runs across the tape.
 * Taller images are scaled down; shorter ones are centred (or scaled up with fit=fill).
 * @param {{width:number,height:number,gray:Uint8ClampedArray}} img
 * @param {{model:object, tapeCode:number, fit?:'contain'|'fill', rotate?:boolean,
 *          paddingMm?:number, marginMm?:number, invert?:boolean}} opts
 */
export function imageToPage(img, opts) {
  const { model, tapeCode } = opts;
  const dots = printableDots(tapeCode, model.resolution, model.modelNumber);
  if (!dots) throw new Error('This tape width cannot be printed on this model');

  let src = opts.rotate ? rotate90(img) : img;
  if (src.height > dots || opts.fit === 'fill') src = scaleGray(src, dots / src.height);
  const pad = mmToDots(Math.max(0, opts.paddingMm ?? 2), model.resolution);
  const length = Math.max(src.width + pad * 2, mmToDots(4, model.resolution));

  const gray = new Uint8ClampedArray(length * dots).fill(255);
  const top = Math.floor((dots - src.height) / 2);
  const left = Math.floor((length - src.width) / 2);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const v = src.gray[y * src.width + x];
      gray[(top + y) * length + left + x] = opts.invert ? 255 - v : v;
    }
  }

  const { rows, widthDots, lengthDots } = toRasterRows({ width: length, height: dots, gray });
  return {
    lengthDots,
    widthDots,
    marginDots: contentMarginDots(opts.marginMm ?? 1, model.resolution, lengthDots),
    rows,
  };
}
