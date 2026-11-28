#!/usr/bin/env node
// Core rules test for the Asteroid's Revenge port. Slices the // >>>CORE block out of the
// SHIPPED page, so the rules proven here are the rules the browser runs: ram resolution,
// bullet damage, iron repair, wave clear, the wave-10 dread -> Earth -> win chain, plus a
// pilot ladder (idle never wins, a rammer can win, a pure dodger cannot).
//
// usage: node revenge-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';

const HTML = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/asteroid-s-revenge/index.html';
const src = await readFile(HTML, 'utf8');
const m = src.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + HTML); process.exit(2); }
const api = new Function(m[1] + `
return { CFG, setField, field: () => FIELD, makeState, startWave, addShip, addBullet, addIron,
         step, setup, waveTypes, waveCount };
`)();

const { CFG, setField, field, makeState, step, setup, waveCount } = api;
setField({ x0: -5.6, x1: 5.6, y0: -6.4, y1: 6.4 });
const FIELD = field();
const DT = 1 / 120;

let fails = 0, checks = 0;
function ok(cond, name, extra) {
  checks++;
  if (!cond) {
    fails++;
    console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  }
  return !!cond;
}
function run(S, seconds, input) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n && !S.over; i++) step(S, DT, input);
  return S;
}

// ---------------------------------------------------------------- structure
{
  const S = makeState(7);
  ok(S.wave === 1, 'starts on wave 1', S.wave);
  ok(S.hull === 100 && S.maxHull === 100, 'full hull at boot', S.hull);
  ok(S.over === false && S.won === false, 'live at boot');
  ok(S.queue.length === waveCount(1), 'wave 1 deals its fleet', { q: S.queue.length, want: waveCount(1) });
  ok(waveCount(1) === 4 && waveCount(9) === 9 && waveCount(10) === 3, 'wave sizes 4..9 then the boss trio',
    { w1: waveCount(1), w9: waveCount(9), w10: waveCount(10) });
  ok(S.earth.shield === true && S.earth.y > FIELD.y1, 'Earth sits behind its shield above the field', S.earth);
  const reach = S.earth.r * 0.86 + S.player.r;
  ok(S.earth.y - reach <= FIELD.y1 + 1.3, 'Earth is reachable from inside the field',
    { contactY: +(S.earth.y - reach).toFixed(2), maxY: +(FIELD.y1 + 1.3).toFixed(2) });
}

// ---------------------------------------------------------------- a ram is a kill and a cost
{
  const S = setup({ x: 0, y: 0, hull: 50, ships: [{ type: 'scout', x: 0, y: 0.08 }] });
  ok(S.hold === true, 'QA setup holds the wave door');
  run(S, 0.2, { tx: 0, ty: 0 });
  ok(S.kills === 1, 'ramming a scout destroys it', { kills: S.kills, ships: S.ships.length });
  ok(S.hull === 50 - CFG.ramCost.scout + CFG.ironHeal, 'the ram costs mass and its wreck repairs most of it',
    { hull: S.hull, cost: CFG.ramCost.scout, heal: CFG.ironHeal });
  ok(S.ramHits === 1 && S.player.rams === 1, 'ram counted once', { hits: S.ramHits });
  ok(S.score === CFG.worth.scout + Math.round(CFG.worth.scout * 0.25), 'score for the kill', S.score);
  ok(S.ironTaken === 1 && S.iron.length === 0, 'the wreck is absorbed under the asteroid', { taken: S.ironTaken, left: S.iron.length });
  ok(S.over === false, 'one ram does not end the run');

  // a wreck the asteroid flies past stays on the field until it is collected
  const S2 = setup({ x: -4, y: 0, ships: [{ type: 'scout', x: 4, y: 5.4 }] });
  api.addIron(S2, 4, 5.4, 1);
  step(S2, DT, null);
  ok(S2.iron.length === 1, 'a distant wreck waits to be collected', S2.iron.length);
}

// ---------------------------------------------------------------- shields need two rams
{
  const S = setup({ x: 0, y: 0, ships: [{ type: 'shield', x: 0, y: 0.1 }] });
  let guard = 0;
  while (!S.over && S.kills === 0 && guard++ < 2000) step(S, DT, { tx: 0, ty: 0.1 });
  ok(S.kills === 1 && S.ramHits === 2, 'a shielded hull takes two rams', { kills: S.kills, hits: S.ramHits });
  ok(S.hull === 100 - CFG.ramCost.shield * 2, 'both rams bill mass', { hull: S.hull });
}

