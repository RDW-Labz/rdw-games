#!/usr/bin/env node
// Rules test for the Colorful port. Slices the // >>>CORE block out of the SHIPPED page and
// exercises the exact rules the browser runs: world generation, walls and doorways, the
// pickup/carry/deliver loop, the death rule, and a routed pilot that must actually finish
// the game. usage: node scripts/colorful-core-test.mjs [path/to/index.html]
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || '/home/cluer/kaos/work/site/games/arcade/colorful/index.html';
const html = readFileSync(FILE, 'utf8');
const m = html.match(/\/\/ >>>CORE\n([\s\S]*?)\/\/ <<<CORE/);
if (!m) { console.error('FAIL: no // >>>CORE block'); process.exit(2); }
const src = m[1];
let A;
try {
  A = new Function(src + `
return { mkState, step, roomOf, roomCentre, routeRooms, doorBetween, cheb, hitsWall, mkWalls,
  ROOMS, RSIZE, HALF, HUB, COLOURS, MAX_HP, MAX_LIVES, SPEED, PR, DOOR };`)();
} catch (e) {
  console.error('FAIL: CORE block did not evaluate:', e.message);
  process.exit(2);
}
const { mkState, step, roomOf, roomCentre, routeRooms, cheb, ROOMS, RSIZE, HALF, HUB, COLOURS } = A;
const STEP = 1 / 120;
let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) return true;
  fails++;
  console.log('  FAIL ' + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return false;
};
const run = (S, secs, input, each) => {
  const n = Math.round(secs / STEP);
  for (let i = 0; i < n && !S.over; i++) {
    const inp = typeof input === 'function' ? input(S, i * STEP) : input;
    step(S, STEP, inp);
    if (each) each(S, i * STEP);
  }
  return S;
};
const json = (o) => JSON.stringify(o);

// ---- 1. generation is deterministic and legal -------------------------------------------
console.log('1. world generation');
const a = mkState(7), b = mkState(7), c = mkState(8);
ok(json(a.artifacts.map((x) => [x.room, +x.homeX.toFixed(3), +x.homeY.toFixed(3)])) ===
   json(b.artifacts.map((x) => [x.room, +x.homeX.toFixed(3), +x.homeY.toFixed(3)])), 'same seed deals the same artifacts');
ok(json(a.enemies.map((e) => [+e.x.toFixed(2), +e.y.toFixed(2)])) === json(b.enemies.map((e) => [+e.x.toFixed(2), +e.y.toFixed(2)])), 'same seed places the same drones');
ok(json(a.artifacts.map((x) => x.room)) !== json(c.artifacts.map((x) => x.room)) || json(a.enemies) !== json(c.enemies), 'a different seed deals a different world');
ok(a.artifacts.length === 8 && a.artifacts.length === COLOURS.length, 'eight colour artifacts', a.artifacts.length);
const rooms = new Set(a.artifacts.map((x) => x.room.join(',')));
ok(rooms.size === 8, 'eight distinct artifact rooms', [...rooms]);
ok(a.artifacts.every((x) => cheb(x.room, HUB) >= 2), 'no artifact inside the hub 3x3 block');
ok(a.artifacts.every((x) => {
  const [cx, cy] = roomCentre(x.room[0], x.room[1]);
  return Math.abs(x.homeX - cx) <= 5.01 && Math.abs(x.homeY - cy) <= 5.01;
}), 'artifacts sit inside their own room');
ok(a.enemies.every((e) => !(e.room[0] === HUB[0] && e.room[1] === HUB[1])), 'the altar room is safe');
ok(a.enemies.every((e) => {
  const [cx, cy] = roomCentre(e.room[0], e.room[1]);
  return Math.abs(e.x - cx) <= 6.3 && Math.abs(e.y - cy) <= 6.3;
}), 'drones patrol their own room');
ok(a.enemies.length > 60, 'the world is populated', a.enemies.length);
ok(a.player.x === 0 && a.player.y === 0 && a.player.hp === A.MAX_HP && a.player.lives === A.MAX_LIVES, 'the run starts at the altar, whole');

