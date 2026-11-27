#!/usr/bin/env node
// Interaction gate for the Open Golf port: serves the site repo root (so ./kit.js resolves to the
// shipped bytes), drives headless Chromium with real CDP pointer/touch input, and asserts the
// state hook moves on every gesture. A canvas that merely exists is not proof.
//
// usage: node opengolf-gate.mjs [/<path-to-site-repo>]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = '/games/arcade/open-golf/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CMD_TIMEOUT = 240000;
// Mid-band tee powers for holes 1 and 6, measured by scripts/opengolf-core-test.mjs on the
// exact shipped physics (widest sinkable band: hole 1 0.44..0.64, hole 6 0.92..1.00).
const POWER_H1 = 0.54, POWER_H6 = 0.96;

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws attach failed')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok, bad } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? bad(new Error(msg.error.message)) : ok(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/opengolf-gate-');
const RUNTIME = mkdtempSync('/tmp/opengolf-run-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('REJECT ' + (e && e.message)); kill(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools in 60s: ' + err.slice(-300))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});

const browserPort = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) throw new Error('no page target: ' + JSON.stringify(list).slice(0, 200));
const cdp = await CDP.attach(target.webSocketDebuggerUrl);
const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const hook = () => ev('window.__opengolf ? window.__opengolf() : null');
const poll = async (expr, ms = 8000, step = 120) => {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

let fails = 0;
const results = [];
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  results.push({ pass: !!cond, msg, extra });
  return !!cond;
};

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await cdp.send('Page.navigate', { url: base + PAGE });
const booted = await poll('typeof window.__opengolf === "function"', 90000);
console.log(`boot: ${booted ? 'hook live' : 'NO HOOK'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(!!booted, 'the state hook never appeared (module died?)', await ev('document.title'));

// ---- real pointer input: a slingshot drag from the ball to the pull-back point ----
const drag = async (a, b, steps = 8) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, button: 'left', pointerType: 'mouse' });
    await sleep(16);
  }
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const touchDrag = async (a, b, steps = 6) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
  await sleep(70);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, id: 1 }] });
    await sleep(20);
  }
  await sleep(70);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const click = async (pt) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const elPoint = async (id) => ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:r.width,h:r.height,x0:r.x,y0:r.y};})()`);
const clickEl = async (id) => { const p = await elPoint(id); await click(p); await sleep(320); return p; };
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// Aim at the cup and swing: screen points come from the page's own projection, so the drag is
// a real gesture at the right power, not a fabricated state change.
const aimAtCup = async (power) => {
  const s = await hook();
  const dx = s.cup.x - s.ball.x, dz = s.cup.z - s.ball.z;
  return ev(`window.__opengolf.dragPoints(${dx},${dz},${power})`);
};
const swing = async (power, { touch = false } = {}) => {
  const pts = await aimAtCup(power);
  if (!pts || pts.__err) return false;
  if (touch) await touchDrag(pts.from, pts.to); else await drag(pts.from, pts.to);
  return true;
};
const restState = (ms = 9000) => poll('(!window.__opengolf().moving) ? window.__opengolf() : null', ms);

// Sink the current hole with real drags; a second swing from close range is what a player does.
const sinkHole = async (firstPower, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    const s = await hook();
    if (!s || s.over) return s;
    if (s.sunk) return s;
    let power = firstPower;
    if (i > 0) {
      const d = Math.hypot(s.cup.x - s.ball.x, s.cup.z - s.ball.z);
      power = Math.max(0.1, Math.min(0.9, d * 0.11));
    }
    if (!(await swing(power))) return null;
    const after = await restState();
    if (!after) return null;
    if (after.sunk) return after;
    if (after.hole !== s.hole) return after;
  }
  return await hook();
};

// ---- 1) boot: a built course, the ball on the tee, nothing spent ----
{
  const s = await hook();
  console.log('boot state:', JSON.stringify({ hole: s?.hole, name: s?.name, par: s?.par, meshes: s?.meshes, strokes: s?.strokes, total: s?.total, left: s?.left, budget: s?.budget, sheet: s?.sheet }));
  ok(s && s.holes === 6, 'the round is not six holes', s?.holes);
  ok(s && s.hole === 1 && s.par === 2, 'the round does not open on hole 1 (par 2)', [s?.hole, s?.par]);
  ok(s && s.meshes >= 99, 'the opening course did not build its cells', s?.meshes);
  ok(s && s.strokes === 0 && s.total === 0, 'the round starts with strokes already spent', [s?.strokes, s?.total]);
  ok(s && s.budget === 27 && s.left === 27, 'the stroke allowance is not 27', [s?.budget, s?.left]);
  ok(s && s.over === false && s.sheet === '', 'the round is already over at boot', s?.sheet);
  ok(s && Math.abs(s.ball.x - s.tee.x) < 1e-6 && Math.abs(s.ball.z - s.tee.z) < 1e-6, 'the ball does not start on the tee', s?.ball);
  ok(s && Math.abs(s.cup.x - s.ball.x) < 1e-6, 'the opening cup is not straight up the fairway', [s?.cup, s?.ball]);
}

