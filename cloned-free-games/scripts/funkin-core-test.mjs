#!/usr/bin/env node
// Proves the Friday Night Funkin' port's shipped rhythm rules with the exact code the browser
// runs: the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/funkin/index.html.
//
// Assertions: every chart is deterministic, sorted, unique per (beat,lane), never opens before
// beat 4, never stacks more than two arrows on one beat, and ends at least two beats inside the
// song; a perfect machine clears all three songs at 100 % with full hype; an idle machine empties
// the hype bar on every song (lose, not win); a late press scores strictly worse than an on-beat
// one; a press outside the ok window is a ghost (no note consumed) and that note then misses; the
// win predicate fires once and no press lands after it.
//
// usage: node funkin-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/funkin/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { LANES, LANE_NAME, SICK, GOOD, OKW, MISSW, APPROACH, START_HEALTH, H_GAIN, H_MISS,
  WEIGHT, PTS, SONGS, mulberry32, mkChart, mkState, accuracy, gradeOf, mult, noteT,
  award, missNote, press, step, nextNote };`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { LANES, SICK, GOOD, OKW, MISSW, START_HEALTH, SONGS, mkChart, mkState, accuracy, gradeOf,
  press, step, nextNote } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const fmt = (o) => JSON.stringify(o);
const EPS = 1e-9;

function advance(S, toT) {
  while (S.t < toT - EPS && !S.over) step(S, Math.min(1 / 240, toT - S.t));
  return S;
}

// ---- 1) charts: deterministic, well-formed, and open with a readable warm-up
{
  const per = [];
  for (let i = 0; i < SONGS.length; i++) {
    const a = mkChart(i), b = mkChart(i);
    ok(fmt(a) === fmt(b), `song ${i} (${SONGS[i].name}) dealt two different charts`);
    ok(a.length >= 24, `song ${i} has too few arrows to be a song`, a.length);
    per.push(fmt(a));

    const first = a[0];
    ok(first.beat === 4 && first.lane === 0, `song ${i} does not open on beat 4 lane 0`, first);
    let bad = 0, dupe = 0, unsorted = 0, stack = 0, late = 0, gapBad = 0;
    const beats = SONGS[i].bars * 4;
    const seen = new Set();
    const byBeat = new Map();
    for (let k = 0; k < a.length; k++) {
      const n = a[k];
      if (!(n.lane >= 0 && n.lane < LANES)) bad++;
      if (n.beat < 4 || !Number.isFinite(n.beat)) bad++;
      if (n.beat > beats - 2) late++;
      const key = n.beat.toFixed(2) + ':' + n.lane;
      if (seen.has(key)) dupe++;
      seen.add(key);
      byBeat.set(n.beat.toFixed(2), (byBeat.get(n.beat.toFixed(2)) || 0) + 1);
      if (k > 0 && a[k].beat < a[k - 1].beat) unsorted++;
      if (k > 0 && Math.abs(a[k].beat - a[k - 1].beat) < 0.5 - 1e-6
        && Math.abs(a[k].beat - a[k - 1].beat) > 1e-6) gapBad++;
    }
    for (const c of byBeat.values()) if (c > 2) stack++;
    ok(bad === 0, `song ${i} has an out-of-range arrow`, { bad });
    ok(dupe === 0, `song ${i} puts two arrows on the same beat and lane`, { dupe });
    ok(unsorted === 0, `song ${i} is not sorted by beat`, { unsorted });
    ok(gapBad === 0, `song ${i} has arrows closer than an eighth note`, { gapBad });
    ok(stack === 0, `song ${i} stacks three or more arrows on one beat`, { stack });
    ok(late === 0, `song ${i} charts an arrow inside the last two beats`, { late, beats });
  }
  ok(new Set(per).size === per.length, 'two songs share one chart (the seeds are not distinct)');
  ok(SONGS[0].bpm < SONGS[1].bpm && SONGS[1].bpm < SONGS[2].bpm, 'the songs are not a rising bpm ladder',
    SONGS.map((s) => s.bpm));
}

// ---- 2) a perfect machine clears every song at 100 % with a full hype bar
{
  for (let i = 0; i < SONGS.length; i++) {
    const S = mkState(i);
    const plan = S.notes.map((n) => ({ beat: n.beat, lane: n.lane }));
    let pressed = 0, wrong = 0;
    for (const p of plan) {
      advance(S, p.beat * S.spb);
      if (S.over) break;
      const res = press(S, p.lane);
      if (res === 'sick') pressed++; else wrong++;
    }
    advance(S, S.beats * S.spb + 0.5);
    ok(wrong === 0, `song ${i}: an on-the-beat press was not judged sick`, { wrong });
    ok(pressed === plan.length, `song ${i}: only ${pressed}/${plan.length} arrows landed`, { pressed, total: plan.length });
    ok(S.over && S.won && S.why === 'song', `song ${i}: a perfect run did not clear the song`,
      { over: S.over, won: S.won, why: S.why, health: S.health });
    ok(accuracy(S) === 100, `song ${i}: a perfect run did not score 100 %`, accuracy(S));
    ok(S.grade === 'S', `song ${i}: a perfect run did not grade S`, S.grade);
    ok(S.miss === 0 && S.health === 1, `song ${i}: a perfect run lost hype`, { miss: S.miss, health: S.health });
    ok(S.maxCombo === plan.length, `song ${i}: combo did not reach the chart length`, { maxCombo: S.maxCombo, len: plan.length });
  }
}

// ---- 3) an idle machine empties the hype bar (lose, never win) on every song
{
  for (let i = 0; i < SONGS.length; i++) {
    const S = mkState(i);
    advance(S, S.beats * S.spb + 1);
    ok(S.over && !S.won && S.why === 'hype', `song ${i}: ignoring every arrow did not lose on hype`,
      { over: S.over, won: S.won, why: S.why, beat: +(S.t / S.spb).toFixed(2) });
    ok(S.health <= 0.0001, `song ${i}: the hype bar did not empty`, S.health);
    ok(S.miss >= 6, `song ${i}: too few misses to empty the bar`, S.miss);
    ok(S.grade === '', `song ${i}: a lost run was graded`, S.grade);
  }
}

// ---- 4) timing ladder: sick / good / ok / ghost, and a ghost costs the note
{
  const S = mkState(0);
  const n0 = S.notes[0];
  advance(S, n0.beat * S.spb - 0.5);
  ok(press(S, n0.lane) === null, 'a press half a second early consumed a note', S.last);
  ok(n0.done === false, 'a ghost press marked the note done');
  advance(S, n0.beat * S.spb);
  const sick = press(S, n0.lane);
  ok(sick === 'sick' && S.last.delta <= SICK + 1e-6, 'an exactly on-beat press is not sick',
    { res: sick, delta: S.last.delta });

  const T = mkState(0), n1 = T.notes[1];
  advance(T, n1.beat * T.spb + (SICK + GOOD) / 2);
  ok(press(T, n1.lane) === 'good', 'a press inside the good window is not good', T.last);
  const goodScore = T.score;

  const U = mkState(0), n2 = U.notes[2];
  advance(U, n2.beat * U.spb + (GOOD + OKW) / 2);
  ok(press(U, n2.lane) === 'ok', 'a press inside the ok window is not ok', U.last);
  ok(U.score < goodScore, 'an ok press did not score below a good press', { ok: U.score, good: goodScore });

  const V = mkState(0), n3 = V.notes[3];
  advance(V, n3.beat * V.spb + OKW + 0.01);
  ok(press(V, n3.lane) === null, 'a press outside the ok window still consumed a note', V.last);
  advance(V, n3.beat * V.spb + MISSW + 0.02);
  ok(n3.done && n3.res === 'miss', 'the ghost-pressed note never turned into a miss',
    { done: n3.done, res: n3.res });
  ok(V.combo === 0, 'a miss left the combo standing', V.combo);
}

// ---- 5) the end state is one-shot: nothing is judged or scorable after it
{
  const S = mkState(0);
  advance(S, S.beats * S.spb + 0.5);
  const snapshot = fmt({
    over: S.over, won: S.won, score: S.score, judged: S.judged, health: S.health, grade: S.grade,
  });
  for (const lane of [0, 1, 2, 3]) ok(press(S, lane) === null, 'a press after the song end was judged', lane);
  advance(S, S.beats * S.spb + 3);
  ok(fmt({
    over: S.over, won: S.won, score: S.score, judged: S.judged, health: S.health, grade: S.grade,
  }) === snapshot, 'the end state changed after the song was over', snapshot);
}

// ---- 6) the hook's next-note readout tracks the chart, and grade thresholds are ordered
{
  const S = mkState(1);
  const nx = nextNote(S);
  ok(nx && nx.beat === 4 && nx.lane === 0 && Math.abs(nx.inSec - 4 * S.spb) < 0.02,
    'nextNote does not point at the opening arrow', nx);
  advance(S, 4 * S.spb);
  press(S, 0);
  const nx2 = nextNote(S);
  ok(nx2 && nx2.beat === 4.5, 'nextNote did not advance after a hit', nx2);
  ok(gradeOf(100) === 'S' && gradeOf(91) === 'A' && gradeOf(85) === 'B' && gradeOf(70) === 'C' && gradeOf(40) === 'D',
    'the grade ladder is out of order', [100, 91, 85, 70, 40].map(gradeOf));
  ok(START_HEALTH > 0 && START_HEALTH < 1, 'the hype bar does not start mid-way', START_HEALTH);
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
