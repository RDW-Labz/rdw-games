#!/usr/bin/env node
// Core rules test for the Destination Sol port. Slices the // >>>CORE block out of the SHIPPED
// page, so the rules proven here are the rules the browser runs: gun damage against rock hulls,
// ore drop -> magnet -> hold capacity, the station pad's payday (and its refusal to pay for an
// empty hold), pirate fire, rock ramming, wave advance, the jump-at-goal win, hull-zero loss,
// determinism, and a pilot ladder (an idle ship never earns a credit; a miner does; a hauler that
// never fires never does).
//
// usage: node destinationsol-core-test.mjs [path/to/index.html]
import { readFile } from 'node:fs/promises';

const HTML = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/destination-sol/index.html';
const src = await readFile(HTML, 'utf8');
const m = src.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in ' + HTML); process.exit(2); }
const api = new Function(m[1] + `
return { CFG, ROCK, setField, field: () => FIELD, makeState, startWave, addRock: spawnRock, addPirate,
         addBullet, addOre, addFx, step, setup, cargoTotal, shipSpeed, wavePirates, pirateHp };
`)();

const { CFG, ROCK, setField, field, makeState, step, setup, cargoTotal, shipSpeed } = api;
setField({ x0: -6.4, x1: 6.4, z0: -5.4, z1: 5.4 });
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
const angleDiff = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// ---------------------------------------------------------------- structure
{
  const S = makeState(7);
  ok(S.wave === 1, 'starts on wave 1', S.wave);
  ok(S.hull === 100 && S.maxHull === 100, 'full hull at boot', S.hull);
  ok(S.over === false && S.won === false && S.credits === 0, 'live and broke at boot');
  ok(S.rocks.length === CFG.rockCount, 'the belt boots full of rocks', S.rocks.length);
  ok(S.queue.length === api.wavePirates(1), 'wave 1 queues its pirates', { q: S.queue.length, want: api.wavePirates(1) });
  ok(api.wavePirates(1) === 2 && api.wavePirates(6) === 8, 'waves add pirates', { w1: api.wavePirates(1), w6: api.wavePirates(6) });
  ok(api.pirateHp(1) === 2 && api.pirateHp(9) === 6, 'pirates get tougher every two waves', { w1: api.pirateHp(1), w9: api.pirateHp(9) });
  ok(Math.hypot(S.station.x, S.station.z) === 0 && S.station.r === CFG.dockR, 'the station sits at the middle of the belt', S.station);
  const clear = S.rocks.every((r) => Math.hypot(r.x - S.station.x, r.z - S.station.z) > S.station.r + r.r);
  ok(clear, 'no rock spawns on the dock ring', S.rocks.map((r) => +Math.hypot(r.x, r.z).toFixed(2)));
  const inField = S.rocks.every((r) => r.x > FIELD.x0 && r.x < FIELD.x1 && r.z > FIELD.z0 && r.z < FIELD.z1);
  ok(inField, 'every rock spawns inside the belt');
}

// ---------------------------------------------------------------- the gun carves a rock
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 },
    rocks: [{ kind: 'iron', x: 4, z: 0 }] });
  const rock = S.rocks[0];
  ok(rock.hp === ROCK.iron.hp, 'an iron rock reads its hull strength', rock.hp);
  run(S, 0.05, { thrust: 0, turn: 0, fire: true });
  ok(S.bullets.length === 1, 'a trigger pull is one round', S.bullets.length);
  run(S, 0.5, { thrust: 0, turn: 0, fire: false });
  ok(rock.hp === ROCK.iron.hp - 1, 'the volley lands as one hit', { hp: rock.hp, shots: S.shots });
  let guard = 0;
  while (S.mined === 0 && guard++ < 900) step(S, DT, { thrust: 0, turn: 0, fire: true });
  ok(S.rocks.length === 0 && S.mined === 1, 'enough hits break the rock', { rocks: S.rocks.length, mined: S.mined });
  ok(S.ore.length === ROCK.iron.drop, 'a broken rock drops its ore', S.ore.length);
  ok(S.ore.every((o) => o.kind === 'iron'), 'the drop carries the rock kind');
  ok(S.credits === 0, 'breaking a rock pays nothing until it is sold', S.credits);
}

