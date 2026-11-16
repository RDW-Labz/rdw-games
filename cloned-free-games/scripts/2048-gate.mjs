#!/usr/bin/env node
// Interaction gate for the 2048 port: real CDP mouse swipes / arrow keys / touch on the 3D board,
// state-hook assertions for move / merge score / undo / win / lose / restart, screenshots.
// usage: node 2048-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/2048.html';
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/g2048-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const state = () => ev('window.__arcade.state()');
const key = (g) => JSON.stringify(g.grid);

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const errorsOf = (from = 0) => cdp.events.slice(from).filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// A real drag on the canvas: pressed at A, moved in steps, released at B.
const swipe = async (from, to, steps = 6) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', pointerType: 'mouse' });
    await sleep(16);
  }
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(240);
};
const DIRS = {
  left: [{ x: 900, y: 400 }, { x: 380, y: 400 }],
  right: [{ x: 380, y: 400 }, { x: 900, y: 400 }],
  up: [{ x: 640, y: 560 }, { x: 640, y: 200 }],
  down: [{ x: 640, y: 200 }, { x: 640, y: 560 }],
};
const doSwipe = (d) => swipe(DIRS[d][0], DIRS[d][1]);
const arrow = async (code) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Arrow', ''), windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[code] });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Arrow', ''), windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[code] });
  await sleep(240);
};
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const click = async (p) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 1) boot
const s0 = await state();
const cam0 = await ev('window.__arcade.camera()');
const shotBoot = await shot('2048-gate-boot');

// ---- 2) a real swipe moves the board
const before = key(s0);
await doSwipe('left');
const s1 = await state();

// ---- 3) arrow keys move the board (try directions until one changes the grid)
let keyMoved = null, sKey = null;
for (const code of ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft']) {
  const prev = key(await state());
  await arrow(code);
  const now = await state();
  if (key(now) !== prev) { keyMoved = code; sKey = now; break; }
}

// ---- 4) play until a merge scores something
let sScore = await state(), moves = 0;
const cycle = ['left', 'up', 'right', 'down'];
while (sScore.score === 0 && moves < 80 && !sScore.over) {
  await doSwipe(cycle[moves % 4]);
  sScore = await state(); moves++;
}
const shotPlay = await shot('2048-gate-play');

// ---- 5) undo returns to the pre-move score and board
const preUndo = await state();
await doSwipe('left');
const afterMove = await state();
await clickEl('undo');
const sUndo = await state();

// ---- 6) win: two 1024s in a row, swipe to merge 2048 -> sheet
await ev(`window.__arcade.setup([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 0)`);
await sleep(300);
await doSwipe('left');
await sleep(400);
const sWin = await state();
const winSheet = await sheet();
const shotWin = await shot('2048-gate-win');

// ---- 7) lose: a full board with no equal neighbours; the only legal move deadlocks
await ev(`window.__arcade.setup([[4,2,4,2],[2,4,2,4],[16,32,16,32],[8,4,2,0]], 12)`);
await sleep(300);
await doSwipe('right');
await sleep(600);
const sLose = await state();
const loseSheet = await sheet();
const shotLose = await shot('2048-gate-lose');

// ---- 8) restart from the sheet
await clickEl('overBtn');
await sleep(400);
const sNew = await state();

// ---- 9) touch: portrait phone, finger swipe
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const t0 = await state();
const tSwipe = async (a, b) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, radiusX: 9, radiusY: 9, force: 1 }] });
  for (let i = 1; i <= 5; i++) {
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 5, y: a.y + ((b.y - a.y) * i) / 5, radiusX: 9, radiusY: 9, force: 1 }] });
    await sleep(16);
  }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
await tSwipe({ x: 300, y: 430 }, { x: 90, y: 430 });
const sTouch = await state();
const shotTouch = await shot('2048-gate-touch');
const errors = errorsOf();

const checks = {
  boot: !!s0 && s0.tiles === 2 && s0.score === 0 && s0.over === false && s0.won === false,
  cameraSane: Array.isArray(cam0) && cam0.every((n) => Number.isFinite(n) && Math.abs(n) < 40),
  swipeMoves: key(s1) !== before && s1.tiles >= 3,
  keyMoves: !!keyMoved && key(sKey) !== key(s1),
  merged: sScore.score > 0,
  undoRestores: sUndo.score === preUndo.score && afterMove.score >= preUndo.score,
  won: sWin.won === true && sWin.over === true && winSheet.open === true && /2048/.test(winSheet.title),
  lost: sLose.over === true && loseSheet.open === true && /no moves/i.test(loseSheet.title),
  restarted: sNew.over === false && sNew.score === 0 && sNew.tiles === 2,
  touchMoves: key(sTouch) !== key(t0) && sTouch.tiles >= 3,
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { tiles: s0.tiles, score: s0.score, grid: s0.grid },
  s1: { tiles: s1.tiles, grid: s1.grid },
  keyMoved, keyGrid: sKey && sKey.grid,
  merge: { score: sScore.score, moves, grid: sScore.grid },
  undo: { pre: preUndo.score, after: afterMove.score, undone: sUndo.score },
  win: { won: sWin.won, over: sWin.over, grid: sWin.grid, sheet: winSheet },
  lose: { over: sLose.over, grid: sLose.grid, sheet: loseSheet },
  restart: { tiles: sNew.tiles, score: sNew.score },
  touch: { tiles: t0.tiles, after: sTouch.tiles, grid: sTouch.grid },
  cam0,
  shots: [shotBoot, shotPlay, shotWin, shotLose, shotTouch],
}, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
