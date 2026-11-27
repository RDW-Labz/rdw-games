#!/usr/bin/env node
// Interaction gate for the Super Retro Mega Wars port. Real CDP input only: a mouse move aims the
// ship, a mouse click fires and kills a rock, a tracked mouse keeps the breakout paddle under the
// ball until the wall comes down, real taps steer the snake onto a pellet, the win/loss sheets open
// from QA positions, and a 390x844 portrait touch pass proves the board fits the HUD and steers.
// usage: node srmw-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/super-retro-mega-wars/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const ART = '/home/cluer/cloned-free-games/.queue/lib-art';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/srmw-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const until = async (fn, ms = 10000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const moveTo = async (pt) => S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
const touchTap = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
  await sleep(60);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const clickEl = async (id, wait = 300) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const state = () => ev('window.__srmw()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__srmw');
const modes = await ev('window.__srmw.modes()');
const r0 = await ev('window.__srmw.render()');
await sleep(900);
const r1 = await ev('window.__srmw.render()');
const sTick = await state();
const s0 = sTick;
T('boot ' + JSON.stringify({ hookType, modes, render0: r0, render1: r1, mode: s0 && s0.mode }));
ok(hookType === 'function', 'the state hook is a function', hookType);
ok(Array.isArray(modes) && modes.length === 3 && modes.includes('asteroids'), 'three games are wired', modes);
ok(r0 && r0.tris > 100 && r0.calls > 3, 'the scene actually renders geometry', r0);
// headless SwiftShader runs a handful of frames a second; the sim clock is the real proof of life
ok(r1 && r1.frames > r0.frames && s0 && s0.t > 2, 'the frame loop and the round clock are running', { a: r0 && r0.frames, b: r1 && r1.frames, t: s0 && s0.t });
ok(s0 && s0.mode === 'asteroids' && s0.over === false && s0.you === 0 && s0.lives[0] === 3, 'a fresh asteroids round is live, 3 lives, 0-0', s0 && { mode: s0.mode, you: s0.you, lives: s0.lives });
ok(s0 && s0.errors === 0, 'no page errors at boot', s0 && s0.errors);
const shotBoot = await shot('srmw-gate-boot');

// ---------- 2) a real mouse move aims the ship ----------
const aimAt = await ev('window.__srmw.fieldPoint(-4.2, 4)');
ok(aimAt && !aimAt.__err, 'the field projects to a screen point', aimAt);
await moveTo(aimAt);
await sleep(260);
const sAim = await state();
T('aim ' + JSON.stringify({ shipX: sAim && sAim.shipX, inputs: sAim && sAim.inputs }));
ok(sAim && Math.abs(sAim.shipX[0] + 4.2) < 0.7, 'moving the mouse slides the ship to that lane', sAim && sAim.shipX);

// ---------- 3) a real click fires and kills ----------
await ev(`window.__srmw.setup({mode:'asteroids', seed:7, t:0, dur:60, you:0, cpu:0, invuln:[9,9], cool:[0,9], shipX:0,
  rocks:[{x:0, z:-2.0, vx:0, vz:0.5, r:0.8}]})`);
await sleep(200);
const rockPt = await ev('window.__srmw.rockPoint(0)');
const beforeFire = await state();
await click(rockPt);
const killed = await until(async () => { const s = await state(); return s && s.you > 0 ? s : null; }, 4000);
T('fire ' + JSON.stringify({ rockPt, you: beforeFire && beforeFire.you, after: killed && { you: killed.you, rocks: killed.rocks.length } }));
ok(killed && killed.you >= 8, 'a real click on the rock scores a kill', killed && { you: killed.you });
ok(killed && killed.kills[0] === 1, 'the kill is credited to the visitor, not the cpu', killed && killed.kills);
const shotFire = await shot('srmw-gate-fire');

// ---------- 4) the win sheet, from a QA position ----------
await ev(`window.__srmw.setup({mode:'asteroids', seed:5, t:0, dur:60, you:140, cpu:10, invuln:[9,9], cool:[0,9], shipX:0,
  rocks:[{x:0, z:-2.0, vx:0, vz:0.4, r:0.7}]})`);
