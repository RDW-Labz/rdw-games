#!/usr/bin/env node
/**
 * Static invariants for the collection — no browser, runs in under a second.
 * These are the checks that catch the boring failures: a catalog entry pointing at
 * a folder that does not exist, a game that secretly calls fetch(), a page that
 * loads its shared runtime from the wrong relative path, a stale generated catalog.
 *
 * Usage: node tests/smoke.mjs        exit 0 = all invariants hold
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const notes = [];
const ok = (label, cond, detail = '') => {
  if (cond) notes.push(`  ok   ${label}`);
  else fails.push(`${label}${detail ? ' — ' + detail : ''}`);
};

const read = p => readFileSync(join(ROOT, p), 'utf8');
const catalog = JSON.parse(read('catalog/games.json'));

/* ---------- 1. catalog integrity ---------- */
ok('catalog has 11 games', catalog.games.length === 11, `found ${catalog.games.length}`);
const ids = catalog.games.map(g => g.id);
ok('ids are unique', new Set(ids).size === ids.length);
const lanes = { port: 0, forge: 0, hybrid: 0 };
catalog.games.forEach(g => { lanes[g.lane] = (lanes[g.lane] || 0) + 1; });
ok('four originals + seven cross-hybrids, no clones',
  lanes.port === 0 && lanes.forge === 4 && lanes.hybrid === 7 && catalog.games.length === 11,
  JSON.stringify(lanes) + ' total=' + catalog.games.length);
ok('every game has a lane label', catalog.games.every(g => ['port', 'forge', 'hybrid'].includes(g.lane)));
ok('every game has a score', catalog.games.every(g => typeof g.score === 'number' && g.score > 0));
ok('ranks are 1..11', catalog.games.map(g => g.rank).sort((a, b) => a - b).join() === '1,2,3,4,5,6,7,8,9,10,11');
/* SCOPE-GATE decision 9: no cloned upstream build ships. The ports/ tree stays in the
 * repo as lineage paperwork (upstream URL, licence, pinned commit) for the assets the
 * hybrids borrow — so this check is what stops a clone quietly reappearing in the grid. */
ok('no clone ships as a title', catalog.games.every(g => g.lane !== 'port'));
ok('every game plays in the browser', catalog.games.every(g => g.delivery === 'bundled-web'));
ok('every original has a source folder', catalog.games.filter(g => g.lane === 'forge').every(g => existsSync(join(ROOT, 'games', g.id, 'index.html'))));
ok('every hybrid records its lineage', catalog.games.filter(g => g.lane === 'hybrid').every(g => !!g.hybrid_note && !!g.verified));
ok('source repo recorded', !!catalog.source_repo && !!catalog.source_commit);

/* ---------- 2. generated catalog matches source ---------- */
const gen = read('shell/lib/catalog.data.js');
const m = gen.match(/window\.AOMG_CATALOG = ([\s\S]*);\s*$/);
ok('catalog.data.js parses', !!m);
if (m) {
  let data = null;
  try { data = JSON.parse(m[1]); } catch { }
  ok('catalog.data.js matches catalog/games.json', JSON.stringify(data) === JSON.stringify(catalog),
    'run node tools/sync-catalog.mjs');
}

