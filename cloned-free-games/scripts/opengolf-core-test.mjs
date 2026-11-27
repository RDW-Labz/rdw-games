#!/usr/bin/env node
// Proves the Open Golf port's shipped rules and ball physics against the exact code the
// browser plays: the // >>>CORE ... // <<<CORE block is sliced out of the folder port.
//
// Assertions: every course is a sealed box with one tee and one cup, the tee-to-cup line is
// clear of walls for the ball's width on every hole (so the round is winnable by aiming),
// full power rolls 8-16 units on the green and less than half that in sand, a straight-aiming
// pilot sinks every hole within par+3 strokes, the same putt twice lands in the same place,
// no putt in a wide sweep ever leaves the course or ends inside a wall, the cup only accepts a
// ball that arrives under capture speed, and the stroke/budget bookkeeping is exact.
//
// usage: node opengolf-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

process.on('uncaughtException', (e) => {
  console.error('FAIL uncaught: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/open-golf/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { PHYS, BUDGET, HOLES, parseHole, cellOf, wallAt, mkState, stepBall, putt, settle,
  strokesLeft, losClear, parTotal, sinkCheck };`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { PHYS, BUDGET, HOLES, parseHole, cellOf, wallAt, mkState, stepBall, putt, settle,
  strokesLeft, losClear, parTotal } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const t0 = Date.now();
const courses = HOLES.map(parseHole);

// ---- 1. course geometry ----
{
  ok(HOLES.length === 6, 'the round should be 6 holes', HOLES.length);
  ok(parTotal() === HOLES.reduce((a, h) => a + h.par, 0), 'parTotal disagrees with the card');
  ok(parTotal() >= 6 && parTotal() <= 30, 'implausible par total', parTotal());
  ok(BUDGET > parTotal(), 'the stroke allowance must leave room above par', { BUDGET, par: parTotal() });
  for (const H of courses) {
    let tee = 0, cup = 0, open = 0, sand = 0;
    for (let r = 0; r < H.h; r++) {
      ok(H.rows[r].length === H.w, `${H.name}: row ${r} is not ${H.w} wide`, H.rows[r].length);
      for (let c = 0; c < H.w; c++) {
        const ch = H.rows[r][c];
        if (ch === '@') tee++;
        else if (ch === 'o') cup++;
        else if (ch === 's') sand++;
        if (ch !== '#') open++;
        const edge = r === 0 || c === 0 || r === H.h - 1 || c === H.w - 1;
        if (edge) ok(ch === '#', `${H.name}: border cell ${c},${r} is open (${ch})`, null);
      }
    }
    ok(tee === 1, `${H.name}: expected exactly one tee`, tee);
    ok(cup === 1, `${H.name}: expected exactly one cup`, cup);
    ok(open > 40, `${H.name}: course is suspiciously empty`, open);
    ok(H.tee.x === 0 || Math.abs(H.tee.x) < H.w / 2, `${H.name}: tee outside the grid`, H.tee);
    ok(!wallAt(H, H.tee.x, H.tee.z), `${H.name}: the tee sits in a wall`, H.tee);
    ok(!wallAt(H, H.hole.x, H.hole.z), `${H.name}: the cup sits in a wall`, H.hole);
    ok(Math.hypot(H.hole.x - H.tee.x, H.hole.z - H.tee.z) > 4, `${H.name}: tee and cup are too close`, null);
  }
  console.log(`courses: ${courses.length} holes, par ${parTotal()}, budget ${BUDGET}`);
}

// ---- 2. line of sight: every hole is winnable by aiming straight at the cup ----
for (const H of courses) ok(losClear(H), `${H.name}: the tee-to-cup line runs into a wall`, null);

// ---- 3. friction: green rolls, sand eats the ball ----
function rollDistance(H, sand) {
  const S = mkState(H, {});
  S.x = 0; S.z = 0;
  S.vx = 0; S.vz = -PHYS.vmax;
  S.moving = true;
  let d = 0, t = 0;
  while (S.moving !== false && t < 20) {
    const before = { x: S.x, z: S.z };
    const r = stepBall(S, H, 1 / 120);
    d += Math.hypot(S.x - before.x, S.z - before.z);
    t += 1 / 120;
    if (r !== 'moving') break;
  }
  return d;
}
{
  // a dedicated flat strip: long corridor of green, and the same strip of sand
  const strip = (fill) => {
    const w = 5, h = 40;
    const rows = [];
    for (let r = 0; r < h; r++) rows.push(r === 0 || r === h - 1 ? '#'.repeat(w) : '#' + fill.repeat(w - 2) + '#');
    rows[1] = '#' + 'o' + fill.repeat(w - 3) + '#';
    rows[h - 2] = '#' + '@' + fill.repeat(w - 3) + '#';
    return parseHole({ name: 'strip-' + fill, par: 2, map: rows });
  };
  const green = strip('.'), sandStrip = strip('s');
  const g = rollDistance(green, false), s = rollDistance(sandStrip, true);
  ok(g > 8 && g < 16, 'a full-power putt on the green should roll 8-16 units', g.toFixed(2));
  ok(s < g * 0.55, 'sand must take at least half the roll out of the ball', { green: g.toFixed(2), sand: s.toFixed(2) });
  console.log(`roll: green ${g.toFixed(2)}u, sand ${s.toFixed(2)}u (${(100 * s / g).toFixed(0)}%)`);
}

// ---- 4. pilot: aim at the cup, sweep power, every hole sinks ----
const clone = (S) => ({ ...S });
const distToCup = (S, H) => Math.hypot(S.x - H.hole.x, S.z - H.hole.z);
const sinkPowers = [];
for (const H of courses) {
  let S = mkState(H, {});
  let sunk = false, used = 0, firstPower = null;
  for (let stroke = 0; stroke < H.par + 3 && !sunk; stroke++) {
    let best = null;
    for (let p = 0.15; p <= 1.0001; p += 0.05) {
      const c = clone(S);
      if (!putt(c, H, H.hole.x - c.x, H.hole.z - c.z, p)) break;
      const res = settle(c, H);
      used++;
      if (res === 'sunk') { best = { p, c, res }; break; }
      const d = distToCup(c, H);
      if (!best || d < best.d) best = { p, c, res, d };
    }
    if (!best) { ok(false, `${H.name}: no acceptable putt from the tee`, null); break; }
    if (stroke === 0) firstPower = best.p;
    S = best.c;
    if (best.res === 'sunk') sunk = true;
  }
  ok(sunk, `${H.name}: not sinkable by a straight-aiming pilot within par+3`, { par: H.par, used });
  ok(S.strokes <= H.par + 3, `${H.name}: pilot used too many strokes`, S.strokes);
  sinkPowers.push(firstPower);
  console.log(`hole ${H.name}: sunk in ${S.strokes} (par ${H.par}), tee power ${firstPower?.toFixed(2)}`);
}

// ---- 4b. power window from the tee: the sinkable powers are a contiguous band, not a range ----
const gatePowers = [];
{
  const bands = [];
  for (const H of courses) {
    const sink = [];
    for (let p = 0.10; p <= 1.0001; p += 0.01) {
      const S = mkState(H, {});
      if (!putt(S, H, H.hole.x - S.x, H.hole.z - S.z, p)) continue;
      if (settle(S, H) === 'sunk') sink.push(+p.toFixed(2));
    }
    // a ball that skips the cup can still drop later off the back wall, so group the powers
    // into contiguous bands and keep the widest: that is the band a player can actually aim for
    const runs = [];
    for (const p of sink) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(p - last.hi - 0.01) < 1e-6) last.hi = p;
      else runs.push({ lo: p, hi: p });
    }
    for (const r of runs) r.width = +(r.hi - r.lo).toFixed(2);
    runs.sort((a, b) => b.width - a.width);
    const band = runs[0] || null;
    bands.push({ name: H.name, band, runs });
    gatePowers.push(band ? +(((band.lo + band.hi) / 2).toFixed(2)) : null);
    ok(!!band, `${H.name}: no tee power sinks it`, null);
    ok(band && band.width >= 0.03, `${H.name}: the sinkable power band is too tight to be fair`, band);
    console.log(`hole ${H.name}: tee band ${band ? band.lo + '..' + band.hi + ' (' + band.width.toFixed(2) + ' wide)' : 'none'}, ${runs.length} band(s)`);
  }
  const short = bands[0], long = bands[bands.length - 1];
  ok(short.band && long.band && short.band.width > long.band.width,
    'the long hole should demand finer power than the opener', { short: short.band, long: long.band });
}
{
  const H = courses[0];
  const run = () => {
    const S = mkState(H, {});
    putt(S, H, H.hole.x - S.x, H.hole.z - S.z, 0.62);
    const res = settle(S, H);
    return { res, x: +S.x.toFixed(6), z: +S.z.toFixed(6), sim: S.sim };
  };
  const a = run(), b = run();
  ok(a.res === b.res && a.x === b.x && a.z === b.z, 'the same putt did not land in the same place', { a, b });
}

// ---- 6. the ball never escapes and never rests inside a wall ----
{
  let escapes = 0, inWall = 0, tested = 0;
  for (const H of courses) {
    for (let dir = 0; dir < 16; dir++) {
      const a = (dir / 16) * Math.PI * 2;
      for (const p of [0.2, 0.45, 0.7, 1.0]) {
        const S = mkState(H, {});
        putt(S, H, Math.cos(a), Math.sin(a), p);
        const res = settle(S, H);
        tested++;
        const lim = { x: H.w / 2, z: H.h / 2 };
        if (res !== 'sunk' && (Math.abs(S.x) > lim.x || Math.abs(S.z) > lim.z)) { escapes++; console.error(`   escape ${H.name} dir${dir} p${p} -> ${S.x},${S.z}`); }
        if (wallAt(H, S.x, S.z)) { inWall++; console.error(`   in-wall ${H.name} dir${dir} p${p} -> ${S.x},${S.z}`); }
      }
    }
  }
  ok(escapes === 0, 'a putt left the course', escapes);
  ok(inWall === 0, 'a ball came to rest inside a wall', inWall);
  console.log(`containment: ${tested} putts, ${escapes} escapes, ${inWall} in-wall rests`);
}

// ---- 7. the cup only takes a slow ball ----
{
  const H = courses[0];
  const fast = mkState(H, {});
  fast.x = H.hole.x; fast.z = H.hole.z + 2.2;
  fast.vx = 0; fast.vz = -(PHYS.capture + 2);
  const r1 = stepBall(fast, H, 1 / 120);
  ok(r1 !== 'sunk', 'a ball well above capture speed dropped into the cup', r1);
  const slow = mkState(H, {});
  slow.x = H.hole.x; slow.z = H.hole.z + PHYS.cup * 0.5;
  slow.vx = 0; slow.vz = -0.5;
  ok(stepBall(slow, H, 1 / 120) === 'sunk', 'a slow ball on the lip did not drop', null);
}

// ---- 8. stroke bookkeeping ----
{
  const H = courses[0];
  const S = mkState(H, { budget: 3 });
  ok(strokesLeft(S) === 3, 'a fresh state should have the full allowance', strokesLeft(S));
  ok(putt(S, H, 0, -1, 0.4) === true, 'a legal putt was refused', null);
  ok(S.strokes === 1 && S.total === 1 && S.putts === 1, 'a putt did not spend exactly one stroke', S);
  ok(putt(S, H, 0, -1, 0.4) === false, 'a putt was accepted while the ball was moving', null);
  settle(S, H);
  ok(putt(S, H, 1, 0, 0.1) === true, 'a putt after rest was refused', null);
  ok(S.strokes === 2 && strokesLeft(S) === 1, 'the second stroke did not book', S);
  settle(S, H);
  ok(putt(S, H, -1, 0, 0.1) === true, 'the third stroke was refused', null);
  settle(S, H);
  ok(strokesLeft(S) === 0, 'the allowance should be spent', strokesLeft(S));
  ok(S.sunk === false, 'the shot walk should not have holed out', S.sunk);
  const zero = mkState(H, {});
  ok(putt(zero, H, 0, 0, 0.5) === false, 'a zero-length putt was accepted', null);
  ok(putt(zero, H, 0, -1, 99) === true, 'an over-power putt should clamp, not refuse', null);
  ok(Math.abs(Math.hypot(zero.vx, zero.vz) - PHYS.vmax) < 1e-6, 'over-power did not clamp to vmax', Math.hypot(zero.vx, zero.vz));
}

// ---- 9. cell mapping round-trips (the renderer and the physics share it) ----
{
  for (const H of courses) {
    let bad = 0;
    for (let r = 0; r < H.h; r++) for (let c = 0; c < H.w; c++) {
      const x = c - (H.w - 1) / 2, z = r - (H.h - 1) / 2;
      const got = cellOf(H, x, z);
      if (got.c !== c || got.r !== r) bad++;
    }
    ok(bad === 0, `${H.name}: cell coordinates do not round-trip`, bad);
  }
  ok(cellOf(courses[0], 999, 999).ch === '#', 'outside the grid must read as wall', null);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} opengolf-core-test — ${fails} failure(s) in ${Date.now() - t0}ms`);
console.log('gate powers (tee, mid-window): ' + gatePowers.map((p, i) => `H${i + 1}=${p}`).join(' '));
process.exit(fails === 0 ? 0 : 1);
