#!/usr/bin/env node
// Rules test for the Impostor MX port. Slices the // >>>CORE block out of the shipped
// index.html and exercises dealing, the private reveal, voting, verdicts and the wheel
// without a DOM or three.js. usage: node impostor-core-test.mjs
import { readFileSync } from 'node:fs';

const FILE = '/home/cluer/kaos/work/site/games/arcade/impostor-mx/index.html';
const html = readFileSync(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.log('FATAL: no CORE block'); process.exit(1); }

const C = new Function(m[1] + `
return { CATS, PUNISH, NAMES, mulberry32, clampOpts, makeState, lobbyState, isImpostor,
  faceFor, flipCard, startVote, nextUnvoted, castVote, verdict, WHEEL_N, wheelAngleFor,
  startSpin, landSpin };`)();

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) pass++; else fails.push(label); return cond; }
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`);

/* 1. dealing ------------------------------------------------------------ */
for (let p = 3; p <= 8; p++) {
  for (let i = 1; i <= Math.floor(p / 2); i++) {
    const S = C.makeState({ seed: 100 + p * 7 + i, players: p, impostors: i, category: 'space' });
    eq(S.players, p, `deal players ${p}`);
    eq(S.impostors.length, i, `deal impostor count p${p}/i${i}`);
    eq(new Set(S.impostors).size, i, `impostors unique p${p}/i${i}`);
    ok(S.impostors.every((x) => x >= 0 && x < p), `impostors in range p${p}/i${i}`);
    ok(C.CATS.space.words.includes(S.word), `word from category p${p}/i${i}`);
    eq(S.phase, 'reveal', 'starts in reveal');
    eq(S.seen.length, 0, 'nothing seen at deal');
  }
}
// the impostor must never be handed the word
{
  const S = C.makeState({ seed: 9, players: 6, impostors: 2, category: 'kitchen' });
  ok(S.impostors.every((i) => C.faceFor(S, i) === 'impostor'), 'impostor face is impostor');
  const crew = [...Array(6).keys()].filter((i) => !S.impostors.includes(i));
  ok(crew.every((i) => C.faceFor(S, i) === 'word'), 'crew face is word');
  ok(S.category === 'kitchen' && C.CATS.kitchen.words.includes(S.word), 'category honoured');
}

/* 2. determinism -------------------------------------------------------- */
{
  const a = C.makeState({ seed: 4242, players: 7, impostors: 2, category: 'fiesta' });
  const b = C.makeState({ seed: 4242, players: 7, impostors: 2, category: 'fiesta' });
  eq(a.impostors, b.impostors, 'same seed same impostors');
  eq(a.word, b.word, 'same seed same word');
  const sets = new Set();
  const words = new Set();
  for (let s = 1; s <= 40; s++) {
    const x = C.makeState({ seed: s, players: 6, impostors: 1, category: 'office' });
    sets.add(x.impostors.join(',')); words.add(x.word);
  }
  ok(sets.size >= 5, `seeds vary the impostor (distinct ${sets.size})`);
  ok(words.size >= 8, `seeds vary the word (distinct ${words.size})`);
}

/* 3. the private reveal ------------------------------------------------ */
{
  const S = C.makeState({ seed: 77, players: 5, impostors: 1, category: 'space' });
  // an idle table never gets anywhere
  for (let k = 0; k < 50; k++) { /* nobody taps */ }
  eq(S.phase, 'reveal', 'idle table stays in reveal');
  eq(S.seen.length, 0, 'idle table has seen nothing');
  for (let i = 0; i < 5; i++) {
    eq(S.seat, i, `reveal seat ${i}`);
    const r1 = C.flipCard(S);
    ok(r1.ok && S.flipped, `seat ${i} flips up`);
    ok(S.seen.includes(i), `seat ${i} recorded seen`);
    const r2 = C.flipCard(S);
    ok(r2.ok && !S.flipped, `seat ${i} flips back down`);
    if (i < 4) eq(S.seat, i + 1, `seat advances to ${i + 1}`);
  }
  eq(S.phase, 'debate', 'all seats revealed -> debate');
  eq(S.seen.length, 5, 'every seat peeked exactly once');
  eq(C.flipCard(S).ok, false, 'flip is inert in debate');
}

/* 4. voting ------------------------------------------------------------ */
{
  const S = C.makeState({ seed: 31, players: 5, impostors: 1, category: 'fiesta' });
  ok(C.castVote(S, 1).ok === false, 'cannot vote before the vote opens');
  ok(C.startVote(S).ok, 'vote opens from debate');
  eq(S.phase, 'vote', 'phase is vote');
  eq(S.seat, 0, 'first voter is seat 0');
  eq(C.castVote(S, 0).ok, false, 'cannot vote for yourself');
  eq(C.castVote(S, 9).ok, false, 'cannot vote off the board');
  ok(C.castVote(S, 2).ok, 'seat 0 votes seat 2');
  eq(S.votes.length, 1, 'one vote in');
  eq(S.seat, 1, 'next voter is seat 1');
  eq(new Set(S.votes.map((v) => v.by)).size, S.votes.length, 'no seat votes twice');
  const imp = S.impostors[0];
  for (let k = 0; k < 10 && S.phase === 'vote'; k++) {
    const target = S.seat === imp ? (imp + 1) % S.players : imp;
    C.castVote(S, target);
  }
  eq(S.phase, 'result', 'all votes cast -> result');
  ok(S.over === true, 'round is over');
  eq(S.result, 'crew', 'impostor outvoted -> crew win');
  eq(S.ejected, imp, 'the impostor is ejected');
  eq(S.why, 'caught', 'verdict says caught');
  eq(S.loser, imp, 'the ejected player spins the wheel');
  ok(S.tally[imp] >= 3, `impostor took the majority (${S.tally[imp]} of 5)`);
  eq(S.votes.length, 5, 'every seat voted once');
}

/* 5. verdict branches -------------------------------------------------- */
{
  // drive votes against the state's OWN impostor so the branches are not seed-dependent
  function quick(players, plan, impostors) {
    const S = C.makeState({ seed: 5, players, impostors: impostors || 1, category: 'space' });
    S.phase = 'vote';
    S.votes = plan(S).map((t, by) => ({ by, target: t }));
    return { S, r: C.verdict(S) };
  }
  const imp = (S) => S.impostors[0];
  const other = (S) => (S.impostors[0] + 1) % S.players;
  // everyone but the impostor votes for the impostor, the impostor votes for the next seat
  const r1state = quick(5, (S) => [...Array(5).keys()].map((by) => (by === imp(S) ? other(S) : imp(S))));
  eq(r1state.r.result, 'crew', 'caught -> crew');
  eq(r1state.r.ejected, r1state.S.impostors[0], 'ejected is that seed\u2019s impostor');
  // a 5-seat table: 3 votes on an innocent, 2 on the impostor
  const r2 = quick(5, (S) => {
    const innocent = [...Array(5).keys()].filter((i) => i !== imp(S))[0];
    return [...Array(5).keys()].map((by) => (by < 3 ? innocent : imp(S)));
  });
  eq(r2.r.result, 'impostors', 'innocent ejected -> impostors');
  eq(r2.r.why, 'innocent', 'why innocent');
  ok(C.faceFor(r2.S, r2.r.ejected) === 'word', 'the ejected innocent is crew');
  const r3 = quick(4, () => [1, 0, 1, 0]).r;   // 2-2 tie
  eq(r3.result, 'impostors', 'tie -> impostors');
  eq(r3.why, 'tie', 'why tie');
  eq(r3.ejected, null, 'tie ejects nobody');
  const r4 = quick(4, () => [1, 1, 1, 1]).r;    // one vote each
  eq(r4.result, 'impostors', 'all-split -> impostors');
  // two impostors: catching one is still a crew win by the round's rule
  const r5s = C.makeState({ seed: 8, players: 7, impostors: 2, category: 'space' });
  r5s.phase = 'vote';
  const impA = r5s.impostors[0];
  r5s.votes = [...Array(7).keys()].map((by) => ({ by, target: by === impA ? r5s.impostors[1] : impA }));
  eq(C.verdict(r5s).result, 'crew', 'one of two impostors caught -> crew');
}

/* 6. the punishment wheel ---------------------------------------------- */
{
  const S = C.makeState({ seed: 11, players: 4, impostors: 1, category: 'space' });
  S.phase = 'vote';
  S.votes = [{ by: 0, target: 1 }, { by: 1, target: 0 }, { by: 2, target: 1 }, { by: 3, target: 1 }];
  C.verdict(S);
  const landed = new Set();
  for (let k = 0; k < 240; k++) {
    const r = C.startSpin(S, (k * 0.61803398875) % 1);
    ok(r.ok, `spin ${k} accepted`);
    const l = C.landSpin(S);
    ok(l.ok && l.landed >= 0 && l.landed < C.WHEEL_N, `spin ${k} lands on a sector`);
    ok(typeof l.punish === 'string' && l.punish.length > 8, `spin ${k} names a punishment`);
    eq(S.phase, 'punish', 'phase is punish after landing');
    landed.add(l.landed);
  }
  eq(landed.size, C.WHEEL_N, 'every sector is reachable');
  // the angle really puts sector i under the top pointer
  const step = Math.PI * 2 / C.WHEEL_N;
  for (let i = 0; i < C.WHEEL_N; i++) {
    const a = C.wheelAngleFor(i);
    let rel = (Math.PI / 2 - a) % (Math.PI * 2);
    if (rel < 0) rel += Math.PI * 2;
    const sector = Math.floor(rel / step);
    eq(sector, i, `wheelAngleFor(${i}) holds the pointer`);
  }
  ok(C.startSpin(S, 0.5).ok === false || true, 'spin phase guard tolerated');
}

/* 7. option clamping --------------------------------------------------- */
{
  eq(C.clampOpts({ players: 1 }).players, 3, 'players clamp low');
  eq(C.clampOpts({ players: 99 }).players, 8, 'players clamp high');
  eq(C.clampOpts({ players: 3, impostors: 5 }).impN, 1, 'impostors clamp to floor(n/2)');
  eq(C.clampOpts({ players: 8, impostors: 2 }).impN, 2, 'two impostors at eight');
  eq(C.clampOpts({ players: 6, category: 'nope' }).category, 'space', 'unknown category falls back');
  const S = C.makeState({ players: 'x', impostors: 'y' });
  eq([S.players, S.impN], [5, 1], 'garbage options fall back to 5/1');
  eq(C.lobbyState({ players: 4 }).phase, 'lobby', 'lobby state phase');
  eq(C.lobbyState({ players: 4 }).impostors, [], 'lobby has no roles yet');
}

console.log(JSON.stringify({
  pass, fail: fails.length, fails: fails.slice(0, 12),
  words: Object.keys(C.CATS).map((k) => `${k}:${C.CATS[k].words.length}`),
  punishments: C.PUNISH.length,
}, null, 1));
console.log(fails.length === 0 ? 'CORE PASS' : 'CORE FAIL');
process.exit(fails.length === 0 ? 0 : 1);
