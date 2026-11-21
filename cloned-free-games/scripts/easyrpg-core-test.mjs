#!/usr/bin/env node
// Proves the EasyRPG Player port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/easyrpg-player/index.html.
// Checks, per seed: the carved map is fully connected, the cast stands on floor and is
// distinct, every chest and the shrine are reachable from the start, walking refuses
// walls and villagers, the tap-stepper never hands back a wall, a chest pays its seal
// once only, the shrine refuses a short party and wins a full one, the encounter clock
// only fires on a spent counter, the battle maths respects its ranges and its guards,
// and a 500-turn soak keeps every value in bounds.
//
// usage: node easyrpg-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/easyrpg-player/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + `
export { N, SEALS_NEEDED, MONSTERS, mulberry32, makeMap, reach, canWalk, stepToward,
  placeCast, rollDie, newRun, startBattle, playerAct, enemyTurn, winBattle, walk, arrive };`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const {
  N, SEALS_NEEDED, MONSTERS, mulberry32, makeMap, reach, canWalk, stepToward,
  placeCast, rollDie, newRun, startBattle, playerAct, enemyTurn, winBattle, walk, arrive,
} = mod;

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };
const SEEDS = [1, 7, 1337, 42, 99, 2024, 555, 8080, 12345, 31337];

// ---- the map and the cast ------------------------------------------------
for (const seed of SEEDS) {
  const S = newRun(seed);
  const g = S.g;
  const dist = reach(g, S.hero.r, S.hero.c);
  let floors = 0, seen = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (g[r][c] === 0) { floors++; if (dist[r][c] >= 0) seen++; }
  }
  ok(floors > 40, `seed ${seed}: only ${floors} floor cells`);
  ok(seen === floors, `seed ${seed}: ${floors - seen} floor cells are walled off from the start`);
  ok(canWalk(g, S.hero.r, S.hero.c), `seed ${seed}: hero starts on a wall`);

  const spots = [...S.chests, S.shrine, ...S.npcs];
  const keys = new Set(spots.map((p) => p.r + ',' + p.c));
  ok(keys.size === spots.length, `seed ${seed}: two cast members share a cell`);
  for (const p of spots) {
    ok(canWalk(g, p.r, p.c), `seed ${seed}: cast member at ${p.r},${p.c} stands on a wall`);
    ok(dist[p.r][p.c] > 0, `seed ${seed}: cast member at ${p.r},${p.c} is unreachable`);
    ok(!(p.r === S.hero.r && p.c === S.hero.c), `seed ${seed}: cast member on the hero's start cell`);
  }
  ok(S.chests.length === SEALS_NEEDED, `seed ${seed}: ${S.chests.length} chests for ${SEALS_NEEDED} seals`);
  const maxD = Math.max(...S.chests.map((c) => dist[c.r][c.c]), dist[S.shrine.r][S.shrine.c]);
  ok(dist[S.shrine.r][S.shrine.c] >= 0.7 * maxD, `seed ${seed}: shrine is not near the far end (${dist[S.shrine.r][S.shrine.c]} vs max ${maxD})`);
  ok(S.hero.hp === S.hero.maxHp && S.hero.seals === 0, `seed ${seed}: hero does not start whole and seal-less`);
  ok(S.encounterIn >= 5, `seed ${seed}: encounter clock starts at ${S.encounterIn} — an instant fight`);
}

