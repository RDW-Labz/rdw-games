#!/usr/bin/env node
/**
 * Generates placeholder icon + splash PNGs for bidder-app.
 * Run once from repo root:
 *   node apps/bidder-app/scripts/generate-assets.js
 *
 * Requires Node >=18 (uses built-in zlib). No npm deps.
 * Replace the output files with designer artwork before App Store submission.
 * See apps/bidder-app/BRAND_NAME_TODO.md for full asset spec.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/** Deep navy background to match splash backgroundColor in app.json */
const BG  = [10, 12, 17];   // #0a0c11
const FG  = [255, 255, 255]; // white letter

/**
 * Writes a minimal valid RGB PNG.
 * Draws a blocky "B" centred on the canvas if drawLetter is true.
 */
function writePng(filePath, width, height, drawLetter) {
  // Build raw pixel rows (filter byte 0x00 = None prepended per row)
  const rawRows = [];
  const sw = Math.round(width  * 0.08); // stroke width  ~8% of dimension
  const lh = Math.round(height * 0.55); // letter height ~55%
  const lx = Math.round(width  * 0.32); // left edge of letter
  const ly = Math.round((height - lh) / 2);

  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0x00; // filter: None
    for (let x = 0; x < width; x++) {
      let [r, g, b] = BG;

      if (drawLetter) {
        const vert = x >= lx && x < lx + sw && y >= ly && y < ly + lh;
        const topBarH = y === ly || y === ly + 1;
        const midBarH = y >= ly + lh / 2 - 1 && y <= ly + lh / 2 + 1;
        const botBarH = y >= ly + lh - 2 && y <= ly + lh - 1;
        const inTopBump = x >= lx + sw && x < lx + sw * 3.5 &&
                          y >= ly && y < ly + lh / 2;
        const inBotBump = x >= lx + sw && x < lx + sw * 4 &&
                          y >= ly + lh / 2 && y < ly + lh;
        const topRightEdge = x >= lx + sw * 3 && x < lx + sw * 3.5 &&
                             y > ly && y < ly + lh / 2 - 1;
        const botRightEdge = x >= lx + sw * 3.5 && x < lx + sw * 4 &&
                             y > ly + lh / 2 && y < ly + lh - 1;
        const horizTop = (topBarH || midBarH) && x >= lx + sw && x < lx + sw * 3.5;
        const horizBot = (midBarH || botBarH) && x >= lx + sw && x < lx + sw * 4;

        if (vert || horizTop || horizBot || topRightEdge || botRightEdge) {
          [r, g, b] = FG;
        }
      }

      const off = 1 + x * 3;
      row[off]     = r;
      row[off + 1] = g;
      row[off + 2] = b;
    }
    rawRows.push(row);
  }

  const raw = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = crc32(body);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([lenBuf, body, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // color type: RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
  console.log(`  wrote ${path.basename(filePath)}  ${width}x${height}  ${png.length} bytes`);
}

// --- CRC32 table ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- Generate ---
console.log('Generating bidder-app placeholder assets...');
writePng(path.join(ASSETS_DIR, 'icon.png'),          1024, 1024, true);
writePng(path.join(ASSETS_DIR, 'adaptive-icon.png'), 1024, 1024, true);
writePng(path.join(ASSETS_DIR, 'splash.png'),        2048, 2048, true);
writePng(path.join(ASSETS_DIR, 'favicon.png'),         48,   48, false);
console.log('Done. Replace with designer artwork before App Store submission.');
console.log('See apps/bidder-app/BRAND_NAME_TODO.md for asset spec.');