// ---- 2. walls, doorways, free flight -----------------------------------------------------
console.log('2. geometry');
const s2 = mkState(7);
run(s2, 3, { x: 1, y: 0 });
ok(s2.player.x > 9.2, 'the ship flies right out of the hub room', +s2.player.x.toFixed(2));
ok(json(roomOf(s2.player.x, s2.player.y)) === json([4, 3]), 'through the doorway into room (4,3)', s2.room || roomOf(s2.player.x, s2.player.y));
const s2b = mkState(7);
s2b.player.x = 5; s2b.player.y = 0;
run(s2b, 4, { x: 0, y: 1 });
ok(s2b.player.y > 8.6, 'the ship flies up to the wall', +s2b.player.y.toFixed(2));
ok(s2b.player.y < 10.1, 'and stops at the wall away from a doorway', +s2b.player.y.toFixed(2));
const s2c = mkState(7);
// drive into the wall BETWEEN two doorways: from the room corner there is no gap
s2c.player.x = 3.5; s2c.player.y = 6.5;
run(s2c, 3, { x: 1, y: 0 });
ok(s2c.player.x < 9.7, 'walls are solid away from a doorway', +s2c.player.x.toFixed(2));
// the room graph is fully connected from the hub
const seen = new Set(['3,3']); const q = [[3, 3]];
while (q.length) {
  const r = q.shift();
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = [r[0] + d[0], r[1] + d[1]];
    if (n[0] < 0 || n[0] >= ROOMS || n[1] < 0 || n[1] >= ROOMS || seen.has(n.join(','))) continue;
    seen.add(n.join(',')); q.push(n);
  }
}
ok(seen.size === ROOMS * ROOMS, 'every room is reachable from the altar', seen.size);

// ---- 3. an idle visitor never wins and never scores ------------------------------------
console.log('3. idle');
const s3 = mkState(7);
run(s3, 240, { x: 0, y: 0 });
ok(s3.delivered === 0, 'idle delivers nothing', s3.delivered);
ok(s3.kills === 0, 'idle kills nothing', s3.kills);
ok(!s3.over, 'idle does not end the run', { over: s3.over, result: s3.result });
ok(Math.hypot(s3.player.x, s3.player.y) < 0.6, 'idle stays at the altar', [s3.player.x, s3.player.y]);

// ---- 4. pickup, carry, deliver, win ----------------------------------------------------
console.log('4. pickup / deliver / win');
const s4 = mkState(7);
const art = s4.artifacts[0];
const px = art.homeX + 3.2, py = art.homeY;
s4.player.x = px; s4.player.y = py; s4.player.invuln = 1e6;
run(s4, 2, () => {
  const dx = art.homeX - s4.player.x, dy = art.homeY - s4.player.y, d = Math.hypot(dx, dy);
  return d < 0.4 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
});
ok(s4.player.carrying === 0, 'flying onto an artifact picks it up', s4.player.carrying);
ok(s4.artifacts[0].state === 'carried', 'the artifact is marked carried');
ok(s4.delivered === 0, 'picking up is not delivering');
// carry it home through the doorway route
run(s4, 90, (S) => {
  const here = roomOf(S.player.x, S.player.y);
  const rs = routeRooms(here, HUB);
  const wp = rs.length ? A.doorBetween(here, rs[0]) : [0, 0];
  const dx = wp[0] - S.player.x, dy = wp[1] - S.player.y, d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
});
ok(s4.delivered === 1, 'the carried colour is delivered at the altar', s4.delivered);
ok(s4.player.carrying === null, 'carrying clears on delivery');
ok(s4.artifacts[0].state === 'delivered', 'the artifact is marked delivered');
ok(s4.score > 0, 'delivery scores', s4.score);

const s5 = mkState(7);
s5.delivered = 7;
s5.artifacts.forEach((x, i) => { x.state = i < 7 ? 'delivered' : 'carried'; });
s5.player.carrying = 7;
s5.player.x = 3.0; s5.player.y = 0; s5.player.invuln = 1e6;
run(s5, 3, { x: -1, y: 0 });
ok(s5.delivered === 8, 'the eighth colour lands', s5.delivered);
ok(s5.over === true && s5.result === 'win', 'eight colours home is a win', { over: s5.over, result: s5.result });

