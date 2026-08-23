#!/usr/bin/env node
/* eslint-disable no-console */
// Generate public/favicon.ico for the Windows shortcut.
//
// There is no image tooling on the build machine and no icon in the repo, so the
// shortcut was falling back to the generic .bat icon. Rather than add an ImageMagick
// dependency, the icon is drawn here and encoded directly: an ICO is just a small
// header plus one embedded PNG per size, and PNG is a zlib stream of raw scanlines.
//
// The mark is JobFinder's target: concentric rings on the app's dark surface.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [256, 128, 64, 48, 32, 16];
const OUT = path.join(__dirname, '..', 'public', 'favicon.ico');

// Palette matches the dashboard so the icon does not look like a different product.
const BG    = [22, 27, 34, 255];      // --surface
const RING  = [88, 166, 255, 255];    // --accent
const CENTR = [255, 123, 114, 255];   // --red, the bullseye
const EDGE  = [48, 54, 61, 255];      // --line

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const R = size / 2;
  const put = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  // Ring radii as fractions of the icon, so it scales cleanly to 16px.
  const rings = [
    { at: 0.92, w: 0.10, col: EDGE },
    { at: 0.66, w: 0.13, col: RING },
    { at: 0.34, w: 0.13, col: RING },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy) / R;   // 0 at centre, 1 at edge

      if (d > 0.98) { put(x, y, [0, 0, 0, 0]); continue; }   // transparent outside
      let col = BG;
      if (d < 0.16) col = CENTR;
      else {
        for (const r of rings) {
          if (Math.abs(d - r.at) < r.w / 2) { col = r.col; break; }
        }
      }
      // Soften the outer edge so small sizes do not look jagged.
      if (d > 0.90) {
        const a = Math.max(0, Math.min(1, (0.98 - d) / 0.08));
        col = [col[0], col[1], col[2], Math.round(255 * a)];
      }
      put(x, y, col);
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function toPng(rgba, size) {
  // PNG scanlines are each prefixed with a filter byte; 0 = none.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((s) => ({ size: s, png: toPng(draw(s), s) }));

// ICONDIR: reserved(2) type(2) count(2), then one 16-byte entry per image.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);                 // 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const im of images) {
  const e = Buffer.alloc(16);
  e[0] = im.size >= 256 ? 0 : im.size;      // 0 means 256
  e[1] = im.size >= 256 ? 0 : im.size;
  e[2] = 0;                                  // palette
  e[3] = 0;                                  // reserved
  e.writeUInt16LE(1, 4);                     // colour planes
  e.writeUInt16LE(32, 6);                    // bits per pixel
  e.writeUInt32LE(im.png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += im.png.length;
  entries.push(e);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
console.log(`  wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB, ${SIZES.join('/')}px)`);
