#!/usr/bin/env node
// Proves the Snakes port's shipped rules with the exact code the browser runs:
// the // >>>CORE ... // <<<CORE block is sliced out of games/arcade/snakes/index.html.
// Checks: a plain tick moves and keeps length, eating grows by one, walls kill, wrap
// crosses the edge, a tail cell being vacated is not a collision but a mid-body cell is,
// a 180 turn is refused, steerDir never reverses, and food never lands on the snake.
//
// usage: node snakes-core-test.mjs [path-to-index.html]
import fs from 'node:fs';

const file = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/snakes/index.html';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block in ' + file); process.exit(1); }
const src = m[1] + '\nexport { DIRS, OPP, turnAllowed, nextCell, stepSnake, freeCells, pickFood, mulberry32, steerDir };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { turnAllowed, nextCell, stepSnake, freeCells, pickFood, mulberry32, steerDir, DIRS } = mod;

let fails = 0;
const ok = (cond, msg, extra) => { if (!cond) { console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); fails++; } };

const W = 19, H = 13;
const start = [{ r: 6, c: 4 }, { r: 6, c: 3 }, { r: 6, c: 2 }, { r: 6, c: 1 }];

// 1) a plain tick: head advances, tail drops, length preserved
{
  const r = stepSnake(start, 'right', false, W, H, false);
  ok(!r.dead, 'plain tick should not die', r);
  ok(r.body.length === 4, 'plain tick keeps the length', r.body && r.body.length);
  ok(r.body[0].r === 6 && r.body[0].c === 5, 'plain tick moves the head one cell right', r.body && r.body[0]);
  ok(!r.body.some((p, i) => i > 0 && p.r === 6 && p.c === 1), 'the tail cell is vacated');
}

// 2) eating grows by exactly one
{
  const r = stepSnake(start, 'right', true, W, H, false);
  ok(!r.dead && r.body.length === 5, 'growing tick adds one segment', r.body && r.body.length);
  ok(r.ate === true, 'growing tick reports ate');
}

// 3) walls kill in classic mode, wrap crosses in wrap mode
{
  ok(stepSnake([{ r: 0, c: 5 }], 'up', false, W, H, false).dead === 'wall', 'top wall kills');
  ok(stepSnake([{ r: H - 1, c: 5 }], 'down', false, W, H, false).dead === 'wall', 'bottom wall kills');
  ok(stepSnake([{ r: 5, c: 0 }], 'left', false, W, H, false).dead === 'wall', 'left wall kills');
  const wr = stepSnake([{ r: 0, c: 5 }], 'up', false, W, H, true);
  ok(!wr.dead && wr.body[0].r === H - 1, 'wrap mode crosses the top edge to the bottom', wr.body && wr.body[0]);
  const wl = stepSnake([{ r: 5, c: 0 }], 'left', false, W, H, true);
  ok(!wl.dead && wl.body[0].c === W - 1, 'wrap mode crosses the left edge to the right', wl.body && wl.body[0]);
}

// 4) self collision: mid-body is fatal, the vacated tail is not
{
  const ring = [{ r: 5, c: 5 }, { r: 5, c: 6 }, { r: 6, c: 6 }, { r: 6, c: 5 }];
  const mid = stepSnake(ring, 'up', false, W, H, false);   // head 5,5 -> toward body? head goes to 4,5: safe
  ok(!mid.dead, 'moving away from the body is safe', mid);
  const into = stepSnake([{ r: 5, c: 5 }, { r: 6, c: 5 }, { r: 6, c: 6 }, { r: 5, c: 6 }], 'down', false, W, H, false);
  ok(into.dead === 'self', 'a mid-body cell is fatal', into);
  const tail = stepSnake([{ r: 5, c: 4 }, { r: 5, c: 5 }, { r: 6, c: 5 }, { r: 6, c: 4 }], 'down', false, W, H, false);
  ok(!tail.dead, 'stepping onto the vacating tail cell is legal', tail);
}

// 5) turning: reverse refused, perpendicular allowed
{
  ok(!turnAllowed('right', 'left'), 'a 180 turn is refused');
  ok(!turnAllowed('up', 'down'), 'a 180 turn is refused vertically');
  ok(turnAllowed('right', 'up') && turnAllowed('right', 'down'), 'perpendicular turns are allowed');
  ok(turnAllowed('right', 'right'), 'holding the same direction is allowed');
}

// 6) steerDir never returns the reverse of the current heading, for any cell
{
  for (const cur of Object.keys(DIRS)) {
    for (let r = 0; r < H; r += 3) for (let c = 0; c < W; c += 3) {
      if (r === 6 && c === 6) continue;
      const d = steerDir({ r: 6, c: 6 }, { r, c }, cur);
      ok(turnAllowed(cur, d), `steerDir reversed ${cur} toward ${r},${c} -> ${d}`);
    }
  }
}

// 7) food never lands on the snake, and the seeded deal is reproducible
{
  const body = start;
  const free = freeCells(body, W, H);
  ok(free.length === W * H - body.length, 'freeCells excludes every body cell', free.length);
  const rnd = mulberry32(20261119);
  const a = pickFood(body, W, H, rnd);
  ok(a && !body.some((p) => p.r === a.r && p.c === a.c), 'food is never placed on the snake', a);
  const rnd2 = mulberry32(20261119);
  const b = pickFood(body, W, H, rnd2);
  ok(a.r === b.r && a.c === b.c, 'the seeded first food is deterministic', [a, b]);
  const full = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) full.push({ r, c });
  ok(pickFood(full, W, H, mulberry32(1)) === null, 'a full board yields no food');
}

// 8) a whole short run of real ticks never leaves the board or the body in a bad state
{
  let body = start.map((p) => ({ ...p })), dir = 'right';
  const script = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
  let dead = null;
  for (const d of script) {
    dir = d;
    const r = stepSnake(body, dir, false, W, H, false);
    if (r.dead) { dead = r.dead; break; }
    body = r.body;
    const uniq = new Set(body.map((p) => p.r + ',' + p.c));
    ok(uniq.size === body.length, 'a tick produced a doubled cell', body);
    ok(body.every((p) => p.r >= 0 && p.c >= 0 && p.r < H && p.c < W), 'a tick left the board', body);
  }
  ok(!dead, 'the scripted run should survive inside the board', dead);
}

console.log(fails ? `FAILED ${fails}` : 'OK — rules proven: move, grow, wall, wrap, self, turn queue, food');
process.exit(fails ? 1 : 0);