// ---------------------------------------------------------------- lasers hurt, iframes hold
{
  const S = setup({ x: 0, y: 0, bullets: [{ x: 0.1, y: 0, vx: -2, vy: 0 }] });
  step(S, DT, null);
  ok(S.hull === 100 - CFG.bulletDmg, 'a laser costs 9 mass', S.hull);
  ok(S.iframes > 0, 'a hit grants grace', S.iframes);
  const before = S.hull;
  for (let i = 0; i < 30; i++) { api.addBullet(S, 0.1, 0, 0, 0, 0); step(S, DT, null); }
  ok(S.hull === before, 'grace absorbs the follow-up hits', { hull: S.hull, before });
}

// ---------------------------------------------------------------- iron repairs
{
  const S = setup({ hull: 50, x: 0, y: 0, iron: [{ x: 0.1, y: 0 }] });
  run(S, 0.2, { tx: 0, ty: 0 });
  ok(S.hull === 50 + CFG.ironHeal && S.ironTaken === 1, 'iron repairs 5 mass', { hull: S.hull, taken: S.ironTaken });
  const S2 = setup({ hull: 98, x: 0, y: 0, iron: [{ x: 0.1, y: 0 }] });
  run(S2, 0.2, { tx: 0, ty: 0 });
  ok(S2.hull === 100, 'repair never overfills the hull', S2.hull);
}

// ---------------------------------------------------------------- waves advance on a cleared queue
{
  const S = setup({ wave: 2, noQueue: true, hold: false, x: 0, y: 0 });
  const before = S.score;
  step(S, DT, null);
  ok(S.wave === 3, 'an empty wave advances', S.wave);
  ok(S.score === before + 60 + 2 * 20, 'clearing pays a wave bonus', S.score - before);
  const S2 = setup({ wave: 10, noQueue: true, hold: false, x: 0, y: 0 });
  step(S2, DT, null);
  ok(S2.wave === 10 && S2.over === false, 'wave 10 does not auto-clear — it ends on Earth', S2.wave);
}

// ---------------------------------------------------------------- the boss chain: dread -> shield down -> Earth
{
  const S = setup({ wave: 10, noQueue: true, x: 0, y: 0, ships: [{ type: 'dread', x: 0, y: 0.2, hp: 1 }] });
  step(S, DT, { tx: 0, ty: 0.2 });
  ok(S.kills === 1 && S.ships.length === 0, 'the dreadnought falls to a ram', { kills: S.kills });
  ok(S.earth.shield === false, 'killing the dread drops Earth\'s shield');
  ok(S.wave >= 10 && S.over === false, 'the run is still live with Earth open');
  const contactY = S.earth.y - S.earth.r * 0.86;
  let guard = 0;
  while (!S.over && guard++ < 4000) step(S, DT, { tx: 0, ty: contactY });
  ok(S.over === true && S.won === true, 'the last charge wins the run', { over: S.over, won: S.won, why: S.why });
  ok(S.why === 'earth', 'the win is recorded as the Earth hit', S.why);
}
{
  const S = setup({ wave: 10, noQueue: true, x: 0, y: 0 });
  let guard = 0;
  while (!S.over && guard++ < 2400) step(S, DT, { tx: 0, ty: S.earth.y - S.earth.r * 0.86 });
  ok(S.over === false && S.won === false, 'Earth is untouchable while its shield stands', { over: S.over, won: S.won });
}

// ---------------------------------------------------------------- a loss is a real loss
{
  const S = setup({ hull: 12, x: 0, y: 0, bullets: [{ x: 0, y: 0, vx: 0, vy: 0 }] });
  step(S, DT, null);
  ok(S.hull === 3 && S.over === false, 'a graze at 12 mass survives', { hull: S.hull, over: S.over });
  api.addBullet(S, 0, 0, 0, 0, 0);
  S.iframes = 0;
  step(S, DT, null);
  ok(S.over === true && S.won === false && S.hull === 0, 'hull zero ends the run as a loss', { hull: S.hull, over: S.over, why: S.why });
}

