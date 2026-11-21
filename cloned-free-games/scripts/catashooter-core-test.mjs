#!/usr/bin/env node
// Proves the Cat a Shooter port's shipped rules against the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/cat-a-shooter/index.html
// and driven through whole closed-loop runs at 60 Hz.
//
// Assertions: the run has six waves and a real ceiling; an idle pilot dies (the saucers are a
// threat); a tracking pilot clears all six waves and wins; both outcomes are deterministic for a
// seed; every entity stays inside the field (no NaN, no runaway bullets); a leak and a ram both
// cost a life; the invulnerability window stops one pass from draining three lives.
//
// usage: node catashooter-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/cat-a-shooter/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { newState, step, hurt, WAVES, FW, TOPY, SHIP_Y, SHIP_R, EN_R, EB_R, PB_R, EB_SPEED, INVULN, planWave };';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { newState, step, hurt, WAVES, FW, TOPY, SHIP_Y, SHIP_R, EN_R, EB_R, EB_SPEED, INVULN } = M;

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};
const DT = 1 / 60;

// A "competent pilot" model: sample the field, prefer being under the most dangerous saucer, and
// pay for saucers diving onto that column and for enemy shots whose flight lands on it.
function pilot(S) {
  let bestX = S.px, bestScore = Infinity;
  for (let x = -FW + SHIP_R; x <= FW - SHIP_R + 1e-9; x += 0.15) {
    let s = Math.abs(x - S.px) * 0.30;              // moving is a cost, so it does not jitter
    let track = Infinity;
    for (const e of S.enemies) {
      const dx = Math.abs(e.x - x);
      const ttl = (e.y - SHIP_Y) / Math.max(0.2, e.vy);
      track = Math.min(track, dx * 2 + Math.max(0, ttl) * 0.35);
      if (ttl < 2.2 && dx < SHIP_R + EN_R + 0.12) s += (2.2 - ttl) * 2.6;   // it is coming down here
    }
    s += track * 0.55;
    for (const b of S.ebul) {
      const gap = b.y - SHIP_Y;
      if (gap < -0.35) continue;                       // already past the cat's row
      const t = Math.max(0, gap / EB_SPEED);
      if (t > 2.2) continue;
      if (Math.abs(b.x - x) < SHIP_R + EB_R + 0.20) s += (2.2 - Math.min(t, 0.9) * 2.2) * 4.2;
    }
    if (s < bestScore) { bestScore = s; bestX = x; }
  }
  return bestX;
}

function run(seed, withPilot, maxT = 400) {
  const S = newState(seed);
  let t = 0, bad = 0;
  while (!S.over && t < maxT) {
    step(S, DT, withPilot ? pilot(S) : 0);
    t += DT;
    for (const e of S.enemies) if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) bad++;
    for (const b of S.pbul.concat(S.ebul)) if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) bad++;
    if (S.px < -FW - 0.01 || S.px > FW + 0.01) bad++;
  }
  return { S, t, bad };
}

// ---- shape of the run
{
  ok(WAVES.length === 6, 'the run is not six waves', WAVES.length);
  ok(TOPY > 6 && FW > 2, 'field is too small to fly in', { TOPY, FW });
  const total = WAVES.reduce((a, w) => a + w.n, 0);
  ok(total >= 40, 'too few saucers for a run', total);
  console.log(`field: ${(FW * 2).toFixed(1)} x ${TOPY} units, ${total} saucers over ${WAVES.length} waves`);
}

// ---- an idle cat is killed (the saucers are a genuine threat)
{
  const { S, t, bad } = run(7, false, 400);
  ok(S.over === true, 'an idle pilot never loses — nothing threatens the cat', { lives: S.lives, t: +t.toFixed(1) });
  ok(S.won === false, 'an idle pilot won', { won: S.won });
  ok(S.lives === 0, 'lives did not reach zero on a loss', S.lives);
  ok(!!S.why, 'the loss has no stated cause', S.why);
  ok(bad === 0, 'an entity left the field or went NaN', bad);
  console.log(`idle: over=${S.over} won=${S.won} why="${S.why}" t=${t.toFixed(1)}s score=${S.score} kills=${S.kills}`);
}