// ---- 5. dying drops the carried colour back home, and lives run out --------------------
console.log('5. death');
const s6 = mkState(7);
s6.player.x = 30; s6.player.y = 0; s6.player.invuln = 0;   // away from the altar, so carrying is not a delivery
s6.player.hp = 1; s6.player.lives = 1;
s6.player.carrying = 2;
s6.artifacts[2].state = 'carried';
s6.artifacts[2].x = 32; s6.artifacts[2].y = 0;
s6.bullets.push({ x: 32.0, y: 0, vx: -6, vy: 0, foe: true, life: 4 });
const s6b = run(s6, 4, { x: 0, y: 0 });
ok(s6b.over === true && s6b.result === 'lose', 'the last hit ends the run as a loss', { over: s6b.over, result: s6b.result, hp: s6b.player.hp });
ok(s6b.artifacts[2].state === 'home', 'the carried colour returns home on death', s6b.artifacts[2].state);
ok(s6b.player.carrying === null, 'the ship drops what it carried');

const s7 = mkState(7);
s7.player.x = 30; s7.player.y = 0; s7.player.invuln = 0; s7.player.hp = 1; s7.player.lives = 2;
s7.player.carrying = 3; s7.artifacts[3].state = 'carried';
s7.bullets.push({ x: 32.0, y: 0, vx: -6, vy: 0, foe: true, life: 4 });
run(s7, 3, { x: 0, y: 0 });
ok(s7.player.lives === 1 && s7.player.hp === A.MAX_HP && !s7.over, 'a death with lives left respawns whole at the altar', { lives: s7.player.lives, hp: s7.player.hp, x: s7.player.x, y: s7.player.y });
ok(s7.artifacts[3].state === 'home', 'and the colour it dropped is back home');

// ---- 6. a routed, bullet-dodging pilot must actually finish ----------------------------
console.log('6. pilot');
function steer(S, tx, ty) {
  const here = roomOf(S.player.x, S.player.y);
  const to = roomOf(tx, ty);
  let wp = [tx, ty];
  if (here[0] !== to[0] || here[1] !== to[1]) wp = A.doorBetween(here, routeRooms(here, to)[0]);
  const dx = wp[0] - S.player.x, dy = wp[1] - S.player.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}
function pilotPlan() {
  let goal = null, goalT = 0;
  return (S, t) => {
    const want = S.player.carrying != null ? 'hub' : S.artifacts.find((x) => x.state === 'home');
    const key = want === 'hub' ? 'hub' : want && want.id;
    if (key !== goal || t - goalT > 12) { goal = key; goalT = t; }
    let tx, ty;
    if (goal === 'hub') { tx = 0; ty = 0; }
    else { const a = S.artifacts[goal]; tx = a.homeX; ty = a.homeY; }
    const v = steer(S, tx, ty);
    // dodge: enemy fire only travels horizontally, so the escape is vertical
    let dy = 0;
    for (const b of S.bullets) {
      if (!b.foe) continue;
      if (Math.abs(b.y - S.player.y) < 1.6 && Math.abs(b.x - S.player.x) < 6.5) {
        const away = S.player.y >= b.y ? 1 : -1;
        dy += away * 1.6;
      }
    }
    return { x: v.x, y: v.y + dy };
  };
}
let wins = 0, tallies = [];
for (const seed of [7, 11, 23]) {
  const p = mkState(seed);
  run(p, 900, pilotPlan());
  tallies.push({ seed, delivered: p.delivered, kills: p.kills, lives: p.lives, t: +p.t.toFixed(0), over: p.over, result: p.result });
  if (p.result === 'win') wins++;
}
console.log('   pilot ladder ' + JSON.stringify(tallies));
ok(wins >= 2, 'a routed pilot with dodging can finish the game (>=2 of 3 seeds)', wins);
ok(tallies.every((x) => x.delivered >= 4), 'the pilot always collects a majority of the colours', tallies.map((x) => x.delivered));

console.log(fails === 0 ? `PASS ${checks} checks` : `FAIL ${fails}/${checks} checks`);
process.exit(fails === 0 ? 0 : 1);
