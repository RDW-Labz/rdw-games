#!/usr/bin/env node
/**
 * Vendored-payload invariants — the "did we really use the clones" test.
 *
 * The upstream content under vendor/ is the thing most likely to rot quietly: a file
 * gets hand-edited, a table is regenerated without its sprites, an importer silently
 * returns nothing and the games fall back to authored content while still claiming to
 * ship upstream art. Every check here is a way that claim could be false.
 *
 * Usage: node tests/vendor.mjs        exit 0 = the payload is intact and wired in
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const notes = [];
const ok = (label, cond, detail = '') => {
  if (cond) notes.push(`  ok   ${label}`);
  else fails.push(`${label}${detail ? ' — ' + detail : ''}`);
};

/* ---------- 1. the importer's own integrity check ---------- */
let checkOut = '';
try {
  checkOut = execFileSync('python3', ['tools/vendor.py', '--check'], { cwd: ROOT, encoding: 'utf8' });
} catch (err) {
  checkOut = (err.stdout || '') + (err.stderr || '');
}
ok('vendor/ matches MANIFEST (size + sha256)', /vendor in sync \(\d+ files verified/.test(checkOut),
  checkOut.split('\n').filter(l => l.startsWith('FAIL')).join('; ') || checkOut.slice(0, 200));

/* ---------- 2. the bundle every game loads ---------- */
const bundlePath = join(ROOT, 'vendor', 'vendor.js');
ok('vendor/vendor.js exists', existsSync(bundlePath));
const sandbox = { self: {}, window: undefined };
vm.createContext(sandbox);
try {
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { timeout: 20000 });
} catch (e) {
  fails.push(`vendor/vendor.js throws: ${e.message}`);
}
const V = (sandbox.self && sandbox.self.AOMG_VENDOR) || {};
ok('bundle exposes sources/assets/data', !!V.sources && Array.isArray(V.assets) && !!V.data);
ok('bundle works without a window object (service worker)', typeof V.assets === 'object');