/* ---------- 3. no network calls in shipped code ---------- */
const offenders = [];
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json)$/.test(name)) out.push(p);
  }
  return out;
};
const shipped = [
  ...walk(join(ROOT, 'shell')),
  ...walk(join(ROOT, 'games')),
  join(ROOT, 'sw.js'),
];
const NET = /\b(fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource|navigator\.sendBeacon|import\s*\(|https?:\/\/(?!www\.w3\.org|github\.com|127\.0\.0\.1|localhost))/g;
for (const f of shipped) {
  const text = readFileSync(f, 'utf8');
  // sw.js is the offline cache itself: its fetch() only ever re-reads the same
  // origin into the cache. It is the one file allowed to contain the word.
  if (/\/sw\.js$/.test(f)) continue;
  // A file may declare that its fetches exist only to warm the offline cache. That is not a
  // play-time network call, but it must still never reach another origin.
  if (/AOMG-OFFLINE-CACHE-ONLY/.test(text)) {
    if (/https?:\/\/(?!www\.w3\.org)/.test(text)) offenders.push(`${f.replace(ROOT + '/', '')}: remote URL in cache-only file`);
    continue;
  }
  const hits = text.match(NET) || [];
  if (hits.length) offenders.push(`${f.replace(ROOT + '/', '')}: ${[...new Set(hits)].join(', ')}`);
}
ok('zero network calls in shell/ and games/', offenders.length === 0, offenders.slice(0, 6).join(' | '));

/* ---------- 4. script paths and boot surface ---------- */
const games = readdirSync(join(ROOT, 'games')).filter(d => statSync(join(ROOT, 'games', d)).isDirectory());
for (const id of games) {
  const page = join(ROOT, 'games', id, 'index.html');
  if (!existsSync(page)) { fails.push(`games/${id}/index.html missing`); continue; }
  const html = readFileSync(page, 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(x => x[1]);
  ok(`games/${id} loads gamekit from ../../shell/`, srcs.some(s => s === '../../shell/lib/gamekit.js'), srcs.join(', '));
  for (const s of srcs) {
    if (s.startsWith('http')) { fails.push(`games/${id} loads a remote script: ${s}`); continue; }
    const resolved = join(ROOT, 'games', id, s);
    ok(`games/${id} script resolves: ${s}`, existsSync(resolved), resolved);
  }
  ok(`games/${id} declares a viewport meta`, /name="viewport"/.test(html));
  const js = readdirSync(join(ROOT, 'games', id, 'js')).filter(f => f.endsWith('.js'));
  ok(`games/${id} has js`, js.length > 0);
  for (const f of js) {
    const code = readFileSync(join(ROOT, 'games', id, 'js', f), 'utf8');
    ok(`games/${id}/${f} exposes window.__game`, /window\.__game\s*=/.test(code));
    ok(`games/${id}/${f} has no leftover build marker`, !/__(PART|CHUNK)\d*__|<<CHUNK\d>>/.test(code),
      'truncation marker still present');
    ok(`games/${id}/${f} is a classic script`, !/^\s*(import|export)\s/m.test(code));
  }
}

/* ---------- 5. docs referenced by the shell exist ---------- */
for (const doc of ['docs/SCOPE-GATE.md', 'docs/INVENTORY.md', 'docs/HYBRIDIZATION.md', 'docs/QUALITY-BAR.md', 'docs/PROPOSED.md', 'LICENSE']) {
  ok(`${doc} exists`, existsSync(join(ROOT, doc)));
}

/* ---------- 6. offline install surface ---------- */
const swPath = join(ROOT, 'sw.js');
ok('service worker sits at the repo root', existsSync(swPath),
  'a worker under shell/ cannot intercept /games/ requests');
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, 'utf8');
  const listed = [...sw.matchAll(/'(\.\/[^']+)'/g)].map(m => m[1]);
  ok('service worker precaches every game page', games.every(id => listed.includes(`./games/${id}/index.html`)));
  ok('service worker precaches every game script', games.every(id => listed.includes(`./games/${id}/js/main.js`)));
  ok('service worker precaches the shell runtime', listed.includes('./shell/lib/gamekit.js') && listed.includes('./shell/app.js'));
  ok('service worker leaves /api/ live', /indexOf\('\/api\/'\)/.test(sw));
}
ok('manifest sits at the repo root', existsSync(join(ROOT, 'manifest.webmanifest')));
ok('root index.html exists for static hosting', existsSync(join(ROOT, 'index.html')));
if (existsSync(join(ROOT, 'manifest.webmanifest'))) {
  const man = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  ok('manifest scope covers the games', man.scope === '/', `scope=${man.scope}`);
  ok('manifest has an icon', Array.isArray(man.icons) && man.icons.length > 0);
}

/* ---------- report ---------- */
if (fails.length) {
  console.log(`\n✗ ${fails.length} invariant(s) broken:\n`);
  fails.forEach(f => console.log('  · ' + f));
  console.log(`\n${notes.length} checks passed, ${fails.length} failed.\n`);
  process.exit(1);
}
console.log(`✓ ${notes.length} invariants hold across ${catalog.games.length} titles, ${games.length} game folders.\n`);
