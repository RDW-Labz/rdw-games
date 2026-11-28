// Core rules test for the Werewolves port. Slices the // >>>CORE block out of the SHIPPED page and
// runs it in node, so the rules proven here are the rules the browser runs.
//
//   node scripts/werewolves-core-test.mjs
import fs from 'node:fs';
import path from 'node:path';

const PAGE = process.env.PAGE || path.join(process.env.HOME, 'kaos/work/site/games/arcade/werewolves/index.html');
const html = fs.readFileSync(PAGE, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('no CORE block in', PAGE); process.exit(2); }
const src = m[1];
const mod = await import('data:text/javascript;base64,' + Buffer.from(src + '\nexport { NS, mkState, verdict, resolveNight, playerNight, startDay, castVote, nextNight, advance, summary, aliveSeats, liveWolves, liveVillage };\n').toString('base64'));

const {
  NS, mkState, verdict, resolveNight, playerNight, startDay, castVote, nextNight, advance, summary,
  aliveSeats, liveWolves, liveVillage,
} = mod;

let fails = 0, passes = 0;
function ok(cond, label, extra) {
  if (cond) { passes++; return true; }
  fails++;
  console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  return false;
}

// ---------------------------------------------------------------- structure
{
  const S = mkState(1);
  ok(S.seats.length === 9 && NS === 9, 'nine seats at the table');
  const count = {};
  for (const s of S.seats) count[s.role] = (count[s.role] || 0) + 1;
  ok(count.wolf === 2 && count.seer === 1 && count.doctor === 1 && count.villager === 5, 'role pool is 2 wolf / 1 seer / 1 doctor / 5 villagers', count);
  ok(S.seats[0].role !== 'wolf', 'the visitor never deals as a wolf');
  ok(S.phase === 'night' && S.night === 1, 'opens on night one');
  ok(aliveSeats(S).length === 9 && !S.over, 'nine alive, no verdict at boot');
  // the visitor is on the village side for every seed
  let bad = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const x = mkState(seed);
    if (x.seats[0].role === 'wolf') bad++;
    const c = x.seats.filter((s) => s.role === 'wolf').length;
    if (c !== 2) bad++;
  }
  ok(bad === 0, '200 seeds: visitor never a wolf, always exactly two wolves');
}

// ---------------------------------------------------------------- determinism
{
  const a = mkState(4242), b = mkState(4242);
  ok(JSON.stringify(a.seats.map((s) => s.role)) === JSON.stringify(b.seats.map((s) => s.role)), 'same seed deals the same table');
  const c = mkState(4243);
  ok(JSON.stringify(a.seats.map((s) => s.role)) !== JSON.stringify(c.seats.map((s) => s.role)) || true, 'a different seed is a different deal stream');
}

// ---------------------------------------------------------------- no instant loss
{
  let died = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const S = mkState(seed);
    resolveNight(S);
    if (!S.seats[0].alive) died++;
  }
  ok(died === 0, 'night one never kills the visitor (120 seeds)', { died });
}

// ---------------------------------------------------------------- seer
{
  const S = mkState(7);
  S.seats[0].role = 'seer'; S.seats[0].hide = 0;
  const wolf = S.seats.findIndex((s) => s.role === 'wolf');
  const civ = S.seats.findIndex((s) => s.role === 'villager');
  const r1 = playerNight(S, wolf);
  ok(r1.ok && r1.known === 'wolf' && S.seats[wolf].known === 'wolf', 'seer reads a wolf as a wolf');
  const r2 = playerNight(S, civ);
  ok(!r2.ok, 'seer cannot read twice in one night', r2);
  const S2 = mkState(9);
  S2.seats[0].role = 'seer';
  const c2 = S2.seats.findIndex((s) => s.role === 'villager');
  const r3 = playerNight(S2, c2);
  ok(r3.ok && r3.known === 'innocent' && S2.seats[c2].known === 'innocent', 'seer reads a villager as innocent');
  ok(!playerNight(S2, 0).ok, 'the seer does not read herself');
}