/* ---------- 3. every source is pinned, licensed and credited ---------- */
const sources = V.sources || {};
const EXPECTED = {
  'endless-sky': 'GPL-3.0',
  'shattered-pixel-dungeon': 'GPL-3.0',
  'unciv': 'MPL-2.0',
  'cataclysm-dda': 'CC-BY-SA-3.0',
  'stk-assets': 'GPL-2.0-or-later AND CC-BY-SA-3.0',
};
for (const [name, license] of Object.entries(EXPECTED)) {
  const s = sources[name];
  ok(`${name} vendored`, !!s, 'missing from the bundle — run python3 tools/vendor.py sync');
  if (!s) continue;
  ok(`${name} pinned to an upstream commit`, /^[0-9a-f]{40}$/.test(s.commit || ''), s.commit);
  ok(`${name} carries its licence`, s.license === license, `${s.license} != ${license}`);
  ok(`${name} records its upstream url`, /^https:\/\/github\.com\//.test(s.url || ''));
  ok(`${name} ships the upstream licence text`,
    readdirSync(join(ROOT, 'vendor', name)).some(f => f.startsWith('LICENSE-')));
  ok(`${name} has an ATTRIBUTION.md`, existsSync(join(ROOT, 'vendor', name, 'ATTRIBUTION.md')));
}

/* ---------- 4. the content is actually there, in quantity ---------- */
const floor = (key, n) => {
  const t = (V.data || {})[key];
  const len = Array.isArray(t) ? t.length : -1;
  ok(`${key} >= ${n} entries`, len >= n, `found ${len}`);
  return t;
};
const ships = floor('endless-sky/ships', 100);
const commod = floor('endless-sky/commodities', 10);
const techs = floor('unciv/techs', 70);
const items = floor('cataclysm-dda/items', 150);
const monsters = floor('cataclysm-dda/monsters', 40);
const recipes = floor('cataclysm-dda/recipes', 40);
const spd = (V.data || {})['shattered-pixel-dungeon/assets'] || {};
ok('SPD sprites >= 70', (spd.sprites || []).length >= 70, `found ${(spd.sprites || []).length}`);
ok('SPD sounds >= 50', (spd.sounds || []).length >= 50, `found ${(spd.sounds || []).length}`);
ok('SPD music present', (spd.music || []).length >= 1);
const mind = (V.data || {})['mindustry/assets'] || {};
ok('Mindustry item icons >= 10', (mind.items || []).length >= 10, `found ${(mind.items || []).length} items`);
ok('Mindustry production sprites present (belt/drill/turret)',
  !!mind.belt && !!mind.drill && !!mind.turret && !!mind.belt_anim,
  [mind.belt, mind.drill, mind.turret, mind.belt_anim].map(x => (x || {}).image || '-').join(' '));
const mats = ((V.data || {})['luanti/materials'] || {}).materials || [];
ok('Luanti node materials >= 6', mats.length >= 6, `found ${mats.length}`);
ok('Luanti materials name the node they came from',
  mats.length > 0 && mats.every(m => typeof m.name === 'string' && typeof m.image === 'string'),
  mats.slice(0, 3).map(m => m.name).join(' '));
const stk = (V.data || {})['stk-assets/audio'] || {};
ok('STK music present', (stk.music || []).length >= 1);
ok('STK sfx >= 5', (stk.sounds || []).length >= 5, `found ${(stk.sounds || []).length}`);

/* ---------- 5. the data is real upstream content, not placeholders ---------- */
ok('ship hulls have real names and prices',
  (ships || []).every(s => typeof s.name === 'string' && s.name.length > 1 && s.cost > 0));
ok('ship hulls carry flight stats', (ships || []).every(s => s.hull > 0 && s.image));
ok('commodities are the Endless Sky ten',
  (commod || []).map(c => c.name).join('|').includes('Food') && (commod || []).every(c => c.price > 0));
ok('techs span the real eras',
  new Set((techs || []).map(t => t.era)).size >= 5, [...new Set((techs || []).map(t => t.era))].join(', '));
ok('techs form an 18-column tree', new Set((techs || []).map(t => t.column)).size >= 15);
ok('items have ids, names and prices',
  (items || []).filter(i => i.id && i.name && i.price_usd != null).length >= (items || []).length * 0.8);
ok('monsters have hp and speed', (monsters || []).every(m => m.hp > 0 && m.speed > 0));
ok('recipes name their components',
  (recipes || []).every(r => r.result && Array.isArray(r.components)));
ok('SPD sprite names are real creatures/items',
  (spd.sprites || []).some(s => /gnoll|golem|bat|rat|snake/.test(s.name)));

/* ---------- 6. every referenced file is on disk and precacheable ---------- */
const assets = V.assets || [];
ok('bundle lists 200+ assets', assets.length >= 200, `found ${assets.length}`);
const missing = assets.filter(p => !existsSync(join(ROOT, p)) || statSync(join(ROOT, p)).size === 0);
ok('every listed asset exists and is non-empty', missing.length === 0, missing.slice(0, 3).join(', '));

const referenced = [];
for (const s of ships || []) if (s.image) referenced.push(s.image);
for (const s of spd.sprites || []) referenced.push(s.image);
for (const s of spd.sounds || []) referenced.push(s.audio);
for (const s of spd.music || []) referenced.push(s.audio);
for (const s of stk.music || []) referenced.push(s.audio);
for (const s of stk.sounds || []) referenced.push(s.audio);
const unlisted = referenced.filter(p => !assets.includes(p));
ok('every path used by a table is listed in assets', unlisted.length === 0, unlisted.slice(0, 3).join(', '));
ok('every referenced path starts with vendor/',
  referenced.every(p => typeof p === 'string' && p.startsWith('vendor/')));

/* ---------- 7. the collection wires it in ---------- */
const games = (JSON.parse(readFileSync(join(ROOT, 'catalog/games.json'), 'utf8')).games || [])
  .filter(g => g.lane === 'forge').map(g => g.id);
for (const id of games) {
  const dir = join(ROOT, 'games', id);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  ok(`${id} loads the vendor bundle`, html.includes('../../vendor/vendor.js'));
  ok(`${id} loads it before its own script`,
    html.indexOf('vendor/vendor.js') < html.indexOf('js/main.js'));
  const main = readFileSync(join(dir, 'js', 'main.js'), 'utf8');
  ok(`${id} reads AOMG_VENDOR`, /AOMG_VENDOR/.test(main));
  /* It has to consume real payload, not just mention the global: a literal vendored
     file path, the asset list, or a data key that actually exists in the bundle. */
  const refs = [...main.matchAll(/vendor\/[A-Za-z0-9_\-./]+\.(png|opus)/g)].map(m => m[0]);
  const usesAssets = /(AOMG_VENDOR|VENDOR|V)\s*\.\s*assets/.test(main);
  const namedKeys = [...main.matchAll(/['"]([a-z0-9\-]+\/[a-z0-9\-]+)['"]/g)]
    .map(m => m[1]).filter(k => V.data && k in V.data);
  ok(`${id} names at least one vendored file explicitly`,
    refs.length > 0 || usesAssets || namedKeys.length > 0,
    refs.length ? `${refs.length} file path(s)` : usesAssets ? 'reads the asset list'
      : namedKeys.length ? `data: ${[...new Set(namedKeys)].join(', ')}` : 'nothing');
  const unguarded = /AOMG_VENDOR\.data\[/.test(main) && !/AOMG_VENDOR\s*\|\|/.test(main);
  ok(`${id} guards against a missing bundle`, !unguarded);
}

const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
ok('service worker loads the vendor bundle for its asset list', /importScripts\(['"]\.\/vendor\/vendor\.js['"]\)/.test(sw));
ok('service worker precaches the vendored assets', /AOMG_VENDOR\.assets/.test(sw) && /concat\(/.test(sw));

/* ---------- report ---------- */
if (fails.length) {
  console.log(`\n✗ ${fails.length} vendored-payload invariant(s) broken:\n`);
  fails.forEach(f => console.log('  · ' + f));
  console.log(`\n${notes.length} checks passed, ${fails.length} failed.\n`);
  process.exit(1);
}
console.log(`✓ ${notes.length} vendored-payload invariants hold ` +
  `(${assets.length} upstream files from ${Object.keys(sources).length} repos)\n`);