// ---------------------------------------------------------------- pilots
function dodge(S, tx, ty) {
  const p = S.player;
  let best = null, bt = 1e9;
  for (const b of S.bullets) {
    const rx = p.x - b.x, ry = p.y - b.y;
    const vv = b.vx * b.vx + b.vy * b.vy;
    if (vv < 1e-6) continue;
    const t = -(rx * b.vx + ry * b.vy) / vv;
    if (t < -0.05 || t > 1.15) continue;
    const cx = b.x + b.vx * t, cy = b.y + b.vy * t;
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (d < 1.0 && t < bt) { bt = t; best = b; }
  }
  if (!best) return { tx, ty };
  const m = Math.hypot(best.vx, best.vy) || 1;
  const px = -best.vy / m, py = best.vx / m;
  const side = ((p.x - best.x) * px + (p.y - best.y) * py) >= 0 ? 1 : -1;
  return { tx: p.x + px * side * 2.4, ty: p.y + py * side * 2.4 };
}
function pilot(S, mode) {
  const p = S.player;
  if (mode === 'idle') return null;
  if (mode === 'dodger') return dodge(S, p.x * 0.8, FIELD.y0 + 1.1);
  // rammer: hunt the nearest hull; once Earth is open, go for the planet
  let tx = p.tx, ty = p.ty;
  if (S.wave >= CFG.waveCap && !S.earth.shield) {
    tx = S.earth.x; ty = S.earth.y - S.earth.r * 0.86;
  } else {
    let best = null, bd = 1e9;
    for (const s of S.ships) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) { tx = best.x; ty = best.y; }
  }
  return dodge(S, tx, ty);
}
function ladder(mode, seeds, limit, cap) {
  let wins = 0, losses = 0, stuck = 0, waveSum = 0, hullSum = 0, oob = 0, nan = 0;
  const rows = [];
  for (let s = 1; s <= seeds; s++) {
    const S = makeState(s * 17 + 3);
    let t = 0, guard = 0;
    while (!S.over && t < limit && guard++ < 200000) { step(S, DT, pilot(S, mode)); t += DT; }
    if (S.won) wins++; else if (S.over) losses++; else stuck++;
    waveSum += S.wave; hullSum += Math.max(0, S.hull);
    if (mode === 'rammer' && s <= 6) rows.push({ seed: s * 17 + 3, wave: S.wave, won: S.won, t: +t.toFixed(1), hull: Math.round(S.hull), kills: S.kills });
    if (S.over) {
      for (const sh of S.ships) {
        if (!Number.isFinite(sh.x) || !Number.isFinite(sh.y)) nan++;
        if (sh.x < FIELD.x0 - 1.5 || sh.x > FIELD.x1 + 1.5) oob++;
      }
      if (!Number.isFinite(S.player.x) || !Number.isFinite(S.player.y)) nan++;
    }
  }
  void cap;
  return { mode, seeds, wins, losses, stuck, avgWave: +(waveSum / seeds).toFixed(1), avgHull: Math.round(hullSum / seeds), oob, nan, rows };
}

const idle = ladder('idle', 8, 150);
ok(idle.wins === 0, 'an idle asteroid never wins', idle);
ok(idle.losses === idle.seeds, 'an idle asteroid dies on every seed', idle);
console.log('ladder idle   ' + JSON.stringify({ wins: idle.wins, losses: idle.losses, stuck: idle.stuck, avgWave: idle.avgWave }));

const dodgeL = ladder('dodger', 10, 320);
ok(dodgeL.wins === 0, 'a pilot that never rams cannot win', dodgeL);
console.log('ladder dodger ' + JSON.stringify({ wins: dodgeL.wins, losses: dodgeL.losses, stuck: dodgeL.stuck, avgWave: dodgeL.avgWave }));

const ram = ladder('rammer', 24, 420);
console.log('ladder rammer ' + JSON.stringify({ wins: ram.wins, losses: ram.losses, stuck: ram.stuck, avgWave: ram.avgWave, avgHull: ram.avgHull }));
console.log('rammer seeds  ' + JSON.stringify(ram.rows));
ok(ram.wins >= 6, 'a competent rammer reaches Earth on at least a quarter of seeds', { wins: ram.wins, of: ram.seeds });
ok(ram.wins < ram.seeds, 'the ladder is not a rubber stamp', { wins: ram.wins, of: ram.seeds });
ok(ram.nan === 0, 'no NaN positions anywhere in the ladder', ram.nan);
ok(ram.oob === 0, 'no hull escapes the field', ram.oob);

// determinism: same seed, same first wave, same run
{
  const a = makeState(99), b = makeState(99);
  for (let i = 0; i < 600; i++) { step(a, DT, pilot(a, 'rammer')); step(b, DT, pilot(b, 'rammer')); }
  ok(a.wave === b.wave && Math.abs(a.hull - b.hull) < 1e-9 && a.kills === b.kills, 'a seed replays identically',
    { a: { w: a.wave, h: a.hull, k: a.kills }, b: { w: b.wave, h: b.hull, k: b.kills } });
}

console.log(JSON.stringify({ checks, fails }));
process.exit(fails ? 1 : 0);
