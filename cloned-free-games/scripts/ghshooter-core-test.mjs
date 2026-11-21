#!/usr/bin/env node
// Proves the GitHub Space Shooter port's shipped rules against the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/gh-space-shooter/index.html
// and driven through whole closed-loop runs at 60 Hz.
//
// Assertions: the deal is a contribution graph of a real size; an idle rocket loses (the graph is
// a threat, not scenery); a competent pilot clears every square and wins on every seed; both
// outcomes are deterministic per seed; heat is the hit points; a bomb, a landing and the grace
// window each behave; no entity leaves the field or goes NaN.
//
// usage: node ghshooter-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/gh-space-shooter/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { newState, step, hurt, cellY, lowestY, colX, rowY, FW, TOPY, COLS, ROWS, SHIP_Y, SHIP_R, BOMB_R, BOMB_SPEED, INVULN, DANGER, CELL_H, DESCEND, LIVES };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { newState, step, hurt, cellY, lowestY, colX, rowY, FW, TOPY, COLS, ROWS, SHIP_Y, SHIP_R, BOMB_R, BOMB_SPEED, INVULN, DANGER, CELL_H, DESCEND, LIVES } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;

// A "competent pilot" model: sample the wall, prefer the column of the most urgent square (the
// lowest one — it drops the bombs and is closest to landing), and pay for bombs landing on it.
function pilot(S) {
  let bestX = S.px, bestCost = Infinity;
  for (let x = -FW + SHIP_R; x <= FW - SHIP_R + 1e-9; x += 0.15) {
    let cost = Math.abs(x - S.px) * 0.30;            // moving is a cost, so it does not jitter
    let target = Infinity;
    for (const c of S.cells) {
      const dx = Math.abs(colX(c.c) - x);
      const urgency = Math.max(0, 3.4 - (cellY(S, c) - SHIP_Y)) * 0.55;
      target = Math.min(target, dx * 2.2 - urgency + c.hp * 0.12);
    }
    if (Number.isFinite(target)) cost += target;
    for (const b of S.bombs) {
      const gap = b.y - SHIP_Y;
      if (gap < -0.35) continue;                     // already past the rocket's row
      const t = Math.max(0, gap / BOMB_SPEED);
      if (t > 2.2) continue;
      if (Math.abs(b.x - x) < SHIP_R + BOMB_R + 0.20) cost += (2.2 - Math.min(t, 0.9) * 2.2) * 4.2;
    }
    if (cost < bestCost) { bestCost = cost; bestX = x; }
  }
  return bestX;
}

function run(seed, withPilot, maxT = 300) {
  const S = newState(seed);
  let t = 0, bad = 0;
  while (!S.over && t < maxT) {
    step(S, DT, withPilot ? pilot(S) : 0);
    t += DT;
    for (const c of S.cells) if (!Number.isFinite(cellY(S, c))) bad++;
    for (const b of S.pbul.concat(S.bombs)) if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) bad++;
    if (S.px < -FW - 0.01 || S.px > FW + 0.01) bad++;
  }
  return { S, t, bad };
}

// ---- shape of the deal
{
  const S = newState(7);
  ok(COLS >= 9 && ROWS >= 5, 'the contribution graph is too small to read', { COLS, ROWS });
  ok(S.cells.length >= 35 && S.cells.length <= COLS * ROWS, 'the deal is not a contribution graph', S.cells.length);
  ok(S.cells.some((c) => c.heat === 4), 'no four-commit week in the deal', S.cells.map((c) => c.heat));
  ok(S.cells.some((c) => c.heat === 1), 'no single-commit day in the deal', null);
  ok(rowY(0) === TOPY && rowY(ROWS - 1) > DANGER + 2, 'rows do not fit above the danger line', { top: rowY(0), bottom: rowY(ROWS - 1), DANGER });
  ok(Math.abs(colX(0) + colX(COLS - 1)) < 0.01 && Math.abs(colX(COLS - 1)) < FW, 'columns do not fit the field', { edge: colX(COLS - 1), FW });
  console.log(`deal: ${S.cells.length} squares on ${COLS}x${ROWS}, heat ${S.cells.reduce((a, c) => a + c.hp, 0)}, ${(1000 * (rowY(ROWS - 1) - CELL_H / 2 - DANGER) / DESCEND / 1000).toFixed(0)}s of runway`);
}

// ---- an idle rocket loses: the graph is a genuine threat
{
  const { S, t, bad } = run(7, false, 300);
  ok(S.over === true, 'an idle rocket never loses — nothing threatens the ship', { lives: S.lives, t: +t.toFixed(1) });
  ok(S.won === false, 'an idle rocket won', { won: S.won });
  ok(!!S.why, 'the loss has no stated cause', S.why);
  ok(bad === 0, 'an entity left the field or went NaN', bad);
  console.log(`idle: over=${S.over} won=${S.won} why="${S.why}" t=${t.toFixed(1)}s lives=${S.lives} cleared=${S.cleared}`);
}