// ---- 2) the ground picker round-trips: screen point back to the world it came from ----
{
  let bad = [];
  for (const [label, fn] of [['ball', 'ballPoint'], ['cup', 'cupPoint']]) {
    const got = await ev(`(()=>{const p=window.__opengolf.${fn}();return {p, w: window.__opengolf.pick(p.x,p.y)};})()`);
    const want = label === 'ball' ? (await hook()).ball : (await hook()).cup;
    if (!got || !got.w) { bad.push([label, 'no hit', got]); continue; }
    const d = Math.hypot(got.w.x - want.x, got.w.z - want.z);
    if (d > 0.08) bad.push([label, +d.toFixed(3)]);
  }
  ok(bad.length === 0, 'the ground picker does not round-trip on the ball and cup', bad);
}

// ---- 3) a real drag putt books a stroke, moves the ball, and holes out ----
{
  const before = await hook();
  const pts = await aimAtCup(POWER_H1);
  ok(pts && pts.from && pts.to && Math.hypot(pts.to.x - pts.from.x, pts.to.y - pts.from.y) > 100, 'the drag points are degenerate', pts);
  await drag(pts.from, pts.to);
  const mid = await hook();
  ok(mid && mid.strokes === 1 && mid.putts === 1, 'the drag did not book exactly one stroke', [mid?.strokes, mid?.putts]);
  ok(mid && mid.total === 1 && mid.left === 26, 'the stroke was not taken off the allowance', [mid?.total, mid?.left]);
  ok(mid && mid.moving === true, 'the ball is not rolling after the release', mid?.moving);
  ok(mid && Math.hypot(mid.ball.x - before.ball.x, mid.ball.z - before.ball.z) > 0.05, 'the ball did not leave the tee', [before?.ball, mid?.ball]);
  await sleep(350);
  await shot('opengolf-gate-flight');
  const rest = await poll('window.__opengolf().sunk ? window.__opengolf() : null', 12000);
  ok(!!rest, 'the opening putt never dropped (power ' + POWER_H1 + ')', (await hook())?.ball);
  ok(rest && rest.sim > 100, 'the physics barely stepped for a 6-unit putt', rest?.sim);
  const advanced = await poll('window.__opengolf().hole === 2 ? window.__opengolf() : null', 6000);
  ok(!!advanced, 'sinking hole 1 did not advance to hole 2', (await hook())?.hole);
  console.log('hole 1 sunk:', JSON.stringify({ scores: advanced?.scores, total: advanced?.total, hole: advanced?.hole, sim: rest?.sim }));
  ok(advanced && advanced.scores.length === 1 && advanced.scores[0] === 1, 'the hole was not scored as 1 stroke', advanced?.scores);
  ok(advanced && advanced.strokes === 0 && advanced.hole === 2, 'the new hole did not reset the hole strokes', [advanced?.strokes, advanced?.hole]);
  ok(advanced && advanced.sheet === '', 'the sheet opened mid-round', advanced?.sheet);
  ok(advanced && Math.abs(advanced.ball.z - advanced.tee.z) < 1e-6, 'the ball was not re-teed on hole 2', advanced?.ball);
  await shot('opengolf-gate-hole2');
}

// ---- 4) QA fixture: the last hole, one stroke short of the round allowance ----
{
  await ev('window.__opengolf.setup(5, 27, 24)');
  await sleep(300);
  let s = await hook();
  ok(s && s.hole === 6 && s.par === 4, 'the win fixture did not load hole 6', [s?.hole, s?.par]);
  ok(s && s.left === 3, 'the win fixture should sit three strokes from the allowance', s?.left);
  const sunk = await sinkHole(POWER_H6);
  const done = await poll('window.__opengolf().over ? window.__opengolf() : null', 8000);
  console.log('win fixture:', JSON.stringify({ over: done?.over, result: done?.result, sheet: done?.sheet, total: done?.total }));
  ok(!!done, 'the last hole did not finish the round', { sunk: sunk?.sunk, hole: sunk?.hole, ball: sunk?.ball });
  ok(done && done.result === 'win', 'the round did not end as a win', done?.result);
  ok(done && done.sheet === 'Round complete', 'the win sheet has the wrong title', done?.sheet);
  ok(done && done.scores.length === 1 && done.scores[0] <= 4, 'the last hole did not score sensibly', done?.scores);
  ok((await ev(`document.getElementById('over').classList.contains('open')`)) === true, 'the win sheet is not visible', null);
  ok((await ev(`document.getElementById('overText').textContent`)).includes('par 19'), 'the win sheet does not carry the par', await ev(`document.getElementById('overText').textContent`));
  await shot('opengolf-gate-win');
}

