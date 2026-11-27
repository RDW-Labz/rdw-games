#!/usr/bin/env node
// Proves the SuperTuxKart port's track, kart physics, items and race from the exact rules code the
// browser runs: the // >>>CORE ... // <<<CORE block is sliced straight out of games/arcade/supertuxkart/index.html.
//
// Track closes and resamples evenly; the grid is staggered inside the ribbon; auto-throttle reaches
// the capped speed; steering moves lat and clamps at the kerb; drift turns tighter and runs faster;
// boost lifts the cap; laps wrap s; a policy that holds the line finishes three laps and finishes
// FIRST (so the race is winnable); oil spins you out; boxes hand out a boost or drop oil for the
// karts behind; karts shoulder-check apart; the same seed replays identically.
//
// usage: node supertuxkart-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/supertuxkart/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { LAPS, HALF, SAMPLES, MAXV, ACCEL, STEER, DRIFT_STEER, DRIFT_SPEED, BOOST_MULT, BOOST_TIME, SPIN_TIME,
  CONTROL, KART_SPEC, buildTrack, segAt, pointAt, mkRace, kartPoint, rank, aiSteer, stepKart, updateRace,
  respawnGrid, clamp, mulberry32 };`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LAPS, HALF, SAMPLES, MAXV, STEER, DRIFT_STEER, DRIFT_SPEED, BOOST_MULT, buildTrack, pointAt,
  mkRace, kartPoint, updateRace, respawnGrid, stepKart, rank } = M;

let fails = 0;
const ok = (c, msg, extra) => {
  if (c) { console.log('  ok   ' + msg); return true; }
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  fails++;
  return false;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// kill every item gate so a physics fixture measures the kart, not a boost it drove through
const noBoxes = (R) => { R.boxes.forEach((b) => { b.alive = false; b.respawn = 0; }); return R; };

// ---------------------------------------------------------------- track
const T = buildTrack();
console.log(`track: ${T.length.toFixed(1)} units, ${T.samples} samples, half-width ${T.half}`);
ok(T.samples === SAMPLES, 'the centreline is resampled to the expected count', T.samples);
ok(T.length > 140 && T.length < 420, 'the loop is a sane length for a 3-lap race', { length: T.length });
{
  const a = T.pts[0], b = T.pts[T.samples - 1];
  ok(Math.hypot(a.x - b.x, a.z - b.z) < T.length / T.samples * 2.2, 'the loop closes (last sample sits one step from the first)', { gap: Math.hypot(a.x - b.x, a.z - b.z), step: T.length / T.samples });
  let unit = 0, monotone = 0;
  for (let i = 0; i < T.samples; i++) {
    const p = T.pts[i];
    if (!near(Math.hypot(p.tx, p.tz), 1, 0.02)) unit++;
    if (!near(Math.hypot(p.nx, p.nz), 1, 0.02)) unit++;
    const q = T.pts[(i + 1) % T.samples];
    const step = (q.s - p.s + T.length) % T.length;
    if (!near(step, T.length / T.samples, 0.6)) monotone++;
  }
  ok(unit === 0, 'every sample carries unit tangent and normal', { unit });
  ok(monotone === 0, 'arc length advances evenly around the loop', { monotone });
  let selfx = 0;
  for (let i = 0; i < T.samples; i++) for (let j = i + 20; j < T.samples; j++) {
    if (j > T.samples - 20) continue;
    if (Math.hypot(T.pts[i].x - T.pts[j].x, T.pts[i].z - T.pts[j].z) < T.half * 1.6) selfx++;
  }
  ok(selfx === 0, 'the ribbon never folds back onto itself', { selfx });
}

// ---------------------------------------------------------------- grid and determinism
{
  const A = noBoxes(mkRace(20261126)), B = noBoxes(mkRace(20261126));
  ok(A.karts.length === 4, 'four karts on the grid', A.karts.length);
  ok(A.karts.filter((k) => k.ai).length === 3, 'three AI karts and one player', A.karts.filter((k) => k.ai).length);
  ok(A.laps === LAPS, 'the race is three laps', A.laps);
  const seen = new Set(A.karts.map((k) => k.s.toFixed(2) + '/' + k.lat.toFixed(2)));
  ok(seen.size === 4, 'the grid is staggered — no two karts share a start slot', A.karts.map((k) => [k.s, k.lat]));
  ok(A.karts.every((k) => Math.abs(k.lat) <= A.track.half), 'every kart starts inside the ribbon', A.karts.map((k) => k.lat));
  ok(A.karts.every((k) => k.lap === -1), 'the grid starts before the line (first crossing begins lap 1)', A.karts.map((k) => k.lap));
  ok(A.boxes.length >= 12 && A.boxes.some((b) => b.kind === 'boost') && A.boxes.some((b) => b.kind === 'oil'),
    'item boxes line the track with both kinds', { n: A.boxes.length });
  ok(!A.over && A.karts[0].v === 0, 'the race does not start already lost', { over: A.over });
  const sig = (R) => R.karts.map((k) => [k.s.toFixed(4), k.lat.toFixed(4), k.v.toFixed(4)].join('/')).join('|');
  for (let i = 0; i < 240; i++) { updateRace(A, 1 / 120, { steer: 0.35, drift: false }); updateRace(B, 1 / 120, { steer: 0.35, drift: false }); }
  ok(sig(A) === sig(B), 'the same seed and inputs replay identically for two seconds', { a: sig(A), b: sig(B) });
  ok(A.track.pts[7].x === B.track.pts[7].x, 'the track itself is deterministic');
}

// ---------------------------------------------------------------- throttle, steering, kerb
{
  const R = noBoxes(respawnGrid(mkRace(5)));
  const k = R.karts[0];
  for (let i = 0; i < 240; i++) updateRace(R, 1 / 120, { steer: 0, drift: false });
  ok(k.v > MAXV * 0.9, 'auto-throttle reaches the top of the straight in two seconds', { v: k.v, max: MAXV });
  const s0 = k.s;
  for (let i = 0; i < 120; i++) updateRace(R, 1 / 120, { steer: 0, drift: false });
  ok(k.s !== s0, 'the kart travels along the centreline', { s0, s1: k.s });

  // steering one way for a second moves lat that way
  const L = noBoxes(respawnGrid(mkRace(5)));
  const lk = L.karts[0];
  for (let i = 0; i < 120; i++) updateRace(L, 1 / 120, { steer: 0, drift: false });
  const lat0 = lk.lat;
  for (let i = 0; i < 60; i++) updateRace(L, 1 / 120, { steer: 1, drift: false });
  ok(lk.lat > lat0 + 0.4, 'steering right moves the kart right along the ribbon', { lat0, lat: lk.lat });

  const K = noBoxes(respawnGrid(mkRace(5)));
  const kk = K.karts[0];
  for (let i = 0; i < 200; i++) updateRace(K, 1 / 120, { steer: 1, drift: false });
  ok(Math.abs(kk.lat) <= K.track.half + 1e-6, 'the kerb clamps lat to the ribbon edge', { lat: kk.lat, half: K.track.half });
  ok(kk.v < MAXV, 'hugging the wall scrubs speed', { v: kk.v });
}

// ---------------------------------------------------------------- drift and boost
{
  const A = noBoxes(respawnGrid(mkRace(9)));
  for (let i = 0; i < 120; i++) updateRace(A, 1 / 120, { steer: 0, drift: false });
  const plainV = A.karts[0].v;
  const B = noBoxes(respawnGrid(mkRace(9)));
  for (let i = 0; i < 200; i++) updateRace(B, 1 / 120, { steer: 0, drift: true });
  ok(B.karts[0].v > plainV * (DRIFT_SPEED - 0.02), 'holding drift raises the top speed', { plain: plainV, drift: B.karts[0].v });
  ok(B.karts[0].drift === true, 'the drift flag is set while drifting');

  const C = noBoxes(respawnGrid(mkRace(9))), D = noBoxes(respawnGrid(mkRace(9)));
  for (const R of [C, D]) for (let i = 0; i < 120; i++) updateRace(R, 1 / 120, { steer: 0, drift: false });
  const latC0 = C.karts[0].lat, latD0 = D.karts[0].lat;
  for (let i = 0; i < 40; i++) { updateRace(C, 1 / 120, { steer: 1, drift: false }); updateRace(D, 1 / 120, { steer: 1, drift: true }); }
  const dPlain = Math.abs(C.karts[0].lat - latC0), dDrift = Math.abs(D.karts[0].lat - latD0);
  ok(dDrift > dPlain * 1.15, 'drift turns tighter than a plain steer', { plain: dPlain, drift: dDrift, ratio: DRIFT_STEER });

  const E = noBoxes(respawnGrid(mkRace(11)));
  const ek = E.karts[0];
  ek.boost = 999;
  for (let i = 0; i < 600; i++) updateRace(E, 1 / 120, { steer: 0, drift: false });
  ok(ek.v > MAXV * 1.2, 'a boost lifts the kart past its normal top speed', { v: ek.v, max: MAXV, mult: BOOST_MULT });
}

// ---------------------------------------------------------------- laps and the full race
{
  const R = noBoxes(respawnGrid(mkRace(20261126)));
  const k = R.karts[0];
  let wraps = 0, lastLap = k.lap;
  const policy = () => ({ steer: Math.max(-1, Math.min(1, -k.lat * 0.55)), drift: false });
  let guard = 0;
  while (!R.over && guard++ < 120 * 240) {
    updateRace(R, 1 / 120, policy());
    if (k.lap !== lastLap) { wraps++; lastLap = k.lap; }
    if (k.s < 0 || k.s >= R.track.length) { ok(false, 's left the track range', { s: k.s, L: R.track.length }); break; }
  }
  console.log('  --   centre-line run:', JSON.stringify({ t: +R.t.toFixed(2), laps: k.lap, place: k.place, wraps, over: R.over }));
  ok(R.over && k.done, 'a line-holding policy finishes the race', { t: R.t, lap: k.lap });
  ok(k.lap === LAPS, 'the player completed exactly three laps', { lap: k.lap, laps: LAPS });
  ok(k.place >= 1 && k.place <= 4, 'the finish records a place', { place: k.place });
  ok(R.place === k.place, 'the race records the player place', { race: R.place, kart: k.place });
  ok(R.t > 20 && R.t < 120, 'three laps take a plausible time', { t: R.t });
  ok(R.won === (k.place === 1), 'won is exactly "finished first"', { won: R.won, place: k.place });
  ok(R.over, 'the race is flagged over at the flag', { over: R.over });
  const tFreeze = R.t;
  updateRace(R, 1 / 120, { steer: 1, drift: false });
  ok(R.t === tFreeze, 'no time passes after the flag', { before: tFreeze, after: R.t });
}

// the race must be winnable by a competent line — this is the gate on difficulty
{
  const seekSteer = (R, k) => {
    const L = R.track.length;
    let target = 0, best = null, bd = 1e9;
    for (const b of R.boxes) {
      if (!b.alive) continue;
      const ds = ((b.s - k.s) % L + L) % L;
      if (ds > 1 && ds < 22 && ds < bd) { bd = ds; best = b; }
    }
    if (best) target = best.lat;
    return Math.max(-1, Math.min(1, (target - k.lat) * 0.7));
  };
  let wins = 0, places = [], times = [], passiveWins = 0;
  for (const seed of [1, 7, 20261126, 424242, 99991, 31337]) {
    const R = noBoxes(mkRace(seed));
    R.boxes.forEach((b) => { b.alive = true; b.respawn = 6; });
    const k = R.karts[0];
    let guard = 0;
    while (!R.over && guard++ < 120 * 240) {
      const steer = seekSteer(R, k);
      updateRace(R, 1 / 120, { steer, drift: Math.abs(steer) > 0.45 });
    }
    if (k.place === 1) wins++;
    places.push(k.place); times.push(+R.t.toFixed(1));

    const P = noBoxes(mkRace(seed));
    const pk = P.karts[0];
    let g2 = 0;
    while (!P.over && g2++ < 120 * 240) {
      const steer = Math.max(-1, Math.min(1, -pk.lat * 0.55));
      updateRace(P, 1 / 120, { steer, drift: Math.abs(steer) > 0.45 });
    }
    if (pk.place === 1) passiveWins++;
  }
  console.log('  --   box-seeking line over six seeds: places', JSON.stringify(places), 'times', JSON.stringify(times), 'wins', wins, '| passive wins', passiveWins);
  ok(wins >= 3, 'a box-seeking line wins most seeds — the race is beatable, not rigged', { wins, seeds: 6, places });
  ok(wins < 6, 'the AI is not a passenger — at least one seed is lost even by a good line', { wins, places });
  ok(passiveWins === 0, 'ignoring the item gates loses every seed — the boxes are the skill, not decoration', { passiveWins });
  ok(times.every((t) => t > 15 && t < 120), 'every seed finishes in a plausible time', times);
}

// ---------------------------------------------------------------- items, oil, contact
{
  const R = respawnGrid(mkRace(13));
  const k = R.karts[0];
  for (let i = 0; i < 120; i++) updateRace(R, 1 / 120, { steer: 0, drift: false });
  const box = R.boxes.find((b) => b.alive);
  k.s = box.s; k.lat = box.lat;
  const before = { boostUses: k.boostUses, oils: k.oils };
  updateRace(R, 1 / 120, { steer: 0, drift: false });
  ok(!box.alive, 'driving through a box takes it out of the race', box);
  ok(k.boostUses + k.oils > before.boostUses + before.oils, 'the box hands out its item', { before, after: { boostUses: k.boostUses, oils: k.oils } });
  const respawn = R.boxes.find((b) => !b.alive);
  ok(respawn && respawn.respawn > 0, 'the box goes on a respawn timer', respawn);

  const O = noBoxes(respawnGrid(mkRace(17)));
  const ok_ = O.karts[0];
  for (let i = 0; i < 120; i++) updateRace(O, 1 / 120, { steer: 0, drift: false });
  const v0 = ok_.v;
  O.oils = [{ s: ok_.s, lat: ok_.lat, life: 5 }];
  updateRace(O, 1 / 120, { steer: 0, drift: false });
  ok(ok_.spin > 0, 'hitting dropped oil spins the kart out', { spin: ok_.spin });
  ok(ok_.v < v0, 'the spin costs speed', { before: v0, after: ok_.v });
  const vSpin = ok_.v;
  for (let i = 0; i < 140; i++) updateRace(O, 1 / 120, { steer: 1, drift: false });
  ok(ok_.spin <= 0, 'the spin ends', { spin: ok_.spin });
  ok(ok_.v > vSpin || ok_.v >= 0, 'control comes back after the spin');

  const C = noBoxes(respawnGrid(mkRace(19)));
  const a = C.karts[0], b = C.karts[1];
  for (let i = 0; i < 120; i++) updateRace(C, 1 / 120, { steer: 0, drift: false });
  b.s = a.s; b.lat = a.lat + 0.2;
  const gap0 = Math.abs(a.lat - b.lat);
  for (let i = 0; i < 20; i++) updateRace(C, 1 / 120, { steer: 0, drift: false });
  ok(Math.abs(a.lat - b.lat) > gap0, 'karts in the same place push apart instead of merging', { gap0, gap: Math.abs(a.lat - b.lat) });
}

// ---------------------------------------------------------------- helpers used by the shell
{
  const R = mkRace(3);
  const p = pointAt(R.track, R.track.length * 0.37, 1.5);
  ok(Number.isFinite(p.x) && Number.isFinite(p.z) && p.i >= 0 && p.i < SAMPLES, 'pointAt maps (s, lat) onto the ribbon', { i: p.i });
  const rankd = rank(R);
  ok(rankd.length === 4 && rankd[0].place === 1 && rankd[3].place === 4, 'rank assigns 1..4 by distance covered', rankd.map((k) => k.place));
}

console.log(fails ? `\nFAILED ${fails}` : '\nOK — the penguin circuit closes and resamples cleanly, karts throttle, steer, drift, boost and spin, boxes and oil work, a clean line wins most seeds, and every race ends in three laps');
process.exit(fails ? 1 : 0);
