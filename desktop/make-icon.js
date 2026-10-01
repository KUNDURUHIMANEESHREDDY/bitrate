#!/usr/bin/env node
/**
 * Generate desktop/icon.png.
 *
 * The icon is described as geometry and encoded to PNG here rather than being
 * committed as an opaque binary, so the artwork stays reviewable in a diff and
 * can be regenerated after a colour change. 4x4 supersampling matters: Windows
 * renders the tray icon at 16px, and without it the arrow edges look chewed.
 *
 * electron-builder derives the .ico and .icns from this file, so one PNG covers
 * every platform target.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'icon.png');
const SIZE = 512;
const SS = 4; // supersamples per axis

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP = rgb('#7C5CFF');
const BOTTOM = rgb('#3B22A8');
const WHITE = [255, 255, 255];

/** Signed-distance test for an axis-aligned rounded rectangle in 0..1 space. */
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

/**
 * A download arrow: shaft, head, and the tray it lands in. Kept inside
 * 0.24..0.82 vertically so the glyph has equal optical padding top and bottom,
 * which reads as centred far better than geometric centring would.
 */
const inGlyph = (x, y) => {
  const cx = 0.5;
  if (inRoundRect(x, y, cx - 0.058, 0.24, cx + 0.058, 0.55, 0.03)) return true;
  if (y >= 0.5 && y <= 0.685) {
    // Head widens linearly as it descends.
    const half = 0.048 + ((y - 0.5) / 0.185) * 0.19;
    if (Math.abs(x - cx) <= half) return true;
  }
  if (inRoundRect(x, y, cx - 0.265, 0.755, cx + 0.265, 0.818, 0.031)) return true;
  return false;
};

const inPlate = (x, y) => inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.225);

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const samples = SS * SS;

  for (let py = 0; py < SIZE; py++) {
    for (let pxi = 0; pxi < SIZE; pxi++) {
      let plate = 0;
      let glyph = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / SIZE;
          const y = (py + (sy + 0.5) / SS) / SIZE;
          if (!inPlate(x, y)) continue;
          plate++;
          if (inGlyph(x, y)) glyph++;
        }
      }
      if (plate === 0) continue;

      // Ease the gradient so the top face stays bright instead of washing out.
      const g = Math.pow(py / (SIZE - 1), 0.85);
      const f = glyph / samples;
      const out = (py * SIZE + pxi) * 4;
      for (let c = 0; c < 3; c++) {
        const base = TOP[c] + (BOTTOM[c] - TOP[c]) * g;
        px[out + c] = Math.round(base + (WHITE[c] - base) * f);
      }
      px[out + 3] = Math.round((plate / samples) * 255);
    }
  }
  return px;
}

// --- minimal PNG encoder (RGBA8, filter type 0) -----------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng(render(), SIZE, SIZE);
fs.writeFileSync(OUT, png);
console.log(`[icon] wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
