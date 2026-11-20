#!/usr/bin/env node
// Interaction gate for the Snakes port. Serves the arcade tree, boots headless Chromium,
// and drives the game with REAL input: a tap on a board cell (steer), a swipe gesture,
// arrow-key presses, and CDP mouse clicks on the sheet buttons. Every claim below is read
// out of window.__snakes() — a canvas that merely exists is not proof.
//
// Proves: boot is deterministic and paused (no instant loss), tap steers, swipe steers,
// a real tick advances the head on wall-clock time, eating scores + grows + re-deals food,
// a wall ends the run with the lose sheet, Back up restores the pre-death position,
// the level target opens the win sheet and Next level advances, mode cycling restarts
// honestly, R restarts, no console errors, and a 390x844 touch pass steers the snake.
//
// usage: node snakes-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/snakes/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/snk-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('no page target'); process.exit(1); }
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails++; T('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('  shot ' + out);
  return out;
};
const state = () => ev('window.__snakes()');
async function waitFor(fn, ms = 15000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    if (fn(s)) return s;
    if (Date.now() - t0 > ms) return s;
    await sleep(every);
  }
}

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

// --- helpers: real input, dispatched in the page at the point the hook reports ---
const tapCell = (r, c) => ev(`(()=>{
  const p = window.__x.tilePoint(${r},${c});
  const el = document.elementFromPoint(p.x, p.y) || document.querySelector('canvas');
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:9, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { el: el.tagName + '#' + (el.id || ''), x: p.x, y: p.y };
})()`);
// kit.js decides a swipe on pointerup registered on document.body: down/move on the canvas, up on the body.
const swipe = (dx, dy) => ev(`(()=>{
  const cx = Math.round(innerWidth/2), cy = Math.round(innerHeight/2);
  const cv = document.querySelector('canvas');
  const mk = (t, x, y) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, pointerId:11, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  cv.dispatchEvent(mk('pointerdown', cx, cy));
  cv.dispatchEvent(mk('pointermove', cx + ${dx}, cy + ${dy}));
  document.body.dispatchEvent(mk('pointerup', cx + ${dx}, cy + ${dy}));
  return true;
})()`);
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await sleep(120);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(350);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent,btn:document.getElementById('overBtn').textContent}))()`);

// ---- 1) boot: deterministic, paused, food dealt, camera framed
const s0 = await state();
T('boot ' + JSON.stringify({ hook: await ev('typeof window.__snakes'), len: s0.len, dir: s0.dir, running: s0.running, food: s0.food, cam: s0.camDist }));
ok((await ev('typeof window.__snakes')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.len === 4 && s0.dir === 'right' && !s0.over && !s0.running, 'boots paused with no instant loss', s0);
ok(s0.food && !(s0.food.r === s0.head.r && s0.food.c === s0.head.c), 'food dealt off the snake', s0.food);
ok(s0.camDist > 8, 'camera fitted to the board', s0.camDist);
const boot = await ev(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {w:r.width,h:r.height};})()`);
ok(boot.w > 600 && boot.h > 400, 'webgl canvas sized', boot);
const shotBoot = await shot('snakes-gate-boot');

// ---- 2) a real tap on a board cell steers the snake and starts it
const tapInfo = await tapCell(2, 4);
const sTap = await state();
ok(tapInfo && tapInfo.el.startsWith('CANVAS'), 'the tap lands on the canvas, not the HUD', tapInfo);
ok(sTap.dir === 'up' && sTap.running && sTap.inputs >= 1, 'a tap above the head turns the snake up and starts it', sTap);
const sMoved = await waitFor((s) => s.ticks >= 1 && s.head && s.head.r < 6, 15000);
T('after tap ticks ' + JSON.stringify({ ticks: sMoved.ticks, head: sMoved.head, dir: sMoved.dir, over: sMoved.over }));
ok(sMoved.ticks >= 1, 'the wall-clock pump really ticks (not rAF)', sMoved.ticks);
ok(sMoved.head && sMoved.head.r < 6, 'the head actually moved up the board', sMoved.head);

// ---- 3) a real swipe steers (kit onDirection)
await ev(`window.__x.setup({body:[{r:6,c:10},{r:6,c:9},{r:6,c:8}],dir:'right',food:{r:0,c:0}})`);
await swipe(0, 140);
const sSwipe = await state();
ok(sSwipe.dir === 'down' && sSwipe.running, 'a downward swipe turns the snake down', sSwipe);

// ---- 4) eating: score, length and a fresh food cell, from a real key press
await ev(`window.__x.setup({body:[{r:6,c:4},{r:6,c:3},{r:6,c:2},{r:6,c:1}],dir:'right',food:{r:6,c:5},level:1})`);
await key('ArrowRight', 39);
const sEat = await waitFor((s) => s.apples >= 1 || s.over, 12000);
T('after eat ' + JSON.stringify({ score: sEat.score, len: sEat.len, apples: sEat.apples, hay: sEat.hudText, food: sEat.food, over: sEat.over }));
ok(sEat.apples === 1 && sEat.score === 10, 'eating scores and counts', { score: sEat.score, apples: sEat.apples });
ok(sEat.len === 5, 'eating grows the snake', sEat.len);
ok(sEat.hudText.score === '10' && sEat.hudText.len === '5', 'the HUD tracks the state', sEat.hudText);
ok(sEat.food && !(sEat.food.r === 6 && sEat.food.c === 5), 'a new food cell is dealt after eating', sEat.food);
const shotPlay = await shot('snakes-gate-play');

