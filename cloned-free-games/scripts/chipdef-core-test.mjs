#!/usr/bin/env node
// Chip Defense core test — slices the // >>>CORE block out of the shipped page and runs
// the exact rules the browser runs. Proves geometry, economy, targeting, slow, leaks,
// and that the 12-wave run is neither free (passive loses) nor unwinnable (a greedy
// builder wins).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE = join(process.env.HOME, 'kaos/work/site/games/arcade/chip-defense/index.html');
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('// >>>CORE');
const b = html.indexOf('// <<<CORE');
if (a < 0 || b < 0) { console.error('FAIL: no CORE block'); process.exit(1); }
const core = html.slice(a + '// >>>CORE'.length, b);

const dir = mkdtempSync(join(tmpdir(), 'chipdef-core-'));
const mod = join(dir, 'core.mjs');
writeFileSync(mod,
  core + '\nexport { W, H, CORE_CELL, WAYPOINTS, PATHS, PATH_LEN, TRACK, isTrack, isSlot, TOWER_KINDS, ENEMY_KINDS, WAVES, GAP, START_BITS, INTEGRITY, INTERMISSION, hpScale, waveSpawns, newState, startWave, posAt, pickTarget, hurt, canPlace, place, upgrade, upgradeCost, step };\n');
const C = await import(pathToFileURL(mod).href);

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

// ---- 1. geometry ----
for (let pi = 0; pi < C.PATHS.length; pi++) {
  const p = C.PATHS[pi];
  let orth = true;
  for (let i = 1; i < p.length; i++) {
    const dc = Math.abs(p[i][0] - p[i - 1][0]), dr = Math.abs(p[i][1] - p[i - 1][1]);
    if (dc + dr !== 1) orth = false;
  }
  ok(orth, `path ${pi} is an orthogonal walk`);
  ok(p[p.length - 1][0] === C.CORE_CELL.c && p[p.length - 1][1] === C.CORE_CELL.r, `path ${pi} ends on the core`);
  ok(C.PATH_LEN[pi] === p.length - 1, `path ${pi} length is its step count`);
}
ok(!C.isSlot(C.CORE_CELL.c, C.CORE_CELL.r), 'core cell is not a socket');
ok(!C.isSlot(-1, 1) && !C.isSlot(12, 1) && !C.isSlot(0, 99), 'off-board cells are not sockets');
ok(C.isSlot(0, 0), 'an ordinary cell is a socket');
ok(C.isTrack(...C.PATHS[0][0]) && C.isTrack(...C.PATHS[1][0]), 'both lane starts are track');
// the two lanes share a merged suffix
const tailA = C.PATHS[0].slice(-7).map(x => x.join(','));
const tailB = C.PATHS[1].slice(-7).map(x => x.join(','));
ok(JSON.stringify(tailA) === JSON.stringify(tailB), 'lanes merge into one shared tail');
// slot count sanity: the die must be mostly buildable
let slots = 0;
for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) if (C.isSlot(c, r)) slots++;
ok(slots > 60, 'plenty of sockets', { slots });

// ---- 2. waves ----
const seen = new Set();
for (let i = 0; i < C.WAVES.length; i++) {
  const sp = C.waveSpawns(i);
  ok(sp.length > 0, `wave ${i} has spawns`);
  ok(sp.every(s => s.path === 0 || s.path === 1), `wave ${i} lanes are 0/1`);
  ok(sp.every(s => C.ENEMY_KINDS[s.kind]), `wave ${i} kinds exist`);
  for (let k = 1; k < sp.length; k++) ok(sp[k].at >= sp[k - 1].at, `wave ${i} spawn times sorted`);
  for (const s of sp) seen.add(s.kind);
}
ok(seen.size === 3, 'all three unit kinds appear across the run');
ok(C.WAVES.length === 12, '12 waves');

// ---- 3. no-tower run leaks and loses ----
function runPassive(limit = 900) {
  const S = C.newState();
  C.startWave(S, 0);
  let t = 0;
  while (t < limit && !S.over) { C.step(S, 1 / 60); t += 1 / 60; }
  return { S, t };
}
const passive = runPassive();
ok(passive.S.over && passive.S.result === 'lose', 'a passive die loses', { r: passive.S.result, integ: passive.S.integrity });
ok(passive.S.integrity === 0, 'passive loss drains the core to zero');
ok(passive.S.kills === 0, 'no towers means no kills', { kills: passive.S.kills });
ok(passive.S.leaks >= 5, 'several units leak before the core dies', { leaks: passive.S.leaks });
ok(passive.S.wave <= 4, 'a passive die does not coast deep into the run', { wave: passive.S.wave + 1 });

// ---- 4. the opening purse covers both lanes; nothing leaks in wave one ----
{
  const S = C.newState();
  S.bits = C.START_BITS;
  // the game alternates lanes, so two gates per entrance is what a starting purse buys
  for (let pi = 0; pi < C.PATHS.length; pi++) {
    const [c0, r0] = C.PATHS[pi][3];
    for (let pass = 0; pass < 2; pass++) {
      let near = null;
      for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) {
        if (!C.canPlace(S, c, r)) continue;
        const d = Math.hypot(c - c0, r - r0);
        if (d <= C.TOWER_KINDS.sub.range && (!near || d < near.d)) near = { c, r, d };
      }
      ok(near && C.place(S, near.c, near.r, 'sub'), `gate fits beside lane ${pi}`, { pass });
    }
  }
  ok(S.towers.length === 4, 'the starting purse buys four gates', { towers: S.towers.length });
  ok(S.bits >= 0, 'the opening build is affordable', { bits: S.bits });

  C.startWave(S, 0);
  // stop the moment the first wave is cleared, so later waves cannot muddy the count
  let effKills = 0, effLeaks = 0, effInteg = 0;
  for (let i = 0; i < 60 * 40; i++) {
    C.step(S, 1 / 60);
    if (S.clearing || S.wave > 0 || S.over) { effKills = S.kills; effLeaks = S.leaks; effInteg = S.integrity; break; }
  }
  ok(effKills >= 4, 'the opening wave is cleared', { kills: effKills });
  ok(effLeaks === 0, 'nothing leaks in wave one', { leaks: effLeaks, integrity: effInteg });
}