// ---------------------------------------------------------------- ore flies to the ship, the hold is finite
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0 }, ore: [{ x: 1.2, z: 0.2 }] });
  run(S, 0.6, { thrust: 0, turn: 0, fire: false });
  ok(S.picked === 1 && cargoTotal(S) === 1 && S.ore.length === 0, 'ore inside the magnet flies in', { picked: S.picked });
  ok(S.cargo.iron === 1, 'the hold records the kind', S.cargo);

  const full = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0 },
    cargo: { iron: CFG.cargoCap }, ore: [{ x: 1.0, z: 0 }] });
  run(full, 0.7, { thrust: 0, turn: 0, fire: false });
  ok(cargoTotal(full) === CFG.cargoCap && full.ore.length === 1, 'a full hold leaves ore in space', { total: cargoTotal(full), ore: full.ore.length });
}

// ---------------------------------------------------------------- the pad is the only payday
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, hull: 40,
    player: { x: 0.6, z: 0.6, vx: 0, vz: 0 }, cargo: { iron: 4, gold: 2, crystal: 1 } });
  const want = 4 * CFG.oreValue.iron + 2 * CFG.oreValue.gold + CFG.oreValue.crystal;
  run(S, 1.4, { thrust: 0, turn: 0, fire: false });
  ok(S.credits === want, 'the pad pays the ore table exactly', { credits: S.credits, want });
  ok(cargoTotal(S) === 0 && S.sold === 7 && S.trips === 1, 'the sale empties the hold once', { sold: S.sold, trips: S.trips });
  ok(S.hull === Math.min(S.maxHull, 40 + CFG.repair), 'the pad patches the hull, up to its limit', S.hull);
  ok(S.over === false, 'a mid-run sale does not end the run');
}
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0.5, z: 0.4 }, credits: 100 });
  run(S, 2.0, { thrust: 0, turn: 0, fire: false });
  ok(S.credits === 100, 'an empty hold docks for free and pays nothing', S.credits);
  ok(S.dockIdle >= 1, 'the pad still registers the touch-down', S.dockIdle);
}
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0.4, z: 0.4 },
    cargo: { iron: 2 }, player2: null });
  S.player.vx = 5.6;      // too hot to dock
  run(S, 0.25, { thrust: 0, turn: 0, fire: false });
  ok(S.credits === 0 || S.dockT === 0, 'a fast pass through the ring does not dock', { credits: S.credits, dockT: S.dockT });
}

// ---------------------------------------------------------------- the win is a sold hold
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, credits: CFG.goal - CFG.oreValue.crystal,
    player: { x: 0.4, z: 0.4 }, cargo: { crystal: 1 } });
  run(S, 1.4, { thrust: 0, turn: 0, fire: false });
  ok(S.credits >= CFG.goal, 'the hold crosses the goal', S.credits);
  ok(S.over === true && S.won === true && S.why === 'jump', 'the goal buys the jump', { over: S.over, won: S.won, why: S.why });
}

// ---------------------------------------------------------------- pirates: bounty, fire, ramming
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 },
    pirates: [{ x: 3, z: 0, hp: 2 }] });
  let guard = 0;
  while (S.pirates.length && guard++ < 600) {
    const e = S.pirates[0];
    const want = Math.atan2(e.z - S.player.z, e.x - S.player.x);
    step(S, DT, { turn: Math.max(-1, Math.min(1, angleDiff(S.player.a, want) * 3)), thrust: 0, fire: true });
  }
  ok(S.pirates.length === 0 && S.kills === 1, 'two hits kill a raider', { kills: S.kills });
  ok(S.credits === CFG.pirate.bounty, 'the bounty lands in credits', S.credits);
}
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0 },
    bullets: [{ x: 0.1, z: 0, vx: 0, vz: 0 }] });
  step(S, DT, null);
  ok(S.hull === CFG.hull - CFG.pirate.dmg, 'a pirate bullet costs hull', S.hull);
  ok(S.iframes > 0, 'a hit grants grace', S.iframes);
  const before = S.hull;
  for (let i = 0; i < 30; i++) { api.addBullet(S, 0.1, 0, 0, 0, 'b'); step(S, DT, null); }
  ok(S.hull === before, 'grace eats the follow-up volley', { hull: S.hull, before });
}
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0 },
    rocks: [{ kind: 'iron', x: 0.5, z: 0 }] });
  step(S, DT, null);
  ok(S.hull === CFG.hull - CFG.ramDmg, 'a rock is not a wall you can push through', S.hull);
  const d = Math.hypot(S.player.x - S.rocks[0].x, S.player.z - S.rocks[0].z);
  ok(d >= S.rocks[0].r + CFG.playerR - 0.01, 'the ship is pushed back out of the rock', d);
}