// ---- a tracking pilot clears all six waves
{
  const seeds = [7, 11, 23, 42, 99];
  const results = seeds.map((sd) => run(sd, true, 400));
  const wins = results.filter((r) => r.S.won).length;
  ok(wins === seeds.length, 'a competent pilot cannot clear the run on every seed', results.map((r) => ({ won: r.S.won, wave: r.S.wave + 1, lives: r.S.lives, t: +r.t.toFixed(0) })));
  ok(results.every((r) => r.bad === 0), 'tracking runs put an entity out of bounds', results.map((r) => r.bad));
  ok(results.every((r) => r.S.score > 200), 'finishing the run scores almost nothing', results.map((r) => r.S.score));
  ok(results.every((r) => r.S.kills >= 40), 'kills do not add up to the saucers spawned', results.map((r) => r.S.kills));
  ok(results.every((r) => r.t < 300), 'a full run takes absurdly long', results.map((r) => +r.t.toFixed(0)));
  console.log('tracker: ' + results.map((r) => `seed${r.S.seed} won=${r.S.won} why="${r.S.why}" w=${r.S.wave + 1} lives=${r.S.lives} score=${r.S.score} kills=${r.S.kills} ${r.t.toFixed(0)}s`).join(' | '));
}

// ---- determinism: same seed, same run
{
  const a = run(23, true, 400).S;
  const b = run(23, true, 400).S;
  ok(a.score === b.score && a.kills === b.kills && a.t === b.t && a.won === b.won,
    'the same seed produced two different runs', { a: [a.score, a.kills, a.t], b: [b.score, b.kills, b.t] });
}

// ---- one hit costs exactly one life, and the grace window blocks the second
{
  const S = newState(5);
  S.spawnQ = []; S.enemies = [];
  S.invuln = 0;
  const l0 = S.lives;
  hurt(S, 'test');
  ok(S.lives === l0 - 1, 'a hit did not cost a life', S.lives);
  ok(S.invuln > 0, 'a hit granted no invulnerability window', S.invuln);
  hurt(S, 'test');
  ok(S.lives === l0 - 1, 'two hits inside the grace window cost two lives', S.lives);
  ok(INVULN >= 0.8, 'the grace window is too short to be fair', INVULN);
}

// ---- a saucer that slips past the cat costs a life; so does one flown into her
{
  const leak = newState(5);
  leak.spawnQ = []; leak.invuln = 0;
  leak.enemies = [{ id: 1, x: 2.4, y: -0.5, tier: 0, vy: 0.5, hp: 1, fireT: 9, jit: 1 }];
  step(leak, DT, 0);
  ok(leak.lives === 2 && leak.enemies.length === 0, 'a saucer past the cat neither cost a life nor left the board', { lives: leak.lives, n: leak.enemies.length });

  const ram = newState(5);
  ram.spawnQ = []; ram.invuln = 0;
  ram.enemies = [{ id: 1, x: ram.px, y: SHIP_Y, tier: 0, vy: 0.5, hp: 1, fireT: 9, jit: 1 }];
  step(ram, DT, 0);
  ok(ram.lives === 2, 'a saucer flown into the cat cost no life', ram.lives);
  ok(ram.enemies.length === 0, 'a ramming saucer stayed on the board', ram.enemies.length);
}

// ---- shooting scores, and a two-hit saucer needs both hits
{
  const S = newState(3);
  S.spawnQ = []; S.enemies = []; S.ebul = []; S.pbul = [];
  S.enemies = [{ id: 9, x: S.px, y: 4.0, tier: 2, vy: 0, hp: 2, fireT: 99, jit: 1 }];
  const before = S.score;
  let hits = 0;
  for (let i = 0; i < 240 && S.enemies.length; i++) { step(S, DT, S.px); hits = S.shots; }
  ok(S.enemies.length === 0, 'a straight-up shot never killed a saucer on the firing line', { n: S.enemies.length });
  ok(S.score === before + 30, 'a big saucer did not score 30', S.score - before);
  ok(S.kills === 1, 'the kill was not counted', S.kills);
  ok(hits > 1, 'the shot counter did not track autofire', hits);
}

// ---- the field stays inside the walls even when the pointer asks for the wall
{
  const S = newState(7);
  for (let i = 0; i < 120; i++) step(S, DT, 99);
  ok(S.px <= FW - SHIP_R + 1e-6, 'the cat left the right wall', S.px);
  for (let i = 0; i < 240; i++) step(S, DT, -99);
  ok(S.px >= -FW + SHIP_R - 1e-6, 'the cat left the left wall', S.px);
  ok(EN_R > 0.1 && SHIP_R > 0.1, 'collision radii are collapsed', { EN_R, SHIP_R });
}

if (fails) { console.error(`\nFAIL: ${fails} assertion(s)`); process.exit(1); }
console.log('\nPASS: cat-a-shooter core rules');