// ---- 5. SHR halves travel (isolated: a very tough unit so no kill confuses the read) ----
{
  const run = (kind) => {
    const S = C.newState(); S.bits = 500; S.wave = 0;
    const [c0, r0] = C.PATHS[0][8];
    let best = null;
    for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) {
      if (!C.isSlot(c, r)) continue;
      const d = Math.hypot(c - c0, r - r0);
      if (d <= C.TOWER_KINDS[kind].range && (!best || d < best.d)) best = { c, r, d };
    }
    ok(!!best, `a socket exists in ${kind} range of mid-lane`, { c0, r0 });
    C.place(S, best.c, best.r, kind);
    // park one unit comfortably inside that range with far more hp than the tower can chew
    S.enemies.push({ id: 1, kind: 'byte', path: 0, d: 7.4, hp: 1e6, maxHp: 1e6, slowMul: 1, slowT: 0, dead: false });
    for (let i = 0; i < 120; i++) C.step(S, 1 / 60);   // 2 s
    return S.enemies[0];
  };
  const slowed = run('shr');
  const plain = run('mem');   // heavy hitter, no slow effect
  ok(slowed && plain, 'the parked unit stays on the board');
  if (slowed && plain) {
    ok(slowed.slowMul === C.TOWER_KINDS.shr.slow, 'the SHR hit applies its slow multiplier', { mul: slowed.slowMul });
    ok((slowed.d - 7.4) < (plain.d - 7.4) * 0.75, 'a slowed unit covers less lane in the same time', { slow: slowed.d - 7.4, plain: plain.d - 7.4 });
  }
}

// ---- 6. a greedy builder survives all 12 waves ----
function coverage(c, r, range) {
  let n = 0;
  for (const p of C.PATHS) for (const [pc, pr] of p) if (Math.hypot(pc - c, pr - r) <= range) n++;
  return n;
}
function bestSlot(S, range) {
  let best = null;
  for (let r = 0; r < C.H; r++) for (let c = 0; c < C.W; c++) {
    if (!C.canPlace(S, c, r)) continue;
    const v = coverage(c, r, range);
    if (!best || v > best.v) best = { c, r, v };
  }
  return best;
}
function bot(S, cap = Infinity) {
  // upgrade what is built when flush; otherwise build the best-covered socket
  const ups = S.towers.filter(t => t.lvl < 3).sort((x, y) => C.upgradeCost(x) - C.upgradeCost(y));
  if (ups.length && S.bits > C.upgradeCost(ups[0]) + 25) { C.upgrade(S, ups[0].c, ups[0].r); return; }
  if (S.towers.length >= cap) return;
  const kind = S.bits >= C.TOWER_KINDS.acc.cost + 15 ? 'acc' : S.bits >= C.TOWER_KINDS.mem.cost + 10 ? 'mem' : 'sub';
  const slot = bestSlot(S, C.TOWER_KINDS[kind].range);
  if (slot) C.place(S, slot.c, slot.r, kind);
}
function runBot() {
  const S = C.newState();
  C.startWave(S, 0);
  let t = 0;
  while (t < 2000 && !S.over) {
    bot(S);
    for (let i = 0; i < 15 && !S.over; i++) C.step(S, 1 / 60);
    t += 15 / 60;
  }
  return { S, t };
}
const botRun = runBot();
ok(botRun.S.over && botRun.S.result === 'win', 'a greedy builder wins the run',
  { r: botRun.S.result, wave: botRun.S.wave + 1, integ: botRun.S.integrity, bits: Math.floor(botRun.S.bits), towers: botRun.S.towers.length, t: Math.round(botRun.t) });
ok(botRun.S.integrity > 0, 'the winner keeps core integrity');
ok(botRun.S.kills > 60, 'the winner actually clears units', { kills: botRun.S.kills });

// a builder capped at six gates (still upgrading them) must not coast — the late waves have teeth
{
  const S = C.newState();
  C.startWave(S, 0);
  let t = 0;
  while (t < 1200 && !S.over) {
    bot(S, 6);
    for (let i = 0; i < 15 && !S.over; i++) C.step(S, 1 / 60);
    t += 15 / 60;
  }
  ok(S.over && S.result === 'lose', 'a six-gate die loses before the end',
    { r: S.result, wave: S.wave + 1, integ: S.integrity, towers: S.towers.length });
  ok(S.wave >= 8, 'the six-gate die gets deep before it falls', { wave: S.wave + 1 });
}

// a bot that builds nothing but also never starts the wave must not "win" by idling
{
  const S = C.newState();
  C.startWave(S, 0);
  for (let i = 0; i < 60 * 240; i++) C.step(S, 1 / 60);
  ok(S.over && S.result === 'lose', 'an idle die never wins');
}

console.log(`\n${fails ? 'FAILED' : 'PASS'} — ${checks - fails}/${checks} checks`);
if (botRun.S.over) {
  console.log(`bot run: wave ${botRun.S.wave + 1}/${C.WAVES.length}, ${botRun.S.result}, core ${botRun.S.integrity}, kills ${botRun.S.kills}, leaks ${botRun.S.leaks}, towers ${botRun.S.towers.length}, bits left ${Math.floor(botRun.S.bits)}, ${Math.round(botRun.t)}s`);
}
process.exit(fails ? 1 : 0);