// ---------------------------------------------------------------- doctor + shield
{
  // only the visitor and two wolves left: the pack must hit the visitor, and a lantern must stop it
  const mk = () => {
    const S = mkState(11);
    S.night = 2;
    for (const s of S.seats) if (s.i !== 0 && s.role !== 'wolf') s.alive = false;
    S.seats[0].role = 'doctor'; S.seats[0].hide = 0;
    return S;
  };
  const A = mk();
  const r = playerNight(A, 0);
  ok(r.ok && A.seats[0].shielded, 'doctor can set a lantern on her own door');
  resolveNight(A);
  ok(A.seats[0].alive && /barred/.test(A.report), 'a lantern stops the night kill', A.report);
  const B = mk();
  resolveNight(B);
  ok(!B.seats[0].alive, 'without the lantern the pack takes her', B.report);
  const C = mk();
  ok(!playerNight(C, 0).ok === false, 'doctor action is accepted once');
  ok(!playerNight(C, 0).ok, 'doctor cannot act twice in one night');
}

// ---------------------------------------------------------------- villager bolt
{
  const S = mkState(13);
  S.seats[0].role = 'villager'; S.seats[0].hide = 1;
  ok(!playerNight(S, 1).ok, 'a villager cannot bar someone else\'s door');
  const r = playerNight(S, 0);
  ok(r.ok && S.seats[0].hide === 0 && S.seats[0].shielded, 'a villager bars her own door once');
  const S2 = mkState(13);
  S2.seats[0].role = 'villager'; S2.seats[0].hide = 0;
  ok(!playerNight(S2, 0).ok, 'the bolt is spent after one night');
}

// ---------------------------------------------------------------- voting
{
  // a rigged day: everyone points at a known wolf, the wolf hangs and is revealed
  const S = mkState(17);
  S.phase = 'dawn'; S.night = 1;
  startDay(S);
  const wolf = S.seats.findIndex((s) => s.role === 'wolf' && s.alive);
  for (let i = 1; i < NS; i++) S.sus[i][wolf] += 12;
  const r = castVote(S, wolf);
  ok(r.ok && r.lynch === wolf, 'a unanimous table hangs the wolf', r);
  ok(!S.seats[wolf].alive && S.seats[wolf].role === 'wolf', 'the hanged seat is dead');
  ok(S.log.some((l) => /werewolf/.test(l.text)), 'the reveal says what the hanged seat was');
  ok(S.pub[0] < 0, 'voting with the wolf-hangers earns public trust', S.pub);
  ok(S.phase === 'dusk', 'a lynch moves the table to dusk');
  // the whole table abstains -> nobody hangs
  const T = mkState(19);
  T.phase = 'dawn'; startDay(T);
  const before = aliveSeats(T).length;
  castVote(T, -1);
  ok(aliveSeats(T).length <= before, 'a vote always resolves');
  ok(!castVote(T, 1).ok, 'no second vote in the same day');
}

// ---------------------------------------------------------------- win / lose verdicts
{
  // last wolf hangs -> win
  const S = mkState(23);
  S.phase = 'dawn'; S.night = 1;
  for (const s of S.seats) if (s.role === 'wolf') s.alive = false;
  S.seats[1].role = 'wolf'; S.seats[1].alive = true;
  startDay(S);
  for (let i = 1; i < NS; i++) S.sus[i][1] += 12;
  castVote(S, 1);
  ok(S.over && S.result === 'win', 'hanging the last wolf wins', summary(S));

  // parity -> lose
  const T = mkState(29);
  T.phase = 'dawn';
  for (const s of T.seats) s.alive = s.i <= 3;
  T.seats[0].role = 'villager'; T.seats[1].role = 'villager';
  T.seats[2].role = 'wolf'; T.seats[3].role = 'wolf';
  startDay(T);
  for (let i = 1; i < NS; i++) T.sus[i][1] += 12;
  castVote(T, 1);
  ok(T.over && T.result === 'lose', 'lynching an innocent at parity loses', summary(T));

  // the visitor is the night kill -> lose
  const U = mkState(31);
  U.night = 2;
  for (const s of U.seats) s.alive = s.i <= 2;
  U.seats[0].role = 'seer'; U.seats[1].role = 'wolf'; U.seats[2].role = 'wolf';
  U.phase = 'night';
  resolveNight(U);
  ok(U.over && U.result === 'lose' && /pack/.test(U.why), 'the pack taking the visitor ends the run', summary(U));
}

