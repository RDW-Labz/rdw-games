#!/usr/bin/env node
// Proves the Beat Feet port's shipped rules with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/beat-feet/index.html.
//
// Assertions: the song generator is deterministic and every generated level is playable
// (bars never block all three lanes, no hurdle follows a hurdle inside the jump's own air
// time); the timing geometry covers the advertised good window; a perfect pilot clears the
// song at 100% and wins; an idle pilot loses all three hearts; a late pilot scores strictly
// worse; a bar is dodged only by leaving its lane; accuracy and grade track the play.
//
// usage: node beatfeet-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/beat-feet/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `\nexport { BPM, SPB, SONG_BEATS, LANES, JUMP_V, GRAV, JUMP_CLEAR, DUCK_T, CROSS,
  WIN_TOL, OK_TOL, POINTS, MAX_PTS, HEARTS, mulberry32, mkSong, mkState, step,
  pressJump, pressDuck, moveLane, nextObs, accuracy, gradeOf };`;
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { SPB, SONG_BEATS, JUMP_CLEAR, DUCK_T, CROSS, WIN_TOL, OK_TOL, mkSong, mkState, step,
  pressJump, pressDuck, moveLane, nextObs, accuracy, gradeOf } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 120;
const fmt = (o) => JSON.stringify(o);

// ---- 1) the song generator: deterministic, and every level is playable by construction
{
  const a = mkSong(7), b = mkSong(7), c = mkSong(11);
  ok(fmt(a) === fmt(b), 'the same seed produced two different songs');
  ok(fmt(a) !== fmt(c), 'two seeds produced the same song');
  ok(a[0].beat === 8 && a[0].kind === 'gate' && a[0].lanes.length === 3,
    'the opening hazard is not the deterministic beat-8 hurdle', a[0]);

  let bad = 0, laneBad = 0, spacingBad = 0, dense = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const s = mkSong(seed);
    for (let i = 0; i < s.length; i++) {
      const o = s[i];
      if (!['gate', 'low', 'bar'].includes(o.kind)) bad++;
      if (o.beat > SONG_BEATS - 2 || o.beat < 1) bad++;
      if (o.kind === 'bar' && (o.lanes.length < 1 || o.lanes.length > 2 || new Set(o.lanes).size !== o.lanes.length)) laneBad++;
      if (o.kind !== 'bar' && o.lanes.length !== 3) laneBad++;
      if (i > 0) {
        const p = s[i - 1];
        if (o.beat <= p.beat) bad++;
        if ((p.kind !== 'bar') && (o.kind !== 'bar') && o.beat - p.beat < 2) spacingBad++;
      }
    }
    dense += s.length;
  }
  ok(bad === 0, 'a generated song has a malformed hazard', { bad });
  ok(laneBad === 0, 'a generated bar does not leave a free lane', { laneBad });
  ok(spacingBad === 0, 'a hurdle follows a hurdle inside the jump air time', { spacingBad });
  ok(dense / 200 >= 10, 'the generated songs are too sparse to be a rhythm game', { avg: dense / 200 });
  console.log(`songs: seed7 hazards=${a.length} avg/200=${(dense / 200).toFixed(1)}`);
}

// ---- 2) the timing geometry really covers the advertised good window
{
  // jump: press at tb+off, the hurdle crosses at tb+CROSS
  for (const off of [-OK_TOL, -WIN_TOL, 0, WIN_TOL, OK_TOL]) {
    const S = mkState(7);
    S.obs = [];
    S.t = 10;
    pressJump(S);
    let t = S.t;
    const until = 10 - off + CROSS - 1e-9;   // press time was 10, beat was 10-off
    while (t < until) { step(S, DT); t = S.t; }
    ok(S.air.y >= JUMP_CLEAR, `a jump ${off.toFixed(2)}s off the beat is under the clearance at the crossing`,
      { off, y: +S.air.y.toFixed(3) });
  }
  for (const off of [-OK_TOL, -WIN_TOL, 0, WIN_TOL, OK_TOL]) {
    const S = mkState(7);
    S.obs = [];
    S.t = 10;
    pressDuck(S);
    let t = S.t;
    const until = 10 - off + CROSS - 1e-9;
    while (t < until) { step(S, DT); t = S.t; }
    ok(S.duckT > 0, `a duck ${off.toFixed(2)}s off the beat has expired at the crossing`, { off, duckT: S.duckT });
  }
  // and it does come back down (a jump is not a permanent escape)
  {
    const S = mkState(7);
    S.obs = [];
    S.t = 10;
    pressJump(S);
    let t = S.t;
    while (t < 11.1) { step(S, DT); t = S.t; }
    ok(S.air.y === 0, 'the hero never lands after a jump', S.air.y);
  }
}

// ---- pilots
// mode 'play' presses on the beat (press = offset in seconds), mode 'idle' never presses.
function pilot(seed, press, mode = 'play') {
  const S = mkState(seed);
  let presses = 0;
  for (let i = 0; i < 120 * 60 && !S.over; i++) {
    const nxt = nextObs(S);
    if (nxt && mode === 'play') {
      const tb = nxt.beat * SPB;
      // lane work first: a bar wants a free lane as early as the next beat
      if (nxt.kind === 'bar' && tb - S.t < 0.55 && nxt.lanes.includes(S.lane)) {
        const free = [0, 1, 2].find((l) => !nxt.lanes.includes(l));
        if (free !== undefined) moveLane(S, free - S.lane);
      }
      const at = tb + press;                     // press offset (negative = early)
      if (S.t < at && S.t + DT >= at) {
        if (nxt.kind === 'gate') pressJump(S);
        else if (nxt.kind === 'low') pressDuck(S);
        presses++;
      }
    }
    step(S, DT);
  }
  return { S, presses };
}

// ---- 3) a perfect pilot clears the whole song at 100% and wins
{
  const { S, presses } = pilot(7, 0);
  ok(S.over && S.won && S.why === 'song', 'a perfect pilot did not clear the song', { over: S.over, won: S.won, why: S.why, t: S.t, misses: S.misses });
  ok(S.misses === 0, 'a perfect pilot missed a beat', { misses: S.misses, hearts: S.hearts });
  ok(S.hearts === 3, 'a perfect pilot lost a heart', S.hearts);
  ok(accuracy(S) >= 99.9, 'a perfect pilot did not score 100% accuracy', accuracy(S));
  ok(S.perfect >= 10, 'a perfect pilot barely had any beats to hit', S.perfect);
  ok(S.grade === 'S', 'a perfect run is not graded S', S.grade);
  ok(S.maxCombo === S.judged, 'the combo did not survive the run', { maxCombo: S.maxCombo, judged: S.judged });
  const scoreOk = S.score > S.judged * 300;
  ok(scoreOk, 'the combo multiplier never applied', { score: S.score, judged: S.judged });
  console.log(`perfect: hazards=${S.judged} presses=${presses} score=${S.score} acc=${accuracy(S)}% grade=${S.grade}`);
}

// ---- 4) an idle pilot loses every heart and never wins
{
  const { S } = pilot(7, 0, 'idle');
  ok(S.over && !S.won && S.why === 'hearts', 'an idle pilot did not lose on hearts', { over: S.over, won: S.won, why: S.why });
  ok(S.hearts === 0, 'an idle pilot kept a heart', S.hearts);
  ok(S.misses >= 3, 'an idle pilot lost fewer than three beats', S.misses);
  ok(S.perfect === 0 && S.good === 0, 'an idle pilot was credited a timed hit', { perfect: S.perfect, good: S.good });
  console.log(`idle: over=${S.over} why=${S.why} misses=${S.misses} t=${S.t.toFixed(1)}`);
}

// ---- 5) a late pilot scores strictly worse than a perfect one, and a sloppy one loses something
{
  const perfect = pilot(7, 0).S;
  for (const off of [0.15, -0.15, 0.35]) {
    const { S } = pilot(7, off);
    ok(accuracy(S) < accuracy(perfect), `press ${off}s off the beat scored as well as perfect`, { off, acc: accuracy(S) });
  }
  const sloppy = pilot(7, 0.6).S;
  ok(sloppy.misses > 0 || accuracy(sloppy) < 90, 'a half-second-late pilot looked competent', { acc: accuracy(sloppy), misses: sloppy.misses });
  ok(sloppy.score < perfect.score, 'a late pilot outscored a perfect one');
  console.log(`late0.6: acc=${accuracy(sloppy)}% misses=${sloppy.misses} won=${sloppy.won}`);
}

// ---- 6) a bar is dodged only by leaving its lane
{
  const mk = (lane) => {
    const S = mkState(7);
    S.t = 10; S.lane = lane;
    S.obs = [{ beat: (10 + 1.0) / SPB, kind: 'bar', lanes: [1], done: false, res: '' }];
    return S;
  };
  const A = mk(1);
  for (let i = 0; i < 240; i++) step(A, DT);
  ok(A.misses === 1 && A.hearts === 2, 'standing in a blocked lane did not cost a heart', { misses: A.misses, hearts: A.hearts });

  const B = mk(1);
  moveLane(B, 1);                      // step out to lane 2
  for (let i = 0; i < 240; i++) step(B, DT);
  ok(B.misses === 0 && B.hearts === 3 && B.barHits === 1, 'stepping out of the blocked lane did not dodge', { misses: B.misses, hearts: B.hearts, barHits: B.barHits });
  ok(accuracy(B) === 100, 'a dodge is not worth a timed hit', accuracy(B));
}

// ---- 7) accuracy / grade helpers
{
  ok(gradeOf(100) === 'S' && gradeOf(95) === 'A' && gradeOf(85) === 'B' && gradeOf(50) === 'C', 'grade thresholds drifted');
  const S = mkState(7);
  ok(accuracy(S) === 100, 'an unplayed song does not read 100%', accuracy(S));
  ok(!S.over && !S.won, 'a fresh state starts terminal');
  ok(S.obs.length > 8, 'a fresh state has no song', S.obs.length);
}

// ---- 8) every seed is winnable by the perfect pilot (no unwinnable deal)
{
  let won = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const { S } = pilot(seed, 0);
    if (S.won && S.misses === 0) won++;
  }
  ok(won === 25, 'a generated song is unwinnable for the perfect pilot', { won });
  console.log(`seeds: ${won}/25 cleared perfectly`);
}

console.log(fails ? `CORE FAIL (${fails})` : 'CORE PASS');
process.exit(fails ? 1 : 0);