// ---- 5) walls end the run: lose sheet, then Back up restores the position
await ev(`window.__x.setup({body:[{r:6,c:0}],dir:'left',food:{r:0,c:0}})`);
await key('ArrowLeft', 37);
const sDead = await waitFor((s) => s.over, 12000);
const loseSheet = await sheet();
T('wall death ' + JSON.stringify({ over: sDead.over, reason: sDead.reason, sheet: loseSheet }));
ok(sDead.over && !sDead.won && sDead.reason === 'wall', 'the wall ends the run', sDead);
ok(loseSheet.open && /Crashed/.test(loseSheet.title), 'the lose sheet opens', loseSheet);
const shotLose = await shot('snakes-gate-lose');

await clickEl('overBack');
const sUndo = await state();
const undoSheet = await sheet();
T('after back up ' + JSON.stringify({ over: sUndo.over, len: sUndo.len, head: sUndo.head, running: sUndo.running }));
ok(!sUndo.over && !undoSheet.open, 'Back up clears the lose sheet', sUndo);
ok(sUndo.len === 1 && sUndo.head && sUndo.head.c === 0, 'Back up restores the pre-death position', sUndo.head);
// and it is playable again: steer away from the wall and tick
await ev(`window.__x.setup({body:[{r:6,c:0}],dir:'left',food:{r:0,c:0}})`);
await key('ArrowUp', 38);
const sResumed = await waitFor((s) => s.ticks >= 1, 8000);
ok(!sResumed.over && sResumed.head && sResumed.head.r === 5, 'a fresh direction escapes the wall', sResumed.head);

// ---- 6) the level target opens the win sheet, and Next level advances
await ev(`window.__x.setup({body:[{r:6,c:10},{r:6,c:9}],dir:'right',food:{r:6,c:11},apples:5,target:6,score:50,level:1})`);
await key('ArrowRight', 39);
const sWin = await waitFor((s) => s.won || s.over, 12000);
const winSheet = await sheet();
T('win ' + JSON.stringify({ won: sWin.won, over: sWin.over, sheet: winSheet, level: sWin.level, apples: sWin.apples }));
ok(sWin.won && sWin.over && sWin.apples === 6, 'the sixth seed clears the level', { apples: sWin.apples, won: sWin.won });
ok(winSheet.open && /Level cleared/.test(winSheet.title), 'the win sheet opens', winSheet);
ok(winSheet.btn === 'Next level', 'the sheet offers the next level', winSheet.btn);
const shotWin = await shot('snakes-gate-win');
await clickEl('overBtn');
const sNext = await state();
T('next level ' + JSON.stringify({ level: sNext.level, len: sNext.len, score: sNext.score, over: sNext.over }));
ok(sNext.level === 2 && sNext.len === 4 && sNext.score === 0 && !sNext.over, 'Next level starts level 2 fresh', sNext);

// ---- 7) mode cycling restarts honestly; R restarts
await clickEl('mode');
const sWrap = await state();
const modeLabel = await ev(`document.getElementById('mode').textContent`);
T('mode ' + JSON.stringify({ wrap: sWrap.wrap, label: modeLabel, len: sWrap.len }));
ok(sWrap.wrap === true && /Walls off/.test(modeLabel), 'the mode button flips the walls', { wrap: sWrap.wrap, label: modeLabel });
ok(sWrap.len === 4 && !sWrap.over && sWrap.ticks === 0, 'cycling the mode restarts the board', sWrap);
await ev(`window.__x.setup({body:[{r:6,c:4},{r:6,c:3}],dir:'right',food:{r:0,c:0}})`);
await key('ArrowRight', 39);
await waitFor((s) => s.ticks >= 2, 8000);
await key('KeyR', 82);
const sR = await state();
ok(sR.len === 4 && sR.ticks === 0 && !sR.over && sR.head.c === 4, 'R restarts', sR);

// ---- 8) console errors
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---- 9) portrait touch: a finger tap on a cell steers, camera reframes
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const touch = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(220);
};
const sP0 = await state();
const pPt = await ev(`window.__x.tilePoint(2, 6)`);
await touch(pPt);
const sP1 = await state();
const sPTick = await waitFor((s) => s.ticks >= 1, 15000);
const shotPhone = await shot('snakes-gate-phone');
T('portrait ' + JSON.stringify({ before: { dir: sP0.dir, len: sP0.len }, after: { dir: sP1.dir, running: sP1.running }, ticks: sPTick.ticks, cam: sP0.camDist }));
ok(sP1.running && sP1.dir !== sP0.dir, 'portrait: a finger tap steers the snake', { before: sP0.dir, after: sP1.dir });
ok(sPTick.ticks >= 1, 'portrait: the game runs after the tap', sPTick.ticks);
ok(sP0.camDist !== s0.camDist, 'portrait camera reframed', { landscape: s0.camDist, portrait: sP0.camDist });

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotPlay, shotLose, shotWin, shotPhone],
  boot: { len: s0.len, dir: s0.dir, food: s0.food },
  tap: { dir: sTap.dir, ticks: sMoved.ticks, head: sMoved.head },
  eat: { score: sEat.score, len: sEat.len, apples: sEat.apples },
  lose: { reason: sDead.reason, title: loseSheet.title },
  win: { level: sNext.level, title: winSheet.title },
  portrait: { dir: sP1.dir, ticks: sPTick.ticks },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