// ---- 5) Play again from the sheet deals a fresh round ----
{
  await clickEl('overBtn');
  await sleep(400);
  const s = await hook();
  ok(s && s.hole === 1 && s.over === false, 'Play again did not return to hole 1', [s?.hole, s?.over]);
  ok(s && s.total === 0 && s.left === 27 && s.scores.length === 0, 'Play again did not reset the scorecard', [s?.total, s?.scores]);
  ok(s && s.sheet === '', 'the sheet stayed open after Play again', s?.sheet);
}

// ---- 6) QA fixture: one stroke of allowance, miss the cup, the round is over ----
{
  await ev('window.__opengolf.setup(2, 1, 0)');
  await sleep(300);
  let s = await hook();
  ok(s && s.hole === 3 && s.left === 1, 'the lose fixture did not load hole 3 with one stroke', [s?.hole, s?.left]);
  // swing across the fairway, away from the cup, so the shot spends the allowance without holing
  const pts = await ev('window.__opengolf.dragPoints(1,0,0.5)');
  await drag(pts.from, pts.to);
  const after = await restState();
  console.log('lose fixture:', JSON.stringify({ over: after?.over, result: after?.result, sheet: after?.sheet, left: after?.left }));
  ok(!!after, 'the losing putt never came to rest', null);
  ok(after && after.left === 0, 'the allowance was not spent by the putt', after?.left);
  ok(after && after.over === true && after.result === 'lose', 'an empty allowance did not end the round as a loss', [after?.over, after?.result]);
  ok(after && after.sheet === 'Out of strokes', 'the loss sheet has the wrong title', after?.sheet);
  await shot('opengolf-gate-lose');
  await clickEl('overBtn');
  await sleep(400);
  s = await hook();
  ok(s && s.over === false && s.total === 0 && s.budget === 27, 'restarting from the loss sheet did not restore the allowance', [s?.over, s?.total, s?.budget]);
}

// ---- 7) the R key restarts a card mid-hole ----
{
  const pts = await ev('window.__opengolf.dragPoints(0,-1,0.5)');
  await drag(pts.from, pts.to);
  await sleep(200);
  ok((await hook()).strokes === 1, 'the pre-restart putt did not book', (await hook()).strokes);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 82, code: 'KeyR', key: 'r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 82, code: 'KeyR', key: 'r' });
  await sleep(400);
  const s = await hook();
  ok(s && s.strokes === 0 && s.total === 0 && s.hole === 1, 'R did not restart the round', [s?.strokes, s?.total, s?.hole]);
}

// ---- 8) portrait touch: a finger drag putts and holes out on a 390x844 phone ----
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await ev('window.__opengolf.setup(0, 27, 0)');
  await sleep(600);
  const corners = await ev(`(()=>{const a=window.__opengolf.worldPoint(-4.4,-5.4), b=window.__opengolf.worldPoint(4.4,5.4);return {a,b};})()`);
  const inside = corners && corners.a && corners.b && corners.a.x >= 0 && corners.a.y >= 0 && corners.b.x <= 390 && corners.b.y <= 844;
  ok(inside, 'the opening course does not fit a 390x844 viewport', corners);
  await swing(POWER_H1, { touch: true });
  const mid = await hook();
  ok(mid && mid.strokes === 1, 'a touch drag did not book a stroke', mid?.strokes);
  const sunk = await poll('window.__opengolf().hole === 2 ? window.__opengolf() : null', 14000);
  ok(!!sunk, 'the touch putt did not hole out on hole 1', (await hook())?.ball);
  await shot('opengolf-gate-portrait');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}

// ---- 9) console errors ----
{
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
    .filter((t) => !/favicon/i.test(t || ''));
  ok(errs.length === 0, 'the page logged console errors', errs.slice(0, 3));
}

const passes = results.filter((r) => r.pass).length;
console.log(`\ngate: ${fails ? 'FAIL' : 'PASS'} — ${passes}/${results.length} assertions`);
if (fails) {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'opengolf-gate-failures.json'), JSON.stringify(results.filter((r) => !r.pass), null, 1));
}
kill();
server.close();
process.exit(fails ? 1 : 0);