// ---- walking -------------------------------------------------------------
{
  const S = newRun(1337);
  S.hero.r = 1; S.hero.c = 1;
  const bad = walk(S, 0, 0) === false; // a zero step must not "succeed" into nothing
  ok(bad || S.hero.r === 1, 'a zero-length walk moved the hero');

  // walls refuse
  const wallDir = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dr, dc]) => !canWalk(S.g, 1 + dr, 1 + dc));
  if (wallDir) ok(walk(S, wallDir[0], wallDir[1]) === false, 'walking into a wall succeeded');

  // a villager's cell is not walkable even though its tile is floor
  const np = S.npcs[0];
  S.hero.r = np.r; S.hero.c = np.c === 0 ? 1 : np.c - 1;
  if (canWalk(S.g, np.r, np.c)) {
    const before = S.hero.c;
    walk(S, 0, Math.sign(np.c - S.hero.c));
    ok(S.hero.c === before, 'the hero walked through a villager');
  }

  // the tap-stepper only ever hands back an adjacent walkable cell
  const rng = mulberry32(5);
  for (let k = 0; k < 400; k++) {
    const R = newRun(SEEDS[k % SEEDS.length]);
    const hr = R.hero.r, hc = R.hero.c;
    const tr = Math.floor(rng() * N), tc = Math.floor(rng() * N);
    const s = stepToward(R.g, hr, hc, tr, tc);
    if (!s) continue;
    ok(canWalk(R.g, s[0], s[1]), 'stepToward returned a wall cell');
    ok(Math.abs(s[0] - hr) + Math.abs(s[1] - hc) === 1, 'stepToward returned a cell that is not adjacent');
  }
}

// ---- chests, shrine, seals ----------------------------------------------
{
  const S = newRun(1337);
  const rng = mulberry32(9);
  const ch = S.chests[0];
  S.hero.r = ch.r; S.hero.c = ch.c;
  const first = arrive(S, rng);
  ok(first && first.chest && first.seals === 1, 'stepping on a chest did not pay a seal');
  ok(S.hero.pots === 3, 'a chest did not hand over its potion');
  const second = arrive(S, rng);
  ok(!second || !second.chest, 'the same chest paid out twice');
  ok(S.hero.seals === 1, 'a chest paid more than one seal');

  // shrine with too few seals refuses
  const T = newRun(1337);
  T.hero.r = T.shrine.r; T.hero.c = T.shrine.c;
  T.hero.seals = 2;
  const short = arrive(T, rng);
  ok(short && short.needSeals && !T.over, 'the shrine opened for two seals');
  ok(!T.won, 'a short party read as a win');

  // shrine with three seals wins
  const U = newRun(1337);
  U.hero.r = U.shrine.r; U.hero.c = U.shrine.c;
  U.hero.seals = 3;
  const full = arrive(U, rng);
  ok(full && full.win && U.over && U.won, 'a full party stepping on the shrine did not win');
}

// ---- encounter clock -----------------------------------------------------
{
  const S = newRun(1337);
  const rng = mulberry32(11);
  S.encounterIn = 2;
  const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dr, dc]) => canWalk(S.g, S.hero.r + dr, S.hero.c + dc) && !S.npcs.some((n) => n.r === S.hero.r + dr && n.c === S.hero.c + dc));
  ok(!!dir, 'no open neighbour to walk into');
  walk(S, dir[0], dir[1]);
  const a = arrive(S, rng);
  ok(!a || !a.battle, 'a fight fired before the clock was spent');
  // walk somewhere else so a chest cannot swallow the trigger
  let guard = 0;
  while (S.encounterIn > 0 && guard++ < 20) {
    const d = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dr, dc]) => canWalk(S.g, S.hero.r + dr, S.hero.c + dc) && !S.npcs.some((n) => n.r === S.hero.r + dr && n.c === S.hero.c + dc) && !S.chests.some((c) => c.r === S.hero.r + dr && c.c === S.hero.c + dc));
    if (!d) break;
    walk(S, d[0], d[1]); arrive(S, rng);
  }
  ok(S.battle, 'the encounter clock never fired a fight');
  ok(S.encounterIn > 0, 'the encounter clock did not re-arm');
  ok(S.battle.hp > 0 && S.battle.hp0 === S.battle.hp, 'the fight opened with a broken hp bar');
}

