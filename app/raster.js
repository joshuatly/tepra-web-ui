// キャンバス → プリンタのラスタ行への変換。
// PrintController.getImageData() + CommandFilter::bitmapToRaster() 相当。

/** bitmapToRaster の 2 値化しきい値 (gray < 0x8C を黒とする) */
export const THRESHOLD = 0x8c;

/** PrintController.getImageData() のグレースケール化 */
function toGray(data, i) {
  return Math.floor(((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114)));
}

/**
 * ImageData をグレースケール配列 (幅 x 高さ) にする。
 * アルファが 0 の画素は白 (255) 扱い。
 */
export function grayscale(imageData) {
  const { width, height, data } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const a = data[i + 3];
    gray[p] = a === 0 ? 255 : toGray(data, i);
  }
  return { width, height, gray };
}

/** Floyd–Steinberg 誤差拡散。gray を 0 / 255 に潰して返す。 */
export function ditherFloydSteinberg({ width, height, gray }) {
  const buf = Float32Array.from(gray);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const nv = old < 128 ? 0 : 255;
      buf[i] = nv;
      const err = old - nv;
      if (x + 1 < width) buf[i + 1] += err * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += err * 3 / 16;
        buf[i + width] += err * 5 / 16;
        if (x + 1 < width) buf[i + width + 1] += err * 1 / 16;
      }
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < out.length; i++) out[i] = buf[i];
  return { width, height, gray: out };
}

/**
 * ラベル向きのグレースケール画像をラスタ行の配列に変換する。
 *
 * 入力は「幅 = ラベル長方向、高さ = テープ幅方向 (上が 0)」。
 * PrintController の Matrix.postRotate(90) + postTranslate(width, 0) により
 *   ラスタ行番号  = ラベルの x 座標
 *   行内オフセット = (テープ幅ドット数 - 1) - ラベルの y 座標
 * となる (テープ幅方向は反転する)。
 *
 * @param {{width:number,height:number,gray:Uint8ClampedArray}} img
 * @param {{flip?:boolean}} [opts] flip=true でテープ幅方向の反転をやめる
 * @returns {{rows: Uint8Array[], widthDots:number, lengthDots:number}}
 */
export function toRasterRows(img, opts = {}) {
  const { width: lengthDots, height: widthDots, gray } = img;
  const rowBytes = (widthDots + 7) >> 3;
  const rows = new Array(lengthDots);

  for (let x = 0; x < lengthDots; x++) {
    const row = new Uint8Array(rowBytes);
    for (let d = 0; d < widthDots; d++) {
      // d はプリントヘッドのドット番号 (0 が行の MSB 側)
      const y = opts.flip ? d : widthDots - 1 - d;
      if (gray[y * lengthDots + x] < THRESHOLD) {
        row[d >> 3] |= 0x80 >> (d & 7);
      }
    }
    rows[x] = row;
  }
  return { rows, widthDots, lengthDots };
}

/** mm → ドット */
export function mmToDots(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

/** ドット → mm */
export function dotsToMm(dots, dpi) {
  return (dots / dpi) * 25.4;
}

/**
 * TepraPrintDotbydotDraw.beginPage() と同じ余白計算。
 * margin_mm/25.4*resolution を (int) キャストで切り捨て、ラベル長を超えないよう丸める。
 */
export function contentMarginDots(marginMm, dpi, lengthDots) {
  const v = Math.floor((Math.max(0, marginMm) / 25.4) * dpi);
  return Math.min(v, lengthDots);
}
