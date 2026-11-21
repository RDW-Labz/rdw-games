#!/usr/bin/env node
// Core test for the Life RPG port (Life RPG card, com.arcom.life_rpg).
// Slices the // >>>CORE block out of the shipped HTML and replays it, so the day boards proven
// here are built by the exact code the browser runs: the 999-level XP curve, the title ladder,
// the seeded deal, and the win/lose adjudication (including "every early day is winnable").
// usage: node life-rpg-core-test.mjs [port-html]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/life-rpg/index.html';
const html = await readFile(SRC, 'utf8');
const start = html.indexOf('// >>>CORE');
const end = html.indexOf('// <<<CORE');
if (start < 0 || end < 0 || end <= start) { console.error('no CORE block (check the <<<CORE end marker)'); process.exit(1); }
const core = html.slice(start, end);
const extra = `
export { MAX_LEVEL, SLOTS, TIERS, QUEST_POOL, TITLES, GOLD_RATE, XP_AT, needFor, levelFromXp, xpInLevel,
  titleFor, questXp, questCost, dayGoal, dayEnergy, bestPlan, mulberry32, mixSeed, dealBoard, dayOutcome };
`;
const tmp = join(tmpdir(), `life-core-${process.pid}.mjs`);
await writeFile(tmp, core + extra);
const M = await import(pathToFileURL(tmp).href);

