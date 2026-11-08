#!/usr/bin/env node
/* Stage the collection as a self-contained iOS payload.
 *
 * The app ships the SAME tree the browser tests play, copied into ios/web/ as a
 * folder reference, so the WKWebView shell reads it from the bundle with no
 * network at all. Everything here is derived: dist/ is the source of truth, and
 * the tree hash written to ios/payload.json is what proves the app carries the
 * tested bytes rather than a stale copy.
 *
 * Also renders the app icon: iOS masks the corners itself, so the 512px
 * rounded-corner launcher icon would come out double-rounded — the square
 * variant below is the same artwork with the background rect squared off.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from './lib/tree-hash.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const IOS = join(ROOT, 'ios');
const WEB = join(IOS, 'web');
const ASSETS = join(IOS, 'Resources', 'Assets.xcassets');
const ICON_DIR = join(ASSETS, 'AppIcon.appiconset');

const die = msg => { console.error('stage-ios: ' + msg); process.exit(1); };

if (!existsSync(join(DIST, 'index.html'))) die('dist/ is missing — run `npm run build` first');

/* ---------- payload ---------- */
rmSync(WEB, { recursive: true, force: true });
mkdirSync(WEB, { recursive: true });
cpSync(DIST, WEB, { recursive: true });
const tree = treeHash(WEB);

/* ---------- app icon (square, iOS masks the corners) ---------- */
const svg = readFileSync(join(ROOT, 'shell', 'assets', 'icon.svg'), 'utf8');
if (!svg.includes('rx="112"')) die('shell/assets/icon.svg changed shape — update the square-icon transform');
const squareSvg = svg.replace('<rect width="512" height="512" rx="112"', '<rect width="512" height="512"');
mkdirSync(ICON_DIR, { recursive: true });

/* The rendered icon is committed, because neither a macOS runner nor a bare Linux
 * box ships an SVG rasteriser — requiring one would make the build depend on the
 * machine. Re-render only when the source artwork actually changed; the sidecar
 * hash is what makes that decision checkout-time-safe.
 */
const iconPng = join(ICON_DIR, 'Icon-1024.png');
const iconStamp = join(ICON_DIR, 'icon-source.sha256');
const wanted = createHash('sha256').update(squareSvg).digest('hex');
const have = existsSync(iconStamp) ? readFileSync(iconStamp, 'utf8').trim() : '';
let rendered = false;
if (wanted !== have || !existsSync(iconPng)) {
  const tmpSvg = join(IOS, '.icon-square.svg');
  writeFileSync(tmpSvg, squareSvg);
  for (const bin of ['rsvg-convert', '/usr/sbin/rsvg-convert', 'magick', '/usr/sbin/magick', 'convert', '/usr/bin/convert']) {
    try {
      const args = /magick$|convert$/.test(bin)
        ? [tmpSvg, '-background', 'none', '-resize', '1024x1024', iconPng]
        : ['-w', '1024', '-h', '1024', '-o', iconPng, tmpSvg];
      execFileSync(bin, args, { stdio: 'pipe' });
      rendered = true;
      break;
    } catch { /* try the next renderer */ }
  }
  rmSync(tmpSvg, { force: true });
  if (rendered) writeFileSync(iconStamp, wanted + '\n');
  else if (existsSync(iconPng)) console.warn('stage-ios: no SVG rasteriser here — keeping the committed icon (re-render on a box that has one if the artwork changed)');
  else die('no SVG rasteriser found (need rsvg-convert or ImageMagick) and no committed icon to fall back on');
}

writeFileSync(join(ICON_DIR, 'Contents.json'), JSON.stringify({
  images: [{ filename: 'Icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');

mkdirSync(join(ASSETS, 'LaunchBG.colorset'), { recursive: true });
writeFileSync(join(ASSETS, 'LaunchBG.colorset', 'Contents.json'), JSON.stringify({
  colors: [{
    color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: '0.067', green: '0.047', red: '0.039' } },
    idiom: 'universal',
  }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');

mkdirSync(join(ASSETS, 'AccentColor.colorset'), { recursive: true });
writeFileSync(join(ASSETS, 'AccentColor.colorset', 'Contents.json'), JSON.stringify({
  colors: [{
    color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: '0.753', green: '0.886', red: '0.302' } },
    idiom: 'universal',
  }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');

writeFileSync(join(ASSETS, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n');

/* ---------- manifest the verifier reads back ---------- */
writeFileSync(join(IOS, 'payload.json'), JSON.stringify({
  stagedFrom: 'dist/',
  stagedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  web: tree,
}, null, 2) + '\n');

console.log(`staged ios/web from dist/ — ${tree.files} files, ${(tree.bytes / 1048576).toFixed(2)} MB, tree ${tree.sha256.slice(0, 12)}`);
console.log('icon  ios/Resources/Assets.xcassets/AppIcon.appiconset/Icon-1024.png');