await sleep(200);
await click(await ev('window.__srmw.rockPoint(0)'));
const winState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 5000);
const winSheet = await sheet();
T('win ' + JSON.stringify({ result: winState && winState.result, you: winState && winState.you, sheet: winSheet }));
ok(winState && winState.over && winState.result === 'win', 'reaching 150 ends the round as a win', winState && { result: winState.result, you: winState.you });
ok(winSheet && winSheet.open && /war is yours/i.test(winSheet.title), 'the win sheet carries its own title', winSheet);
const shotWin = await shot('srmw-gate-win');
await clickEl('overBtn', 400);
const afterReplay = await state();
ok(afterReplay && !afterReplay.over && afterReplay.you === 0, 'Play again deals a fresh live round', afterReplay && { over: afterReplay.over, you: afterReplay.you });

// ---------- 4b) a busy field, for the tile art ----------
await ev(`window.__srmw.setup({mode:'asteroids', seed:19, t:0, dur:60, you:40, cpu:30, invuln:[9,9], cool:[0,9], shipX:-1.5,
  rocks:[{x:-3.4,z:-0.8,vx:0.3,vz:0.4,r:0.9},{x:1.4,z:1.6,vx:-0.4,vz:0.3,r:0.7},{x:4.2,z:0.4,vx:0.2,vz:0.5,r:0.65},{x:-0.4,z:-3.8,vx:0.1,vz:0.4,r:0.85},{x:2.6,z:-2.4,vx:-0.2,vz:0.35,r:0.75}]})`);
await sleep(500);
const sField = await state();
T('field ' + JSON.stringify({ rocks: sField && sField.rocks.length, tris: (await ev('window.__srmw.render()')).tris }));
ok(sField && sField.rocks.length === 5, 'a five-rock field is on the board', sField && sField.rocks);
const shotField = await shot('srmw-gate-field');

// ---------- 5) breakout: a tracked mouse keeps the ball alive and breaks the wall ----------
const b0 = await ev(`window.__srmw.setup({mode:'breakout', seed:11, t:0, dur:60})`);
T('breakout setup ' + JSON.stringify({ mode: b0 && b0.mode, bricks: b0 && b0.bricks, cpuBricks: b0 && b0.cpuBricks, lives: b0 && b0.lives }));
ok(b0 && b0.mode === 'breakout' && b0.bricks === 36 && b0.cpuBricks === 36, 'two 36-brick walls face each other', b0 && { bricks: b0.bricks, cpuBricks: b0.cpuBricks });
ok(b0 && b0.lives[0] === 3, 'three balls to start', b0 && b0.lives);
let tracked = 0;
for (let i = 0; i < 44; i++) {
  const p = await ev('window.__srmw.ballPoint(0)');
  if (p && !p.__err) { await moveTo(p); tracked++; }
  await sleep(170);
}
const bPlay = await state();
T('breakout play ' + JSON.stringify({ tracked, broken: bPlay && bPlay.broken, misses: bPlay && bPlay.misses, bricks: bPlay && bPlay.bricks, paddleX: bPlay && bPlay.paddleX, ballX: bPlay && bPlay.ball.x, lives: bPlay && bPlay.lives }));
ok(bPlay && bPlay.broken[0] >= 3, 'a tracked mouse breaks bricks off your wall', bPlay && bPlay.broken);
ok(bPlay && bPlay.misses[0] <= 1, 'a tracked paddle keeps the ball in play', bPlay && bPlay.misses);
ok(bPlay && Math.abs(bPlay.paddleX - bPlay.ball.x) < 2.2, 'the paddle follows the ball', bPlay && { paddleX: bPlay.paddleX, ballX: bPlay.ball.x });
ok(bPlay && bPlay.lives[0] >= 2, 'no more than one ball lost', bPlay && bPlay.lives);
const shotBreakout = await shot('srmw-gate-breakout');

// ---------- 6) breakout loss: the cpu finishing its wall ----------
const bLoss = await ev(`window.__srmw.setup({mode:'breakout', seed:3, t:0, dur:60, cpuBricks:0})`);
await sleep(400);
const bLossState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 4000);
const bLossSheet = await sheet();
T('breakout loss ' + JSON.stringify({ result: bLossState && bLossState.result, sheet: bLossSheet }));
ok(bLossState && bLossState.over && bLossState.result === 'lose', 'the cpu clearing its wall loses you the round', bLossState && { result: bLossState.result });
ok(bLossSheet && bLossSheet.open && /cpu takes the round/i.test(bLossSheet.title), 'the loss sheet names the cpu', bLossSheet);
const shotLose = await shot('srmw-gate-lose');