// ---- battle maths --------------------------------------------------------
{
  const rng = mulberry32(3);
  const S = newRun(1337);
  S.battle = null;
  const b = startBattle(S, rng, 0);
  ok(b.name === MONSTERS[0].name, 'startBattle ignored the forced kind');
  ok(playerAct(S, rng, 'spell') .ok, 'the opening spell was refused');
  ok(S.hero.mp === S.hero.maxMp - 2, 'the spell did not cost 2 MP');
  const busy = playerAct(S, rng, 'attack');
  ok(busy.ok === false && busy.why === 'busy', 'a second action landed while the foe was replying');
  const e = enemyTurn(S, rng);
  ok(e.dmg >= b.dmg[0] && e.dmg <= b.dmg[1], 'the foe hit outside its damage range');
  ok(S.hero.hp === S.hero.maxHp - e.dmg, 'the foe hit did not land on the hero');
  ok(!b.awaiting, 'the battle stayed locked after the reply');

  // potion heals and refuses at zero
  S.hero.pots = 1; S.hero.hp = 10;
  const pot = playerAct(S, rng, 'potion');
  ok(pot.ok && S.hero.hp === 23 && S.hero.pots === 0, 'the potion did not heal 13 for one charge');
  enemyTurn(S, rng);
  const dry = playerAct(S, rng, 'potion');
  ok(dry.ok === false && dry.why === 'none', 'a potion was drunk with none left');

  // a spell with no MP is refused
  S.hero.mp = 1;
  const noMp = playerAct(S, rng, 'spell');
  ok(noMp.ok === false && noMp.why === 'mp', 'a spell went off on 1 MP');

  // kill path: a lethal hit ends the fight and pays the win
  S.battle = startBattle(S, rng, 0);
  S.battle.hp = 1;
  const kill = playerAct(S, rng, 'attack');
  ok(kill.killed, 'a 1-hp foe survived a strike');
  const name = winBattle(S);
  ok(typeof name === 'string' && !S.battle, 'winBattle left the fight standing');

  // run either flees or hands the turn back
  const R = newRun(1337);
  startBattle(R, mulberry32(8), 0);
  const rr = playerAct(R, mulberry32(8), 'run');
  ok(rr.ok, 'Run was refused');
  ok(rr.fled ? R.battle === null : R.battle.awaiting, 'Run neither fled nor handed the turn back');

  // level-up pay at 3 xp: one won fight is 3 xp, which is a level
  const L = newRun(1337);
  L.battle = startBattle(L, mulberry32(2), 0);
  const lvl0 = L.hero.lvl, hp0 = L.hero.maxHp, atk0 = L.hero.atk[1];
  winBattle(L);
  ok(L.hero.xp === 0 && L.hero.lvl === lvl0 + 1, 'the hero did not level after a first won fight (3 xp)');
  ok(L.hero.maxHp === hp0 + 6 && L.hero.atk[1] === atk0 + 1, 'the level-up did not raise max hp and attack');
}

// ---- 500-turn soak -------------------------------------------------------
{
  const S = newRun(2024);
  const rng = mulberry32(77);
  let turns = 0, fights = 0;
  for (let k = 0; k < 500; k++) {
    turns++;
    if (S.over) break;
    if (S.battle) {
      fights++;
      const acts = ['attack', 'spell', 'potion', 'attack'];
      const a = acts[k % acts.length];
      const r = playerAct(S, rng, a);
      if (r.ok && !r.killed && !r.fled) {
        const e = enemyTurn(S, rng);
        if (e && e.dead) break;
      } else if (r.killed) winBattle(S);
      continue;
    }
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const d = dirs.find(([dr, dc]) => canWalk(S.g, S.hero.r + dr, S.hero.c + dc) && !S.npcs.some((n) => n.r === S.hero.r + dr && n.c === S.hero.c + dc));
    if (!d) break;
    walk(S, d[0], d[1]);
    arrive(S, rng);
    ok(S.hero.hp >= 0 && S.hero.hp <= S.hero.maxHp, 'hp left its bounds during the soak');
    ok(S.hero.seals >= 0 && S.hero.seals <= SEALS_NEEDED, 'seals left their bounds during the soak');
    ok(S.hero.pots >= 0, 'potions went negative during the soak');
  }
  ok(turns > 40, 'the soak stalled almost immediately');
  console.log(`soak: ${turns} turns, ${fights} fight actions, hp ${S.hero.hp}/${S.hero.maxHp}, seals ${S.hero.seals}, lvl ${S.hero.lvl}`);
}

if (fails) { console.error(`\nFAILED — ${fails} assertion(s)`); process.exit(1); }
console.log('\nOK — EasyRPG core rules pass on ' + SEEDS.length + ' seeds');
