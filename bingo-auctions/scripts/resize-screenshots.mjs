#!/usr/bin/env node
// =============================================================================
// scripts/resize-screenshots.mjs
//
// Resize raw device screenshots to an exact App Store Connect slot size.
//
// iPhone 16 Pro captures at 1206x2622 (6.3" display), which is NOT one of
// Apple's accepted App Store screenshot slots. The 6.7"/6.9" slot
// (APP_IPHONE_67) accepts 1290x2796 or 1320x2868. The aspect ratios are
// near-identical (1206/2622 = 0.4600 vs 1290/2796 = 0.4613, a 0.1% diff),
// so a straight resize to 1290x2796 is visually imperceptible — no
// letterboxing required.
//
// Reads every *.png / *.PNG / *.jpg from --in, resizes to --width x --height
// (default 1290x2796), writes to --out preserving filename (forced .png).
//
// Usage:
//   node scripts/resize-screenshots.mjs --in docs/screenshots/staff --out docs/screenshots/staff-resized
//   node scripts/resize-screenshots.mjs --in <dir> --out <dir> --width 1290 --height 2796
// =============================================================================

import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flags = { in: null, out: null, width: 1290, height: 2796 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in') flags.in = args[++i];
  else if (args[i] === '--out') flags.out = args[++i];
  else if (args[i] === '--width') flags.width = Number(args[++i]);
  else if (args[i] === '--height') flags.height = Number(args[++i]);
}

if (!flags.in || !flags.out) {
  console.error('Usage: node scripts/resize-screenshots.mjs --in <dir> --out <dir> [--width 1290] [--height 2796]');
  process.exit(1);
}
if (!existsSync(flags.in)) {
  console.error(`Input dir not found: ${flags.in}`);
  process.exit(1);
}
mkdirSync(flags.out, { recursive: true });

const files = readdirSync(flags.in).filter((f) => /\.(png|jpe?g)$/i.test(f));
if (files.length === 0) {
  console.error(`No PNG/JPG files found in ${flags.in}`);
  process.exit(1);
}

console.log(`Resizing ${files.length} file(s) -> ${flags.width}x${flags.height}\n`);

let ok = 0;
for (const f of files) {
  const src = join(flags.in, f);
  const dstName = basename(f, extname(f)) + '.png';
  const dst = join(flags.out, dstName);
  try {
    const meta = await sharp(src).metadata();
    await sharp(src)
      // 'fill' forces exact dimensions (tiny aspect-ratio nudge, imperceptible).
      // Use 'cover' if you'd rather crop than nudge; 'fill' keeps all content.
      .resize(flags.width, flags.height, { fit: 'fill' })
      .png()
      .toFile(dst);
    console.log(`  ok ${f} (${meta.width}x${meta.height}) -> ${dstName} (${flags.width}x${flags.height})`);
    ok++;
  } catch (e) {
    console.error(`  FAIL ${f}: ${e.message}`);
  }
}

console.log(`\nDone: ${ok}/${files.length} resized into ${flags.out}`);