let fails = 0;
const ok = (cond, msg, extra) => { if (!cond) { fails++; console.error('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); } };
const T = (m) => console.error('  ' + m);

// --- 1. the 999-level curve ---
ok(M.MAX_LEVEL === 999, 'level cap is 999', M.MAX_LEVEL);
ok(M.XP_AT.length === M.MAX_LEVEL + 1, 'XP table covers every level', M.XP_AT.length);
let mono = true;
for (let L = 2; L <= M.MAX_LEVEL; L++) if (!(M.XP_AT[L] > M.XP_AT[L - 1])) mono = false;
ok(mono, 'cumulative XP is strictly increasing over 999 levels');
ok(M.levelFromXp(0) === 1, 'zero XP is level 1', M.levelFromXp(0));
ok(M.levelFromXp(M.XP_AT[999]) === 999, 'XP_AT[999] reads level 999');
ok(M.levelFromXp(M.XP_AT[999] - 1) === 998, 'one XP short of 999 reads level 998');
ok(M.levelFromXp(M.XP_AT[500]) === 500 && M.levelFromXp(M.XP_AT[500] + M.needFor(500) - 1) === 500
  && M.levelFromXp(M.XP_AT[500] + M.needFor(500)) === 501, 'level boundaries are exact at level 500');
// a full climb reaches 999 and never leaves the level window
{ let xp = 0, maxSeen = 1;
  for (let k = 1; k < 2000; k++) { xp += M.needFor(Math.min(998, k)); maxSeen = Math.max(maxSeen, M.levelFromXp(xp)); }
  ok(maxSeen === 999, 'grinding XP reaches the cap', maxSeen);
  const w = M.xpInLevel(M.XP_AT[700] + 3);
  ok(w.level === 700 && w.into === 3 && w.span === M.needFor(700), 'xpInLevel reports the window', w);
}

// --- 2. titles ---
ok(M.titleFor(1).title === 'Novice', 'level 1 is Novice', M.titleFor(1));
ok(M.titleFor(999).title === 'Worldbreaker', 'level 999 is Worldbreaker', M.titleFor(999));
let rankOk = true, prevTitle = null, ladder = true;
for (let L = 1; L <= M.MAX_LEVEL; L++) {
  const t = M.titleFor(L);
  if (prevTitle !== null && t.rank < prevTitle) rankOk = false;
  prevTitle = t.rank;
}
for (let k = 1; k < M.TITLES.length; k++) if (!(M.TITLES[k][0] > M.TITLES[k - 1][0])) ladder = false;
ok(rankOk, 'title rank never goes backwards as level climbs');
ok(ladder, 'title thresholds ascend', M.TITLES.map((t) => t[0]));
ok(M.TITLES[0][0] === 1 && M.TITLES[M.TITLES.length - 1][0] === 999, 'the ladder spans level 1 to 999');

// --- 3. the deal ---
const a = M.dealBoard(1234, 3), b = M.dealBoard(1234, 3), c = M.dealBoard(1235, 3);
ok(JSON.stringify(a) === JSON.stringify(b), 'the same seed and day deal the same board');
ok(JSON.stringify(a) !== JSON.stringify(c), 'a different seed deals a different board');
ok(a.length === M.SLOTS, 'six quests per day', a.length);
const tierCount = [0, 0, 0, 0, 0];
for (const q of a) tierCount[q.tier]++;
ok(tierCount.every((n) => n >= 1), 'every tier appears on the board', tierCount);
let golds = 0, deals = 0, textOk = true;
for (let s = 1; s <= 4000; s++) {
  for (const q of M.dealBoard(s, 1 + (s % 9))) {
    deals++;
    if (q.golden) golds++;
    if (!M.QUEST_POOL[q.tier].includes(q.text)) textOk = false;
    if (!(M.TIERS[q.tier].cost >= 1 && M.TIERS[q.tier].xp > 0)) textOk = false;
    if (q.golden && M.questXp(q) !== M.TIERS[q.tier].xp * 2) textOk = false;
    if (!q.golden && M.questXp(q) !== M.TIERS[q.tier].xp) textOk = false;
  }
}
const rate = golds / deals;
ok(textOk, 'every quest text comes from its own tier pool and pays its tier XP');
ok(rate > 0.08 && rate < 0.28, 'gold rate is a chase, not the norm', rate.toFixed(3));

// --- 4. every early day is winnable inside its energy budget ---
const levels = [1, 5, 10, 30, 60];
let winnable = true, checked = 0, worst = null;
for (const level of levels) {
  for (let streak = 0; streak <= 3; streak++) {
    const goal = M.dayGoal(streak), energy = M.dayEnergy(level);
    ok(goal <= 150, 'the goal is capped at 150 xp', { streak, goal });
    for (let s = 1; s <= 300; s++) {
      const qs = M.dealBoard(s * 7919, 1 + (s % 4));
      const plan = M.bestPlan(qs, energy, goal);
      checked++;
      if (!plan) { winnable = false; worst = { level, streak, goal, energy, seed: s * 7919 }; }
    }
  }
}
ok(winnable, `all ${checked} early-day boards can clear their goal`, worst);

// --- 5. adjudication: a plan wins, an empty wallet loses, a cleared board wins ---
{
  const qs = M.dealBoard(4242, 1);
  const goal = M.dayGoal(0), energy = M.dayEnergy(1);
  const plan = M.bestPlan(qs, energy, goal);
  ok(plan, 'seed 4242 day 1 has a winning plan');
  let e = energy, xpGain = 0;
  for (const i of plan.pick) { e -= M.questCost(qs[i]); xpGain += M.questXp(qs[i]); qs[i].done = true; }
  ok(e >= 0, 'the plan never overspends energy', e);
  ok(xpGain >= goal, 'the plan clears the goal', { xpGain, goal });
  ok(M.dayOutcome(qs, e, xpGain, goal) === 'win', 'the plan adjudicates as a win');

  const spent = M.dealBoard(77, 1);
  ok(M.dayOutcome(spent, 0, 0, 150) === 'lose', 'zero energy with open quests adjudicates as burnout');
  const cleared = spent.map((q) => ({ ...q, done: true }));
  ok(M.dayOutcome(cleared, 0, 10, 150) === 'win', 'a fully cleared board wins even under the goal');
  ok(M.dayOutcome(spent, 5, 0, 150) === null, 'a live board is neither a win nor a burnout');
}

// --- 6. the numbers the gate leans on ---
ok(M.dayEnergy(1) === 9 && M.dayEnergy(999) === 13, 'energy starts at 9 and caps at 13', [M.dayEnergy(1), M.dayEnergy(999)]);
ok(M.dayGoal(0) === 60 && M.dayGoal(3) === 120 && M.dayGoal(99) === 150, 'goal ladder: 60, 120, cap 150', [M.dayGoal(0), M.dayGoal(3), M.dayGoal(99)]);

// Hand the gate a seed whose best day-1 plan is two taps, so the win is proven by real clicks.
let pickSeed = null;
for (let s = 1; s < 5000 && !pickSeed; s++) {
  const qs = M.dealBoard(s, 1);
  const plan = M.bestPlan(qs, M.dayEnergy(1), M.dayGoal(0));
  if (plan && plan.pick.length === 2) pickSeed = { seed: s, pick: plan.pick, cost: plan.cost, xp: plan.xp, tiers: plan.pick.map((i) => qs[i].tier) };
}
ok(pickSeed !== null, 'a two-tap day-1 seed exists for the gate');
console.log(JSON.stringify({
  ok: fails === 0, fails, goldRate: +rate.toFixed(4), checked,
  winSeed: pickSeed,
  curve: { need1: M.needFor(1), need500: M.needFor(500), need999: M.needFor(998), total999: M.XP_AT[999] },
}, null, 1));
process.exit(fails ? 1 : 0);
