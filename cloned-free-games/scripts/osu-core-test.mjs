#!/usr/bin/env node
// Proves the osu! Circles port's shipped rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/osu/index.html.
//
// Assertions: the beatmap generator is deterministic, sits on the beat grid, keeps circles apart
// in time and space, opens with a countdown and lands in a playable length; the timing windows are
// the advertised 300/100/50/miss bands; a press only consumes the nearest circle under the finger
// inside the window (once); health caps and drains; a perfect pilot clears every map at 100%, a
// sloppy one wins with worse score, an idle one drains the bar and loses; accuracy maths.
//
// usage: node osu-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/osu/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { WIN, HP_MAX, HP_HIT, HP_MISS, FIELD_LAND, FIELD_PORT, PHRASES, BPMS,
  R_NOTE, R_PICK, SEP, OPEN_MS, mulberry32, notePos, mkMap, judgeAt, mkRun, accOf, press, advance, finish };`;
const { WIN, HP_MAX, HP_HIT, HP_MISS, FIELD_LAND, FIELD_PORT, R_NOTE, R_PICK, SEP, OPEN_MS,
  notePos, mkMap, judgeAt, mkRun, accOf, press, advance } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const fmt = (o) => JSON.stringify(o);

// ---- 1) generator: deterministic, on the grid, spaced, bounded, playable length
{
  const a = mkMap(7), b = mkMap(7), c = mkMap(8);
  ok(fmt(a.notes) === fmt(b.notes), 'the same seed produced two different maps');
  ok(fmt(a.notes) !== fmt(c.notes), 'two seeds produced the same map');
  ok(a.notes.length >= 40 && a.notes.length <= 120, 'map size out of range', a.notes.length);
  ok(a.notes[0].t >= 8 * a.spb - 1, 'the map does not open with a countdown', a.notes[0]);

  let gridBad = 0, orderBad = 0, spaceBad = 0, boundBad = 0, lenBad = 0, bpmBad = 0;
  const bpmSeen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const s = mkMap(seed);
    bpmSeen.add(s.bpm);
    if (s.spb < 300 || s.spb > 520) bpmBad++;
    for (let i = 0; i < s.notes.length; i++) {
      const n = s.notes[i];
      const beats = n.t / s.spb;
      if (Math.abs(beats * 2 - Math.round(beats * 2)) > 1e-6) gridBad++;
      if (i && n.t <= s.notes[i - 1].t) orderBad++;
      if (n.nx < 0.089 || n.nx > 0.911 || n.ny < 0.099 || n.ny > 0.901) boundBad++;
      for (let j = 0; j < i; j++) {
        const o = s.notes[j];
        if (Math.abs(o.t - n.t) >= 450) continue;
        if (Math.hypot(o.nx - n.nx, o.ny - n.ny) < SEP - 1e-9) spaceBad++;
      }
    }
    const secs = s.end / 1000;
    if (secs < 12 || secs > 70) lenBad++;
  }
  ok(gridBad === 0, 'notes off the beat/half-beat grid', gridBad);
  ok(orderBad === 0, 'notes are not in time order', orderBad);
  ok(spaceBad === 0, 'two circles closer than SEP within 450 ms', spaceBad);
  ok(boundBad === 0, 'a circle sits outside the normalised field', boundBad);
  ok(lenBad === 0, 'a map is outside a playable 12-70 s', lenBad);
  ok(bpmBad === 0, 'a map has an unusable tempo', bpmBad);
  ok(bpmSeen.size >= 4, 'the tempo pool is not being used', [...bpmSeen]);
  ok(a.spb === 60000 / a.bpm, 'spb does not follow bpm');
}

// ---- 2) timing windows: the advertised bands, and nothing outside them
{
  const T = 10000;
  const cases = [[0, 300], [45, 300], [-45, 300], [46, 100], [90, 100], [-90, 100], [91, 50], [140, 50], [-140, 50], [141, 0], [-141, 0], [400, 0]];
  for (const [dt, want] of cases) ok(judgeAt(T, T + dt).code === want, `judge(${dt}) !== ${want}`, judgeAt(T, T + dt));
  ok(WIN.p300 === 45 && WIN.p100 === 90 && WIN.p50 === 140 && WIN.miss === 175, 'window constants drifted', WIN);
}

// ---- 3) a press only consumes the nearest circle under the finger, inside the window, once
{
  const map = { seed: 1, bpm: 150, spb: 400, notes: [
    { t: 1000, nx: 0.3, ny: 0.4, k: 0 }, { t: 2000, nx: 0.7, ny: 0.4, k: 1 } ], beats: 0, end: 2400 };
  const run = mkRun(map);
  const A = notePos(map.notes[0], FIELD_LAND), B = notePos(map.notes[1], FIELD_LAND);
  ok(press(run, 1000 - 300, A.x, A.y, FIELD_LAND).hit === false, 'a press 300 ms early was accepted');
  ok(press(run, 1000, A.x + 3.0, A.y, FIELD_LAND).hit === false, 'a press 3 units away was accepted');
  const r1 = press(run, 1000, A.x, A.y, FIELD_LAND);
  ok(r1.hit && r1.code === 300, 'an on-beat press on the circle was not a 300', r1);
  ok(run.judged === 1 && run.combo === 1 && run.hits[300] === 1, 'the hit did not register once', { judged: run.judged, hits: run.hits });
  const r2 = press(run, 1000, A.x, A.y, FIELD_LAND);
  ok(r2.hit === false, 'the same circle was consumed twice', r2);
  // the second circle is only reachable from its own position
  ok(press(run, 2000, A.x, A.y, FIELD_LAND).hit === false, 'a far-away press hit the second circle');
  const r3 = press(run, 2000 + 75, B.x, B.y, FIELD_LAND);
  ok(r3.hit && r3.code === 100, 'a 75 ms late press was not a 100', r3);
  ok(run.over === true && run.result === 'win', 'clearing every circle did not win', { over: run.over, result: run.result });
  ok(Math.abs(accOf(run) - (400 / 600) * 100) < 1e-9, 'a 300 and a 100 should read 400/600 accuracy', accOf(run));
}

// ---- 4) health: hits cap, misses drain, the bar hitting zero is the loss
{
  const map = mkMap(3);
  const run = mkRun(map, { hp: 99 });
  const n0 = map.notes[0];
  const p = notePos(n0, FIELD_LAND);
  press(run, n0.t, p.x, p.y, FIELD_LAND);
  ok(run.hp <= HP_MAX + 1e-9, 'health exceeded the cap', run.hp);
  ok(Math.abs(run.hp - HP_MAX) < 1e-9, 'a hit did not refill the bar to the cap', run.hp);

  const q = mkRun(map);
  const hp0 = q.hp;
  advance(q, map.notes[0].t + WIN.miss + 5);
  ok(Math.abs(q.hp - (hp0 - HP_MISS)) < 1e-9, 'a miss did not cost HP_MISS', { hp0, hp: q.hp });
  ok(q.hits[0] === 1 && q.judged === 1, 'a passed circle was not counted as a miss', { hits: q.hits, judged: q.judged });
  ok(q.combo === 0, 'a miss kept the combo');
}

// ---- 5) pilots: perfect wins every generated map, sloppy wins with a worse score, idle loses
{
  const play = (map, offset, opts = {}) => {
    const run = mkRun(map, opts);
    for (const n of map.notes) {
      const t = n.t + offset;
      const p = notePos(n, FIELD_LAND);
      advance(run, Math.max(t, 0) - 1);          // close anything already past
      press(run, t, p.x, p.y, FIELD_LAND);
      if (run.over) break;
    }
    if (!run.over) advance(run, map.end + 1000);
    return run;
  };

  let perfectBad = 0, sloppyBad = 0, idleBad = 0, orderBad = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const map = mkMap(seed);
    const perfect = play(map, 0);
    if (!(perfect.result === 'win' && perfect.hits[300] === map.notes.length && perfect.maxCombo === map.notes.length && Math.abs(accOf(perfect) - 100) < 1e-9)) perfectBad++;
    const sloppy = play(map, 80);
    if (!(sloppy.result === 'win' && sloppy.hits[100] === map.notes.length && sloppy.score < perfect.score)) sloppyBad++;
    const idle = mkRun(map);
    advance(idle, map.end + 1000);
    if (!(idle.result === 'lose' && idle.why === 'drained' && idle.hits[0] === map.notes.length && accOf(idle) === 0)) idleBad++;
    if (!(perfect.score > 0 && perfect.score > sloppy.score)) orderBad++;
  }
  ok(perfectBad === 0, 'a perfect pilot did not clear 25 generated maps at 100%', perfectBad);
  ok(sloppyBad === 0, 'a 80 ms-late pilot did not win with 100s and a lower score', sloppyBad);
  ok(idleBad === 0, 'an idle pilot did not drain the bar and lose', idleBad);
  ok(orderBad === 0, 'score does not fall with worse timing', orderBad);

  // a press 160 ms late is outside the 50 window: it must not be accepted, and the sweep must miss it
  const map = mkMap(9);
  const run = mkRun(map);
  const n = map.notes[0], p = notePos(n, FIELD_LAND);
  ok(press(run, n.t + 160, p.x, p.y, FIELD_LAND).hit === false, 'a 160 ms late press was accepted');
  advance(run, n.t + WIN.miss + 1);
  ok(run.hits[0] === 1, 'the late circle was not missed');
}

// ---- 6) a short QA map (the shape the interaction gate uses) is hittable and winnable
{
  const notes = [0, 1, 2].map((i) => ({ t: 1500 + i * 850, beat: 0, nx: 0.3 + i * 0.2, ny: 0.34, k: i % 3 }));
  const map = { seed: 7, bpm: 150, spb: 400, notes, beats: 0, end: notes[2].t + 400 };
  const run = mkRun(map);
  let hit = 0;
  for (const n of notes) { const p = notePos(n, FIELD_LAND); if (press(run, n.t + 12, p.x, p.y, FIELD_LAND).hit) hit++; }
  ok(hit === 3 && run.result === 'win', 'the QA map is not winnable', { hit, result: run.result });
  ok(run.maxCombo === 3, 'the QA run did not carry a 3 combo', run.maxCombo);

  const lose = mkRun(map, { hp: 12 });
  advance(lose, notes[2].t + WIN.miss + 10);
  ok(lose.result === 'lose' && lose.why === 'drained', 'a 12 HP bar did not drain inside one map', { result: lose.result, hp: lose.hp });
}

// ---- 7) the field mapping is what the picker uses
{
  for (const F of [FIELD_LAND, FIELD_PORT]) {
    const c = notePos({ nx: 0.5, ny: 0.5 }, F);
    ok(Math.abs(c.x) < 1e-12 && Math.abs(c.y) < 1e-12, 'the field centre is not the origin', c);
    const t = notePos({ nx: 0.11, ny: 0.9 }, F);
    ok(t.x < 0 && t.y > 0 && Math.abs(t.x) <= F.w / 2 && Math.abs(t.y) <= F.h / 2, 'a corner maps outside the field', { F, t });
  }
  ok(R_PICK > R_NOTE && R_PICK < R_NOTE * 1.6, 'the pick radius is not a sane ring around the circle', { R_NOTE, R_PICK });
  ok(OPEN_MS > 900 && OPEN_MS < 2200, 'the approach window is not readable', OPEN_MS);
}

if (fails) { console.error(`\nCORE FAIL (${fails})`); process.exit(1); }
console.log(JSON.stringify({
  maps: 60, pilots: 25,
  sample: (() => { const s = mkMap(7); return { bpm: s.bpm, notes: s.notes.length, seconds: +(s.end / 1000).toFixed(1), firstBeat: s.notes[0].beat }; })(),
}, null, 0));
console.log('CORE PASS');
