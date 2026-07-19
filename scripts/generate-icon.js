'use strict';

// Generates build/icon.png (1024x1024) for electron-builder using only Node
// built-ins (zlib for DEFLATE + CRC32) — no image libraries required.
// electron-builder auto-derives .ico (Windows) and .icns (macOS) from this
// single square PNG by convention (build/icon.png), and uses it as-is on Linux.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;

// Think A.M. brand palette: navy background, cyan accent (paper-airplane motif).
const NAVY = [0x10, 0x21, 0x3a, 0xff];
const CYAN_LIGHT = [0x38, 0xdf, 0xf2, 0xff];
const CYAN_SHADOW = [0x0c, 0x83, 0x91, 0xff];

const pixels = new Uint8Array(SIZE * SIZE * 4);

function setPx(x, y, rgba) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = rgba[0];
  pixels[i + 1] = rgba[1];
  pixels[i + 2] = rgba[2];
  pixels[i + 3] = rgba[3];
}

// Rounded-rect mask test (superellipse-ish via corner circle test).
function insideRoundedRect(x, y, w, h, r) {
  const left = 0, top = 0, right = w, bottom = h;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r;
}

function sign(p1x, p1y, p2x, p2y, p3x, p3y) {
  return (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function rotate(x, y, cx, cy, deg) {
  const rad = (deg * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

// 1) Background: rounded navy square.
const radius = SIZE * 0.19;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (insideRoundedRect(x, y, SIZE, SIZE, radius)) {
      setPx(x, y, NAVY);
    }
  }
}

// 2) Paper-airplane glyph, tilted, two-tone cyan for a folded-paper look.
const cx = SIZE / 2;
const cy = SIZE / 2;
const scale = SIZE / 1024;

const rawNose = { x: cx + 300 * scale, y: cy - 70 * scale };
const rawTopWing = { x: cx - 260 * scale, y: cy - 260 * scale };
const rawNotch = { x: cx - 30 * scale, y: cy - 20 * scale };
const rawBottomWing = { x: cx - 300 * scale, y: cy + 230 * scale };

const TILT = -14;
const nose = rotate(rawNose.x, rawNose.y, cx, cy, TILT);
const topWing = rotate(rawTopWing.x, rawTopWing.y, cx, cy, TILT);
const notch = rotate(rawNotch.x, rawNotch.y, cx, cy, TILT);
const bottomWing = rotate(rawBottomWing.x, rawBottomWing.y, cx, cy, TILT);

const minX = Math.floor(Math.min(nose.x, topWing.x, notch.x, bottomWing.x));
const maxX = Math.ceil(Math.max(nose.x, topWing.x, notch.x, bottomWing.x));
const minY = Math.floor(Math.min(nose.y, topWing.y, notch.y, bottomWing.y));
const maxY = Math.ceil(Math.max(nose.y, topWing.y, notch.y, bottomWing.y));

for (let y = minY; y <= maxY; y++) {
  for (let x = minX; x <= maxX; x++) {
    const inTop = pointInTriangle(x, y, nose.x, nose.y, topWing.x, topWing.y, notch.x, notch.y);
    const inBottom = pointInTriangle(x, y, nose.x, nose.y, notch.x, notch.y, bottomWing.x, bottomWing.y);
    if (inTop) setPx(x, y, CYAN_LIGHT);
    else if (inBottom) setPx(x, y, CYAN_SHADOW);
  }
}

// --- Minimal PNG encoder (RGBA8, filter-none scanlines) --------------------

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', compressed);

  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

const png = encodePng(SIZE, SIZE, Buffer.from(pixels));
const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Wrote', outPath, `(${png.length} bytes)`);
