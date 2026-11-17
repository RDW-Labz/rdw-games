#!/usr/bin/env node
/* Checks the iOS app is actually shippable, on any machine, without Xcode.
 *
 * The point is the seam between "the web tests passed" and "the app carries that
 * same collection": the bundle payload has to be byte-identical to dist/, the
 * entry points have to exist, the icon has to be a real 1024×1024 PNG, and the
 * plist/project wiring has to name files that exist. Swift compilation is the one
 * thing this cannot cover — that needs a macOS runner, and CI does it in ios.yml.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from './lib/tree-hash.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IOS = join(ROOT, 'ios');
const WEB = join(IOS, 'web');
const DIST = join(ROOT, 'dist');

let failures = 0;
const ok = (name, detail = '') => console.log(`  ${name} … PASS${detail ? ' — ' + detail : ''}`);
const bad = (name, detail) => { failures++; console.log(`  ${name} … FAIL — ${detail}`); };

/* 1. the payload is the tested collection, byte for byte */
if (!existsSync(join(WEB, 'index.html'))) {
  bad('payload staged', 'ios/web/index.html is missing — run npm run build && node tools/stage-ios.mjs');
} else {
  const dist = treeHash(DIST);
  const web = treeHash(WEB);
  if (web.sha256 === dist.sha256 && web.files === dist.files) {
    ok('payload matches dist/', `${web.files} files, ${(web.bytes / 1048576).toFixed(2)} MB, tree ${web.sha256.slice(0, 12)}`);
  } else {
    bad('payload matches dist/', `web ${web.files}/${web.sha256.slice(0, 8)} vs dist ${dist.files}/${dist.sha256.slice(0, 8)} — re-run stage-ios`);
  }
  const manifest = JSON.parse(readFileSync(join(IOS, 'payload.json'), 'utf8'));
  if (manifest.web && manifest.web.sha256 === web.sha256) ok('payload.json describes the staged tree');
  else bad('payload.json describes the staged tree', 'manifest hash is stale');

  /* 2. every entry point the shell links to is inside the bundle */
  const must = [
    'index.html', 'shell/index.html', 'shell/app.js', 'shell/styles.css', 'shell/lib/gamekit.js',
    'shell/lib/catalog.data.js', 'catalog/games.json', 'manifest.webmanifest', 'sw.js', 'vendor/vendor.js',
  ];
  const missing = must.filter(f => !existsSync(join(WEB, f)));
  if (missing.length) bad('entry points present', 'missing ' + missing.join(', '));
  else ok('entry points present', `${must.length} shell files`);

  const catalog = JSON.parse(readFileSync(join(WEB, 'catalog', 'games.json'), 'utf8'));
  const games = (catalog.games || []).map(g => g.id);
  const playable = games.filter(id => existsSync(join(WEB, 'games', id, 'index.html')));
  if (playable.length >= 8) ok('playable titles bundled', `${playable.length} of ${games.length} catalogued: ${playable.join(', ')}`);
  else bad('playable titles bundled', `only ${playable.length} have games/<id>/index.html`);

  /* 3. nothing that only exists on a dev machine rode along */
  const strays = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['.DS_Store', 'node_modules', '__MACOSX', 'saves'].includes(e.name)) strays.push(join(dir, e.name).replace(ROOT + '/', ''));
      else if (e.isDirectory()) walk(join(dir, e.name));
    }
  };
  walk(WEB);
  if (strays.length) bad('no dev-only files in the payload', strays.slice(0, 3).join(', '));
  else ok('no dev-only files in the payload');
}

/* 4. the icon is a real PNG at Apple's single-size dimension */
const icon = join(IOS, 'Resources', 'Assets.xcassets', 'AppIcon.appiconset', 'Icon-1024.png');
if (!existsSync(icon)) bad('app icon', 'Icon-1024.png missing');
else {
  const buf = readFileSync(icon);
  const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (png && w === 1024 && h === 1024) ok('app icon', `1024×1024 PNG, ${(buf.length / 1024).toFixed(0)} KB`);
  else bad('app icon', `png=${png} size=${w}×${h}`);
}

/* 5. Info.plist parses and declares an offline app with no ATS hole */
try {
  const out = execFileSync('python3', ['-c', `
import plistlib, json, sys
d = plistlib.load(open(sys.argv[1], 'rb'))
print(json.dumps({
  'keys': sorted(d.keys()),
  'enc': d.get('ITSAppUsesNonExemptEncryption'),
  'launch': bool(d.get('UILaunchScreen')),
  'ats': 'NSAppTransportSecurity' in d,
  'extra_download': d.get('ITSDrivesDownloadOfAdditionalAssets'),
}))
`, join(IOS, 'Info.plist')], { encoding: 'utf8' });
  const info = JSON.parse(out);
  const problems = [];
  if (!info.launch) problems.push('no UILaunchScreen (app would letterbox)');
  if (info.enc !== false) problems.push('ITSAppUsesNonExemptEncryption is not false (export compliance prompt)');
  if (info.ats) problems.push('NSAppTransportSecurity present — an offline app should not need a network exception');
  if (problems.length) bad('Info.plist', problems.join('; '));
  else ok('Info.plist', `${info.keys.length} keys, offline-clean`);
} catch (e) {
  bad('Info.plist', 'does not parse: ' + String(e.message || e).split('\n')[0]);
}

/* 6. the project spec points at files that exist (xcodegen validates the rest on macOS) */
try {
  const spec = readFileSync(join(IOS, 'project.yml'), 'utf8');
  const problems = [];
  if (!/name:\s*AwesomeOfflineGames/.test(spec)) problems.push('project name missing');
  if (!/type:\s*application/.test(spec)) problems.push('target is not an application');
  if (!/path:\s*web\b/.test(spec)) problems.push('web/ folder reference missing');
  if (!/INFOPLIST_FILE:\s*Info\.plist/.test(spec)) problems.push('INFOPLIST_FILE not set');
  if (!/DEVELOPMENT_TEAM:\s*\$\{APPLE_TEAM_ID\}/.test(spec)) problems.push('team comes from the environment, not a hardcoded id');
  for (const p of ['Sources', 'Resources', 'Info.plist', 'ExportOptions.plist', 'web']) {
    if (!existsSync(join(IOS, p))) problems.push(`${p} missing on disk`);
  }
  const swiftFiles = readdirSync(join(IOS, 'Sources')).filter(f => f.endsWith('.swift'));
  for (const swift of swiftFiles) {
    const src = readFileSync(join(IOS, 'Sources', swift), 'utf8');
    if (src.length < 200 || !/import\s+(SwiftUI|WebKit|Foundation)/.test(src)) problems.push(`${swift} is not a real Swift source file`);
  }
  if (!swiftFiles.some(f => /@main/.test(readFileSync(join(IOS, 'Sources', f), 'utf8')))) problems.push('no @main entry point');
  if (!swiftFiles.some(f => /WKURLSchemeHandler/.test(readFileSync(join(IOS, 'Sources', f), 'utf8')))) problems.push('no WKURLSchemeHandler implementation');
  if (!swiftFiles.some(f => /setURLSchemeHandler/.test(readFileSync(join(IOS, 'Sources', f), 'utf8')))) problems.push('the scheme handler is never registered');
  if (problems.length) bad('XcodeGen spec + sources', problems.join('; '));
  else ok('XcodeGen spec + sources', `${readdirSync(join(IOS, 'Sources')).length} Swift files wired`);
} catch (e) {
  bad('XcodeGen spec + sources', String(e.message || e).split('\n')[0]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall iOS payload checks passed');
process.exit(failures ? 1 : 0);
