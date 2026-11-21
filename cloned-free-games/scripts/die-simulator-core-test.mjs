#!/usr/bin/env node
// Proves the Die Simulator table with the exact code the browser runs: the
// // >>>CORE ... // <<<CORE block is sliced out of games/arcade/die-simulator/index.html.
//
// usage: node die-simulator-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/die-simulator/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { TARGET, HOUSE_HOLD, mulberry32, faceOf, addFace, bankTurn, houseWants };';
const { TARGET, HOUSE_HOLD, mulberry32, faceOf, addFace, bankTurn, houseWants } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL ' + msg); fails++; } };

// ---------- 1. the die ----------
ok(TARGET === 40, 'table target is 40, got ' + TARGET);
ok(HOUSE_HOLD === 20, 'house hold line is 20, got ' + HOUSE_HOLD);
const bands = [0, 0, 0, 0, 0, 0, 0];
let rng = mulberry32(11);
for (let i = 0; i < 30000; i++) bands[faceOf(rng)]++;
for (let f = 1; f <= 6; f++) {
  ok(bands[f] > 4400 && bands[f] < 5560, `face ${f} is off uniform: ${(bands[f] / 30000 * 100).toFixed(1)}%`);
}
ok(faceOf(mulberry32(1)) === faceOf(mulberry32(1)), 'the die must be seeded (deterministic first roll)');

// ---------- 2. turn rules ----------
const a = addFace(4, 3);
ok(a.stake === 7 && a.bust === false, 'roll 3 onto a stake of 4 is 7, got ' + JSON.stringify(a));
const b = addFace(11, 1);
ok(b.stake === 0 && b.bust === true, 'a 1 busts the whole stake, got ' + JSON.stringify(b));
ok(addFace(0, 6).stake === 6, 'first roll of a turn starts the stake');
ok(bankTurn(30, 6) === 36, 'banking adds the stake to the score');
ok(bankTurn(0, 0) === 0, 'banking nothing cannot move the score');

// ---------- 3. house policy ----------
ok(houseWants(0, 0) === true, 'house rolls an empty stake');
ok(houseWants(0, HOUSE_HOLD - 1) === true, 'house keeps rolling under its hold line');
ok(houseWants(0, HOUSE_HOLD) === false, 'house banks at its hold line');
ok(houseWants(25, 10) === true, 'house may still roll when short of the target');
ok(houseWants(25, 15) === false, 'house never rolls once it can already bank the target');
ok(houseWants(39, 1) === false, 'house takes the bank that wins');

// ---------- 4. the house alone always finishes ----------
let worst = 0;
for (let seed = 1; seed <= 300; seed++) {
  const r = mulberry32(seed * 977);
  let score = 0, stake = 0, rolls = 0;
  while (score < TARGET && rolls < 400) {
    if (!houseWants(score, stake)) { score = bankTurn(score, stake); stake = 0; if (score >= TARGET) break; continue; }
    rolls++;
    const f = addFace(stake, faceOf(r));
    stake = f.stake;
    if (f.bust) { score = bankTurn(score, 0); stake = 0; continue; }
    if (score + stake >= TARGET) { score = bankTurn(score, stake); stake = 0; }
  }
  ok(score >= TARGET, `house failed to reach 40 on seed ${seed} (score ${score}, ${rolls} rolls)`);
  worst = Math.max(worst, rolls);
}
ok(worst < 400, 'house turn length must stay bounded, worst ' + worst + ' rolls');

// ---------- 5. a full table always resolves to exactly one winner ----------
let wins = 0, losses = 0, worstTable = 0;
for (let seed = 2; seed <= 400; seed++) {
  const r = mulberry32(seed * 31337);
  let you = 0, house = 0, stake = 0, hstake = 0, turns = 0, over = null, won = false;
  while (!over && turns < 600) {
    turns++;
    // player: roll until 12 or it can bank the table
    while (!over) {
      stake = addFace(stake, faceOf(r)).stake;
      if (you + stake >= TARGET) { you = bankTurn(you, stake); stake = 0; over = 'you'; won = true; break; }
      if (stake >= 12 || stake === 0) break;
    }
    if (over) break;
    you = bankTurn(you, stake); stake = 0;
    if (you >= TARGET) { over = 'you'; won = true; break; }
    // house
    hstake = 0;
    while (!over) {
      if (!houseWants(house, hstake)) {
        house = bankTurn(house, hstake); hstake = 0;
        if (house >= TARGET) { over = 'house'; won = false; }
        break;
      }
      const f = addFace(hstake, faceOf(r));
      hstake = f.stake;
      if (f.bust) break;
      if (house + hstake >= TARGET) { house = bankTurn(house, hstake); hstake = 0; over = 'house'; won = false; break; }
    }
  }
  ok(over === 'you' || over === 'house', `table on seed ${seed} never resolved (${turns} turns)`);
  ok(won ? you >= TARGET : house >= TARGET, `winner must be at the target on seed ${seed} (${you}/${house})`);
  ok(!(you >= TARGET && house >= TARGET), `both sides cannot win on seed ${seed}`);
  if (won) wins++; else losses++;
  worstTable = Math.max(worstTable, turns);
}
console.log(`tables: ${wins} player wins / ${losses} house wins, longest ${worstTable} turns`);

if (fails) { console.error(`\nFAIL: ${fails} assertion(s) failed`); process.exit(1); }
console.log('PASS die-simulator core: die uniform + seeded, bust takes the stake, bank scores, house holds at 20 and always finishes, every table resolves to one winner at 40');
