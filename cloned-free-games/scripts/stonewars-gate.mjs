#!/usr/bin/env node
// Interaction gate for the Stone Wars port: real CDP mouse drags out of the tray onto the
// 3D field, state-hook assertions for placement, line clear, liberation win, full-field loss,
// restart, planet advance, and a portrait-phone touch drag. Screenshots at every stage.
// usage: node stonewars-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/stonewars.html';
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

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/sbin/chromium'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/gstone-');
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
const state = () => ev('window.__stonewars()');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const errorsOf = (from = 0) => cdp.events.slice(from).filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (p) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (b) await click(b);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// Drag slab `slot` out of the tray and drop it so its top-left cell lands on (r,c).
const dragPiece = async (slot, r, c) => {
  const grab = await ev(`window.__stonewars.grabPoint(${slot})`);
  const drop = await ev(`window.__stonewars.anchorPoint(${slot},${r},${c})`);
  if (!grab || !drop || grab.__err || drop.__err) return { grab, drop };
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grab.x, y: grab.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: grab.x, y: grab.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(70);
  for (let k = 1; k <= 4; k++) {
    const x = grab.x + (drop.x - grab.x) * k / 4, y = grab.y + (drop.y - grab.y) * k / 4;
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', pointerType: 'mouse' });
    await sleep(45);
  }
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drop.x, y: drop.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
  return { grab, drop };
};
const touchDragPiece = async (slot, r, c) => {
  const grab = await ev(`window.__stonewars.grabPoint(${slot})`);
  const drop = await ev(`window.__stonewars.anchorPoint(${slot},${r},${c})`);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grab.x, y: grab.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(70);
  for (let k = 1; k <= 4; k++) {
    const x = grab.x + (drop.x - grab.x) * k / 4, y = grab.y + (drop.y - grab.y) * k / 4;
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 9, radiusY: 9, force: 1 }] });
    await sleep(45);
  }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(360);
  return { grab, drop };
};
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await sleep(400);
};

// ---- 1) boot: empty field, three slabs dealt, no instant loss
const s0 = await state();
const shotBoot = await shot('stonewars-gate-boot');

// ---- 2) a real drag out of the tray lands slabs on the field
const shapes0 = s0.tray;
const place1 = await dragPiece(0, 5, 5);
const s1 = await state();

// ---- 3) line clear: one row short by three cells, a three-slab fills it
const near = await ev(`window.__stonewars.setup(
  ['...#######','...#######','','','','','','','',''],
  ['r3h','dot','dot'], 0, 0)`);
const beforeClear = await state();
const clearDrop = await dragPiece(0, 0, 0);
const sClear = await state();
const shotClear = await shot('stonewars-gate-clear');
const shotNear = await shot('stonewars-gate-near');

// ---- 4) liberation: score one placement short of the goal, then cross it by clicking
await ev(`window.__stonewars.setup(
  Array.from({length:10},()=>'.'.repeat(10)), ['dot','dot','dot'], ${900 - 4}, 0)`);
const beforeWin = await state();
await dragPiece(0, 4, 4);
const sWin = await state();
const shotWin = await shot('stonewars-gate-win');

// ---- 5) full field: only two isolated holes, nothing in the tray fits
await ev(`window.__stonewars.setup(
  ['.####.####','##########','##########','##########','##########',
   '##########','##########','##########','##########','##########'],
  ['r3h','o4','o9'], 0, 0)`);
const sLose = await state();
const shotLose = await shot('stonewars-gate-lose');

// ---- 6) restart from the sheet
await clickEl('overBtn');
await sleep(500);
const sRestart = await state();

// ---- 7) keyboard: N advances the planet (and its liberation goal)
await key('KeyN', 78);
const sPlanet = await state();

// ---- 8) portrait phone: finger drag out of the tray onto the field
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const t0 = await state();
const phoneGrab = await ev('window.__stonewars.grabPoint(0)');
const phoneDrop = await ev('window.__stonewars.anchorPoint(0,4,4)');
const phoneCell = await ev('window.__stonewars.cellPoint(0,0)');
await touchDragPiece(0, 4, 4);
const sTouch = await state();
const shotTouch = await shot('stonewars-gate-touch');
const phoneCorner = await ev('window.__stonewars.cellPoint(9,9)');
const errors = errorsOf();

const onScreen = (p) => p && p.x > 2 && p.x < 388 && p.y > 2 && p.y < 842;
const checks = {
  boot: !!s0 && s0.score === 0 && s0.filled === 0 && s0.tray.length === 3 && s0.over === false && s0.goal === 900 && s0.sheet === false,
  dragPlaces: s1.filled === s0.trayCells[0] && s1.score === 4 * s0.trayCells[0] && s1.tray[0] !== shapes0[0],
  dropOnTarget: place1.grab && place1.drop && place1.drop.x > 0 && place1.drop.y > 0,
  setupNearFull: beforeClear.filled === 14,
  lineClears: sClear.lines === 1 && sClear.score === 4 * 3 + 50 + 2 * 10 && sClear.filled === beforeClear.filled + 3 - 10,
  winReached: sWin.won === true && sWin.over === true && sWin.score >= 900 && sWin.sheet === true && /liberated/i.test(sWin.title),
  loseReached: sLose.over === true && sLose.won === false && sLose.sheet === true && /field is full/i.test(sLose.title) && sLose.fits.every((f) => f === false),
  restarted: sRestart.over === false && sRestart.score === 0 && sRestart.filled === 0 && sRestart.sheet === false,
  planetAdvances: sPlanet.planet === (sRestart.planet + 1) % 4 && sPlanet.goal !== sRestart.goal,
  touchPlaces: sTouch.filled === t0.trayCells[0] && sTouch.score > 0,
  touchOnScreen: [phoneGrab, phoneDrop, phoneCell, phoneCorner].every((p) => onScreen(p)),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { tray: s0.tray, score: s0.score, goal: s0.goal, filled: s0.filled },
  place1, s1: { filled: s1.filled, score: s1.score, tray: s1.tray },
  clear: { before: beforeClear.filled, after: sClear.filled, lines: sClear.lines, score: sClear.score, drop: clearDrop },
  win: { score: sWin.score, won: sWin.won, title: sWin.title },
  lose: { over: sLose.over, title: sLose.title, fits: sLose.fits, tray: sLose.tray },
  restart: { score: sRestart.score, filled: sRestart.filled, planet: sRestart.planet },
  planet: { planet: sPlanet.planet, goal: sPlanet.goal },
  touch: { n0: t0.trayCells[0], filled: sTouch.filled, score: sTouch.score, points: { phoneGrab, phoneDrop, phoneCell } },
  shots: [shotBoot, shotNear, shotClear, shotWin, shotLose, shotTouch],
}, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
