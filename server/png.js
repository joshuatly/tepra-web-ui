// Minimal PNG decoder (no dependencies) for the server-side image print API.
// Supports non-interlaced PNGs of every colour type and bit depth, which covers
// everything browsers, ImageMagick and Pillow write by default.
// Output is a grayscale image (0 = black, 255 = white) with alpha composited on white.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 20_000_000;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * @param {Buffer} buf
 * @returns {{width:number, height:number, gray:Uint8ClampedArray}}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');

  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (interlace) throw new Error('Interlaced PNGs are not supported');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('PNG is empty or too large');
  if (colorType === 3 && !palette) throw new Error('Palette PNG without PLTE');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);           // bytes per pixel for filtering
  const stride = (width * channels * depth + 7) >> 3;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is truncated');

  // Undo the per-row filters
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`Bad PNG filter ${filter}`);
      row[i] = v & 0xff;
    }
  }

  const maxV = (1 << depth) - 1;
  const sample = (row, index) => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];                   // high byte is enough
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxV;
  };
  const to8 = (v) => (depth === 16 || depth === 8 ? v : Math.round((v * 255) / maxV));
  const lum = (r, g, b) => Math.floor(r * 0.299 + g * 0.587 + b * 0.114);
  const over = (v, a) => Math.round((v * a + 255 * (255 - a)) / 255);

  const gray = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let v;
      let a = 255;
      const base = x * channels;
      if (colorType === 0) {
        const s = sample(row, x);
        v = to8(s);
        if (trns && trns.length >= 2 && s === (depth === 16 ? trns[0] : trns.readUInt16BE(0))) a = 0;
      } else if (colorType === 2) {
        v = lum(to8(sample(row, base)), to8(sample(row, base + 1)), to8(sample(row, base + 2)));
      } else if (colorType === 3) {
        const idx = sample(row, x);
        v = lum(palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]);
        if (trns && idx < trns.length) a = trns[idx];
      } else if (colorType === 4) {
        v = to8(sample(row, base));
        a = to8(sample(row, base + 1));
      } else {
        v = lum(to8(sample(row, base)), to8(sample(row, base + 1)), to8(sample(row, base + 2)));
        a = to8(sample(row, base + 3));
      }
      gray[y * width + x] = a === 255 ? v : over(v, a);
    }
  }
  return { width, height, gray };
}