// ---------- 7) snake: real taps steer, and steering onto a pellet scores ----------
const s0n = await ev(`window.__srmw.setup({mode:'snake', seed:21, t:0, dur:60, started:false,
  bodies:[[[2,9],[1,9],[0,9]],[[10,8],[11,8],[12,8]]], dirs:[[1,0],[-1,0]], pellets:[[3,9],[11,2]]})`);
T('snake setup ' + JSON.stringify({ mode: s0n && s0n.mode, head: s0n && s0n.head, started: s0n && s0n.started, pellets: s0n && s0n.pellets }));
ok(s0n && s0n.mode === 'snake' && s0n.started === false, 'the snake waits for a first steer', s0n && { mode: s0n.mode, started: s0n.started });
const aheadPt = await ev('window.__srmw.cellPoint(3, 9)');
await click(aheadPt);
const steered = await until(async () => { const s = await state(); return s && s.started ? s : null; }, 3000);
T('steer ' + JSON.stringify({ pt: aheadPt, dir: steered && steered.dir, head: steered && steered.head }));
ok(steered && steered.started === true && steered.dir[0] === 1 && steered.dir[1] === 0, 'a real tap steers the snake right', steered && { dir: steered.dir, started: steered.started });
const ate = await until(async () => { const s = await state(); return s && s.you >= 10 ? s : null; }, 5000);
T('pellet ' + JSON.stringify({ you: ate && ate.you, head: ate && ate.head, len: ate && ate.len }));
ok(ate && ate.you >= 10, 'steering onto the pellet scores 10', ate && { you: ate.you, head: ate.head });
ok(ate && ate.len[0] >= 4, 'eating grows the snake', ate && ate.len);
const shotSnake = await shot('srmw-gate-snake');

// ---------- 8) portrait: the board fits the hud band and a touch steers ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(1400);
const geom = await ev('window.__srmw.band()');
const inside = geom && geom.points ? geom.points.filter((p) => p && p.x > 2 && p.x < 388 && p.y > geom.topPx && p.y < geom.botPx).length : -1;
T('portrait ' + JSON.stringify({ topPx: geom && geom.topPx, botPx: geom && geom.botPx, inside, of: geom && geom.points && geom.points.length }));
ok(inside === 4, 'all four arena corners sit inside the band the hud leaves on a 390x844 phone', { inside, geom });
const bSnake = await ev(`window.__srmw.setup({mode:'snake', seed:22, t:0, dur:60, started:false,
  bodies:[[[6,9],[5,9],[4,9]],[[10,4],[11,4],[12,4]]], dirs:[[1,0],[-1,0]], pellets:[[7,9],[2,14]]})`);
const upPt = await ev('window.__srmw.cellPoint(6, 8)');
await touchTap({ x: 12, y: 12 });
await sleep(150);
let ts = null;
for (let i = 0; i < 3 && !ts; i++) {
  await touchTap(upPt);
  await sleep(450);
  const s = await state();
  if (s && s.started && s.dir[1] === -1) ts = s;
}
T('portrait touch ' + JSON.stringify({ pt: upPt, started: ts && ts.started, dir: ts && ts.dir, b: bSnake && bSnake.mode }));
ok(ts && ts.started === true && ts.dir[1] === -1, 'a real touch on the portrait board steers the snake up', ts && { dir: ts.dir, started: ts.started });
const shotPortrait = await shot('srmw-gate-portrait');

// ---------- 9) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 220));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the run', errText);
const pageErrs = await state();
ok(pageErrs && pageErrs.errors === 0, 'the page counted no runtime errors', pageErrs && pageErrs.errors);

proc.kill('SIGKILL');
server.close();
await mkdir(ART, { recursive: true });
await copyFile(shotField, join(ART, 'super-retro-mega-wars.png')).catch(() => {});
console.log('\nshots: ' + [shotBoot, shotFire, shotWin, shotField, shotBreakout, shotLose, shotSnake, shotPortrait].join(' '));
if (fails.length) { console.error(`\nSRMW GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('SRMW GATE PASS');