// ---- a tracking pilot clears the whole graph
{
  const seeds = [7, 11, 23, 42, 99];
  const results = seeds.map((sd) => run(sd, true, 300));
  const wins = results.filter((r) => r.S.won).length;
  ok(wins === seeds.length, 'a competent pilot cannot clear the graph on every seed',
    results.map((r) => ({ won: r.S.won, why: r.S.why, lives: r.S.lives, cleared: r.S.cleared, t: +r.t.toFixed(0) })));
  ok(results.every((r) => r.bad === 0), 'tracking runs put an entity out of bounds', results.map((r) => r.bad));
  ok(results.every((r) => r.S.cleared >= 35), 'kills do not add up to the squares dealt', results.map((r) => r.S.cleared));
  ok(results.every((r) => r.t < 240), 'a full clear takes absurdly long', results.map((r) => +r.t.toFixed(0)));
  console.log('tracker: ' + results.map((r) => `seed${r.S.seed} won=${r.S.won} why="${r.S.why}" lives=${r.S.lives} cleared=${r.S.cleared}/${r.S.cleared} score=${r.S.score} ${r.t.toFixed(0)}s`).join(' | '));
}

// ---- determinism
{
  const a = run(23, true, 300).S;
  const b = run(23, true, 300).S;
  ok(a.score === b.score && a.cleared === b.cleared && a.t === b.t && a.won === b.won,
    'the same seed produced two different runs', { a: [a.score, a.cleared, a.t], b: [b.score, b.cleared, b.t] });
}

// ---- heat is the hit points: a four-commit week needs four pulses
{
  const S = newState(5);
  S.cells = [{ id: 1, r: 5, c: 5, heat: 4, hp: 4 }, { id: 2, r: 0, c: 0, heat: 1, hp: 1 }];
  S.bombs = []; S.bombT = 99; S.px = colX(5); S.aimX = colX(5);
  let hits = 0, t = 0;
  while (S.cells.length && t < 6) {
    const before = S.hits;
    step(S, DT, colX(5));
    if (S.hits > before) hits = S.hits;
    t += DT;
    S.bombT = 99;
  }
  ok(hits === 4, 'a heat-4 square did not take four hits', { hits, t: +t.toFixed(2) });
  ok(S.cleared === 1 && S.score === 40, 'clearing a heat-4 square did not score 40', { cleared: S.cleared, score: S.score });
}

// ---- one hit costs exactly one life, and the grace window blocks the second
{
  const S = newState(5);
  S.invuln = 0;
  const l0 = S.lives;
  hurt(S, 'test');
  ok(S.lives === l0 - 1, 'a hit did not cost a life', S.lives);
  ok(S.invuln > 0, 'a hit granted no invulnerability window', S.invuln);
  hurt(S, 'test');
  ok(S.lives === l0 - 1, 'two hits inside the grace window cost two lives', S.lives);
  ok(INVULN >= 0.8, 'the grace window is too short to be fair', INVULN);
  ok(LIVES === 3, 'the run does not start with three lives', LIVES);
}

// ---- a bomb on the rocket costs a life and is consumed
{
  const S = newState(5);
  S.invuln = 0; S.bombT = 99; S.px = 0; S.aimX = 0;
  S.bombs = [{ id: 1, x: 0, y: SHIP_Y }];
  step(S, DT, 0);
  ok(S.lives === 2, 'a bomb on the rocket cost no life', S.lives);
  ok(S.bombs.length === 0, 'the bomb stayed after hitting the rocket', S.bombs.length);
}

// ---- the graph landing on the danger line loses the run outright
{
  const S = newState(5);
  S.bombT = 99; S.invuln = 0;
  S.cells = [{ id: 1, r: ROWS - 1, c: 0, heat: 1, hp: 1 }];
  // the square starts just above the line, off the rocket's own column so nothing shoots it
  S.drop = rowY(ROWS - 1) - (DANGER + CELL_H / 2 + 0.06);
  let t = 0;
  while (!S.over && t < 3) { step(S, DT, 0); t += DT; }
  ok(S.over && !S.won, 'the graph sliding onto the rocket did not lose the run', { over: S.over, won: S.won, t });
  ok(/graph/.test(S.why), 'the landing loss does not name its cause', S.why);
}

// ---- clearing the last square wins, with the clear bonus
{
  const S = newState(5);
  S.bombT = 99; S.invuln = 0;
  S.cells = [{ id: 1, r: 5, c: 5, heat: 1, hp: 1 }];
  S.drop = rowY(5) - 3.9 + 1.2;
  S.px = colX(5); S.aimX = colX(5);
  let t = 0;
  while (!S.over && t < 4) { step(S, DT, colX(5)); t += DT; }
  ok(S.over && S.won, 'clearing the last square did not win', { over: S.over, won: S.won, why: S.why, cells: S.cells.length });
  ok(S.score === 10 + 150, 'the win did not pay the clear bonus', S.score);
}

// ---- the formation only bombs from altitude (close in it is a ram threat, not an executioner)
{
  const S = newState(5);
  S.cells = [{ id: 1, r: 5, c: 5, heat: 1, hp: 1 }];
  S.drop = rowY(5) - 2.6;             // lowest square at y 2.6, still above FIRE_MIN_Y
  S.bombT = 0.01; S.bombs = [];
  step(S, DT, 0);
  ok(S.bombs.length === 1, 'a high square never dropped a bomb', S.bombs.length);
  const low = newState(5);
  low.cells = [{ id: 1, r: 5, c: 5, heat: 1, hp: 1 }];
  low.drop = rowY(5) - 1.9;           // y 1.9, below the firing floor
  low.bombT = 0.01; low.bombs = [];
  step(low, DT, 0);
  ok(low.bombs.length === 0, 'a square on top of the ship still bombs it', low.bombs.length);
}

if (fails) { console.error(`\nFAILED: ${fails} assertion(s)`); process.exit(1); }
console.log('\nPASS: gh-space-shooter core rules');