// ---------------------------------------------------------------- a broken rock grows back
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: -4 },
    rocks: [{ kind: 'iron', x: 4, z: 4, hp: 1 }] });
  const id = S.rocks[0].id;
  S.player.a = Math.atan2(4 - (-4), 4 - 0);
  let guard = 0;
  while (S.mined === 0 && guard++ < 900) step(S, DT, { thrust: 0, turn: 0, fire: true });
  ok(S.mined === 1 && !S.rocks.some((r) => r.id === id), 'the last rock is gone', { mined: S.mined, rocks: S.rocks.length });
  run(S, CFG.rockRespawn + 0.4, { thrust: 0, turn: 0, fire: false });
  ok(S.rocks.length === 1, 'the belt refills after a break', S.rocks.length);
  const r = S.rocks[0];
  ok(Math.hypot(r.x, r.z) > S.station.r + r.r, 'the regrowth keeps clear of the ring');
}

// ---------------------------------------------------------------- a wave clears and escalates
{
  const S = setup({ hold: false, noPirates: true, wave: 3, noRocks: true, player: { x: 0, z: 3 } });
  step(S, DT, null);
  ok(S.wave === 4, 'a cleared wave advances', S.wave);
  ok(S.queue.length === api.wavePirates(4), 'the next wave queues its pirates', S.queue.length);
}

// ---------------------------------------------------------------- the belt is a fence, not a hole
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, player: { x: 0, z: 0 } });
  const out = { x0: 0, x1: 0, z0: 0, z1: 0 };
  const aims = [[0, -50], [0, 50], [-50, 0], [50, 0]];
  for (let i = 0; i < 1600; i++) {
    const a = aims[Math.floor(i / 400) % 4];
    step(S, DT, { aimX: a[0], aimZ: a[1] });
    out.x0 = Math.min(out.x0, S.player.x); out.x1 = Math.max(out.x1, S.player.x);
    out.z0 = Math.min(out.z0, S.player.z); out.z1 = Math.max(out.z1, S.player.z);
  }
  const R = CFG.playerR, e = 0.01;   // a hair of slack: the wall snap and the rock push-out share a frame
  ok(out.x0 >= FIELD.x0 + R - e && out.x1 <= FIELD.x1 - R + e && out.z0 >= FIELD.z0 + R - e && out.z1 <= FIELD.z1 - R + e,
    'the belt walls hold the ship inside the field', out);
}

// ---------------------------------------------------------------- a loss is a real loss
{
  const S = setup({ hold: false, noPirates: true, noRocks: true, hull: 8, player: { x: 0, z: 0 },
    bullets: [{ x: 0, z: 0, vx: 0, vz: 0 }] });
  step(S, DT, null);
  ok(S.over === true && S.won === false && S.hull === 0 && S.why === 'hull', 'hull zero ends the run as a loss',
    { hull: S.hull, over: S.over, why: S.why });
}

// ---------------------------------------------------------------- the QA harness freezes the sim
{
  const S = setup({ hold: true, noRocks: true, noPirates: true, player: { x: 0, z: 0 }, rocks: [{ kind: 'gold', x: 2, z: 0 }] });
  const t0 = S.t;
  run(S, 1.0, { thrust: 1, turn: 0, fire: true });
  ok(S.t === t0 && S.bullets.length === 0 && S.rocks[0].hp === ROCK.gold.hp, 'hold parks every system', { t: S.t, t0 });
}