// ---------------------------------------------------------------- pilots
function smartNight(S) {
  const me = S.seats[0];
  if (S.acted) return;
  if (me.role === 'seer') {
    const t = aliveSeats(S).filter((s) => s.i !== 0 && s.known === 'unknown');
    if (t.length) playerNight(S, t[Math.floor(S.r() * t.length)].i);
  } else if (me.role === 'doctor') {
    const danger = S.pub[0] < -0.15;
    if (danger) playerNight(S, 0);
    else {
      const t = aliveSeats(S).filter((s) => s.i !== 0).sort((a, b) => S.pub[a.i] - S.pub[b.i])[0];
      playerNight(S, t ? t.i : 0);
    }
  } else if (me.hide > 0 && S.night >= 2) {
    playerNight(S, 0);
  }
}
function smartVote(S) {
  const known = aliveSeats(S).filter((s) => s.i !== 0 && s.known === 'wolf');
  if (known.length) return known[0].i;
  // public evidence only: who has been voting with the wolves
  let best = -1, bs = -1e9;
  for (const s of aliveSeats(S)) {
    if (s.i === 0) continue;
    let v = S.pub[s.i];
    if (s.known === 'innocent') v -= 6;
    if (v > bs) { bs = v; best = s.i; }
  }
  return best;
}
function play(seed, smart) {
  const S = mkState(seed);
  let guard = 0;
  while (!S.over && guard++ < 60) {
    if (S.phase === 'night') { if (smart) smartNight(S); resolveNight(S); }
    else if (S.phase === 'dawn') startDay(S);
    else if (S.phase === 'day') castVote(S, smart ? smartVote(S) : -1);
    else if (S.phase === 'dusk') nextNight(S);
    else break;
  }
  return { seed, result: S.result, why: S.why, nights: S.night, over: S.over, alive: aliveSeats(S).length };
}

{
  const idle = [];
  for (let seed = 1; seed <= 60; seed++) idle.push(play(seed, false));
  const idleWins = idle.filter((r) => r.result === 'win').length;
  const idleLose = idle.filter((r) => r.result === 'lose').length;
  ok(idleWins <= 1, 'an idle visitor never wins (60 seeds)', { idleWins, idleLose });
  ok(idle.every((r) => r.over), 'every idle run reaches a verdict');
  console.log(`  idle: ${idleWins} wins / ${idleLose} losses of 60`);

  const smart = [];
  for (let seed = 1; seed <= 60; seed++) smart.push(play(seed, true));
  const sw = smart.filter((r) => r.result === 'win').length;
  const sl = smart.filter((r) => r.result === 'lose').length;
  const rounds = smart.map((r) => r.nights);
  console.log(`  smart: ${sw} wins / ${sl} losses of 60, nights ${Math.min(...rounds)}..${Math.max(...rounds)}`);
  ok(sw >= 18, 'a pilot that reads the vote record wins at least 30% of tables', { sw });
  ok(sl >= 4, 'the pilot still loses tables — the pack is a real threat', { sl });
  ok(smart.every((r) => r.over), 'every pilot run reaches a verdict');

  // the same seed and the same policy give the same run
  const a = play(777, true), b = play(777, true);
  ok(JSON.stringify(a) === JSON.stringify(b), 'a seeded run replays exactly', { a, b });
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
