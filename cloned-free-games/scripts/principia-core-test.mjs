#!/usr/bin/env node
// Rules test for the Principia port. Slices the // >>>CORE block out of the SHIPPED page and imports
// it, so the browser and this test run the same code. Sweeps the beam angles of every rig to prove it
// is solvable, refuses a rig where nothing wins, and boces the found solutions to
// .queue/principia-solutions.json so the interaction gate plays a build that is known to work.
//
// usage: node scripts/principia-core-test.mjs [path/to/index.html]
import { readFile, writeFile } from 'node:fs/promises';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/principia/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/principia-solutions.json';
const html = await readFile(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + FILE); process.exit(2); }
const exports = ['D2R', 'STEP', 'G', 'R', 'FLOOR_Y', 'PIT_DEPTH', 'LIMIT_T', 'LEVELS',
  'furniture', 'leverBox', 'knobAt', 'mkState', 'contact', 'step', 'simulate', 'inPit'];
const src = m[1] + `\nexport { ${exports.join(', ')} };\n`;
const C = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const { LEVELS, mkState, step, simulate, STEP, FLOOR_Y, PIT_DEPTH, R } = C;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};

// ---- 1) the rigs are well formed ----
{
  ok(LEVELS.length >= 5, 'fewer than five rigs ship', LEVELS.length);
  LEVELS.forEach((L, i) => {
    ok(!!L.name && !!L.hint, `rig ${i + 1} has no name/hint`, L.name);
    ok(L.levers.length >= 1 && L.levers.length <= 2, `rig ${i + 1} has an odd number of beams`, L.levers.length);
    ok(L.spawn.y > 1.5, `rig ${i + 1} spawns too low to fall`, L.spawn.y);
    ok(L.pit.x > 3 && L.pit.x < 6.4, `rig ${i + 1} pit is off the bench`, L.pit.x);
    L.levers.forEach((lv, k) => {
      ok(lv.lo < lv.def && lv.def < lv.hi, `rig ${i + 1} beam ${k + 1} default is outside its travel`, lv);
      ok(lv.hi - lv.lo >= 60, `rig ${i + 1} beam ${k + 1} barely moves`, lv.hi - lv.lo);
    });
  });
}

// ---- 2) a fresh state is a live bench, and the marble does not move by itself ----
{
  const S = mkState(0, null);
  ok(S.mode === 'build', 'a new rig does not open in build mode', S.mode);
  ok(S.over === false && S.result === '', 'a new rig opens already over', S.result);
  const x0 = S.ball.x, y0 = S.ball.y;
  for (let i = 0; i < 240; i++) step(S, STEP);
  ok(S.ball.x === x0 && S.ball.y === y0, 'the marble moves before Run is pressed', [S.ball.x, S.ball.y]);
  ok(S.boxes.filter((b) => b.tag === 'lever').length === S.L.levers.length, 'the beams are not in the collision set');
  ok(S.boxes.some((b) => b.tag === 'pit') && S.boxes.some((b) => b.tag === 'floor'), 'the bench furniture is missing');
}

// ---- 3) determinism: the same angles give the same run, twice ----
{
  const a = simulate(1, [-40]);
  const b = simulate(1, [-40]);
  ok(a.result === b.result && a.t === b.t && a.x === b.x, 'two identical runs disagree', [a, b]);
}

// ---- 4) the sweep: every rig has beam angles that land the marble ----
const coarse = (lo, hi, step) => {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v));
  return out;
};
const sols = {};
for (let i = 0; i < LEVELS.length; i++) {
  const L = LEVELS[i];
  const axis = L.levers.map((lv) => coarse(lv.lo + 2, lv.hi - 2, L.levers.length > 1 ? 7 : 5));
  let wins = 0, total = 0, best = null;
  const walk = (k, acc) => {
    if (k === axis.length) {
      total++;
      const r = simulate(i, acc);
      if (r.result === 'win') { wins++; if (!best || r.t < best.t) best = { angles: acc.slice(), t: r.t }; }
      return;
    }
    for (const v of axis[k]) { acc.push(v); walk(k + 1, acc); acc.pop(); }
  };
  walk(0, []);
  const rate = wins / total;
  console.log(`rig ${i + 1} ${L.name}: ${wins}/${total} winning angle sets (${(rate * 100).toFixed(1)}%)` +
    (best ? ` — best ${JSON.stringify(best.angles)} in ${best.t}s` : ' — UNSOLVED'));
  ok(wins > 0, `rig ${i + 1} (${L.name}) cannot be solved at any beam angle`, { axis, total });
  ok(rate < 0.85, `rig ${i + 1} (${L.name}) wins at almost any angle — it is not a puzzle`, { rate });
  sols[i + 1] = best ? best.angles : null;
}

// ---- 5) the default rig is not already a win (the visitor has something to do) ----
{
  let defaults = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    const r = simulate(i, null);
    if (r.result === 'win') defaults++;
  }
  ok(defaults === 0, 'a rig is already solved by its default angle', { defaults });
}

// ---- 6) a marble that is dropped with nowhere to go loses, and says why ----
{
  const r = simulate(0, [-88]);
  ok(r.result === 'lose', 'the marble wins even with the beam pointing at the floor', r);
  ok(['rest', 'void', 'timeout'].includes(r.cause), 'the loss has no cause', r.cause);
}

// ---- 7) the pit is the only win, and the marble really ends below the floor line ----
{
  const r = simulate(0, sols[1] || [-40]);
  ok(r.result === 'win' && r.cause === 'pit', 'the baked solution does not win', r);
  ok(r.y <= FLOOR_Y - 0.5, 'a win without the marble below the floor line', r.y);
}

// ---- 8) every solution is reproducible and inside the beams' travel ----
{
  for (let i = 0; i < LEVELS.length; i++) {
    const a = sols[i + 1];
    if (!ok(Array.isArray(a), `rig ${i + 1} has no baked solution`, a)) continue;
    const r = simulate(i, a);
    ok(r.result === 'win', `rig ${i + 1} baked solution does not win when replayed`, { a, r });
    const S = mkState(i, a);
    a.forEach((deg, k) => {
      const lv = LEVELS[i].levers[k];
      ok(deg >= lv.lo && deg <= lv.hi, `rig ${i + 1} beam ${k + 1} solution is outside travel`, { deg, lv });
    });
    ok(S.angles.length === a.length, 'beam count drifted between state and solution');
  }
}

const payload = { generated: new Date().toISOString(), file: FILE, solutions: sols };
await writeFile(OUT, JSON.stringify(payload, null, 1) + '\n');
console.log('\nsolutions -> ' + OUT + '\n' + JSON.stringify(sols));
console.log(fails ? `\nFAIL: ${fails} core assertion(s)` : '\nPASS — every rig is solvable and the rules hold');
process.exit(fails ? 1 : 0);