// ---------------------------------------------------------------- pilots
function nearestRock(S) {
  const p = S.player;
  let best = null, bd = 1e9;
  for (const r of S.rocks) {
    const d = Math.hypot(r.x - p.x, r.z - p.z);
    if (d < bd) { bd = d; best = r; }
  }
  return best ? { rock: best, d: bd } : null;
}
function flyTo(S, tx, tz, maxSpeed) {
  const p = S.player;
  const want = Math.atan2(tz - p.z, tx - p.x);
  const turn = Math.max(-1, Math.min(1, angleDiff(p.a, want) * 3.4));
  const dist = Math.hypot(tx - p.x, tz - p.z);
  const sp = shipSpeed(S);
  const along = p.vx * Math.cos(p.a) + p.vz * Math.sin(p.a);
  const wantSpeed = Math.min(maxSpeed, dist * 1.1);
  let thrust = 0;
  if (Math.abs(angleDiff(p.a, want)) < 0.5 && along < wantSpeed) thrust = 0.85;
  if (along > wantSpeed + 0.4) thrust = 0;
  void sp;
  return { turn, thrust, dist, want };
}
function pilot(S, mode) {
  if (mode === 'idle') return null;
  const p = S.player;
  const hold = cargoTotal(S);
  const station = S.station;
  const dStation = Math.hypot(station.x - p.x, station.z - p.z);

  if (mode === 'hauler') {
    // never fires: proves the gun is where the money comes from
    if (dStation > 1.0) { const f = flyTo(S, station.x, station.z, 2.0); return { turn: f.turn, thrust: f.thrust, fire: false }; }
    return { turn: 0, thrust: 0, fire: false };
  }
  if (hold >= CFG.cargoCap - 1 || (S.hull < 45 && hold > 0)) {
    const f = flyTo(S, station.x, station.z, 2.0);
    return { turn: f.turn, thrust: f.thrust, fire: false };
  }
  const near = nearestRock(S);
  if (!near) return { turn: 0, thrust: 0, fire: false };
  const want = Math.atan2(near.rock.z - p.z, near.rock.x - p.x);
  const off = Math.abs(angleDiff(p.a, want));
  if (off > 0.14) {
    const f = flyTo(S, near.rock.x, near.rock.z, 2.2);
    return { turn: f.turn, thrust: f.thrust, fire: false };
  }
  // lined up: hold the line and keep the gun going. Close in only if the rock is far.
  const thrust = near.d > 3.0 ? 0.5 : 0;
  return { turn: 0, thrust, fire: near.d < 4.6 };
}
function ladder(mode, seeds, limit) {
  let credits = 0, wins = 0, losses = 0, stuck = 0, sold = 0, kills = 0, nan = 0, oob = 0;
  const rows = [];
  for (let s = 1; s <= seeds; s++) {
    const S = makeState(s * 71 + 13);
    let t = 0, guard = 0;
    while (!S.over && t < limit && guard++ < 300000) { step(S, DT, pilot(S, mode)); t += DT; }
    credits += S.credits;
    if (S.won) wins++; else if (S.over) losses++; else stuck++;
    sold += S.sold; kills += S.kills;
    if (!Number.isFinite(S.player.x) || !Number.isFinite(S.player.z) || !Number.isFinite(S.player.a)) nan++;
    if (S.player.x < FIELD.x0 - 1 || S.player.x > FIELD.x1 + 1 || S.player.z < FIELD.z0 - 1 || S.player.z > FIELD.z1 + 1) oob++;
    for (const r of S.rocks) if (!Number.isFinite(r.x) || !Number.isFinite(r.z)) nan++;
    if (s <= 6) rows.push({ seed: s * 71 + 13, credits: S.credits, won: S.won, t: +t.toFixed(1), wave: S.wave, sold: S.sold, kills: S.kills });
  }
  return { mode, seeds, credits, wins, losses, stuck, sold, kills, nan, oob, avg: Math.round(credits / seeds), rows };
}

const idle = ladder('idle', 8, 120);
ok(idle.credits === 0, 'an idle ship never earns a credit', idle);
ok(idle.wins === 0, 'an idle ship never wins', { wins: idle.wins });
console.log('ladder idle   ' + JSON.stringify({ credits: idle.credits, wins: idle.wins, losses: idle.losses, stuck: idle.stuck }));

const hauler = ladder('hauler', 6, 90);
ok(hauler.credits === 0, 'a hauler that never fires never earns a credit', { credits: hauler.credits, sold: hauler.sold });
console.log('ladder hauler ' + JSON.stringify({ credits: hauler.credits, sold: hauler.sold }));

const miner = ladder('miner', 12, 420);
console.log('ladder miner  ' + JSON.stringify({ credits: miner.credits, avg: miner.avg, wins: miner.wins, losses: miner.losses, stuck: miner.stuck, sold: miner.sold, kills: miner.kills }));
console.log('miner seeds   ' + JSON.stringify(miner.rows));
ok(miner.credits > 0, 'a mining pilot banks credits', { credits: miner.credits });
ok(miner.wins >= 3, 'a competent miner reaches the jump on at least a quarter of seeds', { wins: miner.wins, of: miner.seeds });
ok(miner.wins + miner.losses + miner.stuck === miner.seeds, 'every seed is accounted for');
ok(miner.nan === 0, 'no NaN anywhere in the ladder', miner.nan);
ok(miner.oob === 0, 'no ship escapes the belt', miner.oob);

// determinism: same seed, same run
{
  const a = makeState(99), b = makeState(99);
  for (let i = 0; i < 900; i++) { step(a, DT, pilot(a, 'miner')); step(b, DT, pilot(b, 'miner')); }
  ok(a.credits === b.credits && a.wave === b.wave && Math.abs(a.hull - b.hull) < 1e-9 && a.picked === b.picked,
    'a seed replays identically', { a: { c: a.credits, w: a.wave, h: a.hull, p: a.picked }, b: { c: b.credits, w: b.wave, h: b.hull, p: b.picked } });
}

console.log(JSON.stringify({ checks, fails }));
process.exit(fails ? 1 : 0);
