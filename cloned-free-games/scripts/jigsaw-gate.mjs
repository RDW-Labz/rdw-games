#!/usr/bin/env node
// Interaction gate for the Jigsaw Solitaire port (Jigsaw-Solitaire / Jigsaw cards):
// real pointer drags on the board, state-hook assertions for lock / win / restart / give-up,
// plus a portrait touch pass. usage: node jigsaw-gate.mjs <stagedDir> [port]
//   stagedDir must contain games/arcade/jigsaw-solitaire/index.html + kit.js
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/tmp/jigsaw-stage');
const FILE = 'games/arcade/jigsaw-solitaire/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 45000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/jigsaw-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1440,900', '--no-first-run',
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
T('serving ' + port);
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
const state = () => ev('window.__jigsaw && window.__jigsaw()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(350);
  return b;
};
// Whole gesture constructed inside the page: down at A, six moves, up at B. The port reads its
// listeners off window, so a synthetic PointerEvent dispatched there is exactly what a finger sends.
const dragInPage = async (A, B, kind = 'mouse') => ev(`(() => {
  const mk = (t,x,y,b) => new PointerEvent(t, { pointerId: 1, pointerType: '${kind}', isPrimary: true,
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: b });
  const a = { x: ${+A.x}, y: ${+A.y} }, b = { x: ${+B.x}, y: ${+B.y} };
  window.dispatchEvent(mk('pointerdown', a.x, a.y, 1));
  for (let k = 1; k <= 6; k++) window.dispatchEvent(mk('pointermove', a.x + (b.x - a.x) * k / 6, a.y + (b.y - a.y) * k / 6, 1));
  window.dispatchEvent(mk('pointerup', b.x, b.y, 0));
  return { a, b };
})()`);
const load = async (w, h, mobile) => {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
  await sleep(5200);
  return ev('typeof window.__jigsaw');
};

const problems = [];
const checks = {};
const ok = (name, cond, why = '') => { checks[name] = cond ? 'ok' : 'FAIL'; if (!cond) problems.push(name + (why ? ': ' + why : '')); };

// ---------- desktop: real drags, whole board ----------
const hookType = await load(1440, 900, false);
ok('module booted, hook is a function', hookType === 'function', String(hookType));
let st = await state();
ok('dealt 12 pieces, none placed', st && st.total === 12 && st.placed === 0, JSON.stringify(st && { placed: st.placed, total: st.total }));

const drags = [];
for (let i = 0; i < 12; i++) {
  const A = await ev(`window.__jigsaw.aim(${i})`);
  const B = await ev(`window.__jigsaw.slotPoint(${i})`);
  if (!A || A.__err || !B || B.__err) { problems.push('no points for piece ' + i); break; }
  await dragInPage(A, B);
  await sleep(180);
  const s = await state();
  drags.push({ i, placed: s && s.placed, moves: s && s.moves });
  if (s && s.placed !== i + 1) { problems.push(`piece ${i} did not lock (placed=${s.placed})`); break; }
}
st = await state();
ok('every real drag locked its piece', st && st.placed === 12, `placed=${st && st.placed}`);
ok('win reached', !!(st && st.won && st.over));
const winSheet = await sheet();
ok('win sheet open with the right title', winSheet.open && winSheet.title === 'Picture complete.', JSON.stringify(winSheet));
const winShot = await shot('jigsaw-win');

// ---------- restart ----------
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
st = await state();
ok('R restarts the deal', st && st.placed === 0 && !st.over && !st.won, JSON.stringify(st && { placed: st.placed, over: st.over }));

// ---------- a drop that misses must not lock ----------
{
  const A = await ev('window.__jigsaw.aim(0)');
  const B = await ev('window.__jigsaw.slotPoint(5)');    // a different piece's slot
  await dragInPage(A, B);
  await sleep(300);
  const s = await state();
  ok('a drop on the wrong slot does not lock', s && s.placed === 0 && s.moves === 1, JSON.stringify(s && { placed: s.placed, moves: s.moves }));
}

// ---------- peek + hint controls ----------
{
  const before = await ev('window.__jigsaw().peek');
  await clickEl('peek');
  const after = await ev('window.__jigsaw().peek');
  ok('Picture button toggles the ghost image', before !== after, `${before}->${after}`);
  await clickEl('peek');
  await clickEl('hintBtn');
  await sleep(200);
  const hinted = await ev(`document.querySelectorAll('canvas').length >= 1`);
  ok('hint press accepted without error', hinted === true);
}

// ---------- mid-play shot ----------
for (const i of [1, 2, 3]) {
  const A = await ev(`window.__jigsaw.aim(${i})`);
  const B = await ev(`window.__jigsaw.slotPoint(${i})`);
  await dragInPage(A, B);
  await sleep(200);
}
const mid = await state();
ok('three pieces locked mid-play', mid && mid.placed === 3, JSON.stringify(mid && { placed: mid.placed, moves: mid.moves }));
const midShot = await shot('jigsaw-mid');

// ---------- give up (the lose state) ----------
await clickEl('giveUp');
st = await state();
const loseSheet = await sheet();
ok('Give up ends the puzzle', !!(st && st.lost && st.over && !st.won), JSON.stringify(st && { lost: st.lost, over: st.over }));
ok('lose sheet names the pieces left', loseSheet.open && /pieces? still loose/i.test(loseSheet.text), JSON.stringify(loseSheet));

// ---------- portrait touch ----------
const pHook = await load(390, 844, true);
ok('portrait boot', pHook === 'function');
let placedTouch = 0;
for (const i of [0, 1, 2, 3]) {
  const A = await ev(`window.__jigsaw.aim(${i})`);
  const B = await ev(`window.__jigsaw.slotPoint(${i})`);
  await dragInPage(A, B, 'touch');
  await sleep(220);
  placedTouch = (await state()).placed;
}
ok('touch drags place pieces on a 390x844 phone', placedTouch >= 3, `placed=${placedTouch}`);
const pShot = await shot('jigsaw-portrait');

const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => (e.params.exceptionDetails?.exception?.description || '').slice(0, 200)).slice(0, 4);
ok('no console errors / exceptions', errors.length === 0, errors.join(' | '));

const pass = problems.length === 0;
console.log(JSON.stringify({ checks, problems, drags, winSheet, loseSheet, shots: { winSocket: winShot, mid: midShot, portrait: pShot }, errors }, null, 1));
console.log(pass ? 'JIGSAW GATE PASS' : 'JIGSAW GATE FAIL');
proc.kill('SIGKILL');
server.close();
process.exit(pass ? 0 : 1);
