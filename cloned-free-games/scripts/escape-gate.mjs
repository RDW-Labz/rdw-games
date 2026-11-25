#!/usr/bin/env node
// Interaction gate for the Arrow Escape port (quarantined Arrow-Escape-Infinite-Puzzle card):
// real CDP mouse clicks on tile centres, state-hook assertions for a legal escape, a
// blocked tap costing a life, a whole board cleared by click-through to the next level,
// the out-of-lives sheet, restart, a grown 5x5 board, and portrait touch.
// usage: node escape-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/arrow-escape-infinite-puzzle/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/escape-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 180000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
process.on('unhandledRejection', (e) => { proc.kill('SIGKILL'); throw e; });
process.on('SIGTERM', () => proc.kill('SIGKILL'));
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
const hook = () => ev('window.__escape()');

async function waitFor(expr, ms = 90000, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    if (v) { T('ready after ' + (Date.now() - t0) + 'ms'); return v; }
    await sleep(step);
  }
  throw new Error('timeout waiting for ' + expr);
}

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await waitFor("typeof window.__escape === 'function'");

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickTile = async (xy) => {
  const p = await ev(`window.__escape.tilePoint(${xy[0]}, ${xy[1]})`);
  await click({ x: Math.round(p.x), y: Math.round(p.y) });
  await sleep(200);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(340);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot
const s0 = await hook();
const hookType = await ev('typeof window.__escape');
const pts = [];
for (let y = 0; y < s0.size; y++) for (let x = 0; x < s0.size; x++) pts.push(await ev(`window.__escape.tilePoint(${x}, ${y})`));
const shotBoot = await shot('escape-gate-boot');
T('boot ' + JSON.stringify({ level: s0.level, size: s0.size, left: s0.left, lives: s0.lives, tappable: s0.tappable.length }));

// ---- 2) one legal click: a tappable arrow leaves the board
const firstFree = s0.tappable[0];
const pFree = await clickTile(firstFree);
const s1 = await hook();
T('after free ' + JSON.stringify({ left: s1.left, firstFree, taps: s1.taps }));

// ---- 3) one blocked click costs a life and leaves the board alone
const blocked = (() => {
  for (let y = 0; y < s1.size; y++) for (let x = 0; x < s1.size; x++) {
    if (s1.grid[y] && s1.grid[y][x] && !s1.tappable.some(([tx, ty]) => tx === x && ty === y)) return [x, y];
  }
  return null;
})();
const pBlocked = blocked ? await clickTile(blocked) : null;
const s2 = await hook();
T('after blocked ' + JSON.stringify({ blocked, left: s2.left, lives: s2.lives, blockedTaps: s2.blockedTaps }));

// ---- 4) clear the whole board by clicking only legal moves
let steps = 0, blockedDuringSolve = 0;
const shotMidTaken = { v: false };
for (let i = 0; i < 60; i++) {
  const st = await hook();
  if (!st.tappable.length) break;
  if (!shotMidTaken.v && st.left <= Math.floor(s0.left * 0.55)) { await shot('escape-gate-midclear'); shotMidTaken.v = true; }
  const before = st.left;
  await clickTile(st.tappable[0]);
  const after = await hook();
  if (after.left === before) blockedDuringSolve++;
  steps++;
}
const sSolved = await hook();
T('solved ' + JSON.stringify({ steps, left: sSolved.left, blockedDuringSolve, level: sSolved.level }));
await sleep(1400);
const sNext = await hook();
const shotClear = await shot('escape-gate-cleared');
T('next level ' + JSON.stringify({ level: sNext.level, size: sNext.size, left: sNext.left, lives: sNext.lives }));

// ---- 5) a 5x5 board at level 4 is framed
await ev('window.__escape.setup({level: 4})');
await sleep(300);
const sBig = await hook();
const bigPts = [];
for (let y = 0; y < sBig.size; y++) for (let x = 0; x < sBig.size; x++) bigPts.push(await ev(`window.__escape.tilePoint(${x}, ${y})`));
const shotBig = await shot('escape-gate-5x5');
// clear it with clicks to prove the bigger board is not just drawn
for (let i = 0; i < 40; i++) {
  const st = await hook();
  if (!st.tappable.length) break;
  await clickTile(st.tappable[0]);
}
const sBigAfter = await hook();
T('5x5 clear ' + JSON.stringify({ size: sBig.size, left: sBigAfter.left }));

// ---- 6) out of lives
await ev('window.__escape.setup({level: 1, lives: 1})');
await sleep(200);
const s5 = await hook();
const blk = (() => {
  for (let y = 0; y < s5.size; y++) for (let x = 0; x < s5.size; x++) {
    if (s5.grid[y][x] && !s5.tappable.some(([tx, ty]) => tx === x && ty === y)) return [x, y];
  }
  return null;
})();
await clickTile(blk);
await sleep(300);
const s6 = await hook();
const loseSheet = await sheet();
const shotLose = await shot('escape-gate-lose');
T('lose ' + JSON.stringify({ over: s6.over, result: s6.result, lives: s6.lives, loseSheet }));

// ---- 7) new run from the sheet
await clickEl('overBtn');
await sleep(500);
const s7 = await hook();
const sheetAfter = await sheet();

// ---- 8) console errors on the desktop pass
const grabErrors = (limit = 4) => pageCdp.events
  .filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, limit).join(' | ');
const errors1 = grabErrors();

// ---- 9) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await waitFor("typeof window.__escape === 'function'");
const sT0 = await hook();
const tPts = [];
for (let y = 0; y < sT0.size; y++) for (let x = 0; x < sT0.size; x++) tPts.push(await ev(`window.__escape.tilePoint(${x}, ${y})`));
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
const tFree = sT0.tappable[0];
const tp = await ev(`window.__escape.tilePoint(${tFree[0]}, ${tFree[1]})`);
await tap({ x: Math.round(tp.x), y: Math.round(tp.y) });
const sT1 = await hook();
const shotTouch = await shot('escape-gate-touch');
// clear the portrait board too (real taps), then screenshot the next level
for (let i = 0; i < 40; i++) {
  const st = await hook();
  if (!st.tappable.length) break;
  const p = await ev(`window.__escape.tilePoint(${st.tappable[0][0]}, ${st.tappable[0][1]})`);
  await tap({ x: Math.round(p.x), y: Math.round(p.y) });
}
await sleep(1300);
const sT2 = await hook();
const shotTouchClear = await shot('escape-gate-touch-cleared');
const errors2 = grabErrors(3);

const onScreen = (p, w, h) => p && p.x > 6 && p.x < w - 6 && p.y > 6 && p.y < h - 6;
const checks = {
  boot: hookType === 'function' && s0.level === 1 && s0.size === 4 && s0.left === 16 && s0.lives === 3 && s0.tappable.length >= 1 && s0.over === false,
  framed: pts.every((p) => onScreen(p, 1280, 800)),
  freeEscapes: s1.left === s0.left - 1 && s1.taps === 1,
  blockedCosts: !!blocked && pBlocked && (pBlocked.x !== pFree.x || pBlocked.y !== pFree.y) && s2.lives === s1.lives - 1 && s2.left === s1.left && s2.blockedTaps === 1,
  boardCleared: sSolved.left === 0 && steps === s1.left && blockedDuringSolve === 0,
  nextLevel: sNext.level === 2 && sNext.size === 4 && sNext.left === 16 && sNext.lives === s2.lives && sNext.over === false,
  biggerBoard: sBig.size === 5 && sBig.left === 25 && bigPts.length === 25 && bigPts.every((p) => onScreen(p, 1280, 800)) && sBigAfter.left === 0,
  lost: s6.over === true && s6.result === 'lose' && s6.lives === 0 && loseSheet.open === true,
  restarted: s7.level === 1 && s7.lives === 3 && s7.left === 16 && s7.over === false && sheetAfter.open === false,
  portraitEscapes: sT1.left === sT0.left - 1 && sT1.lives === 3,
  portraitFramed: tPts.every((p) => onScreen(p, 390, 844)),
  portraitCleared: sT2.left === 16 && sT2.level === 2 && sT2.over === false,
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0: { level: s0.level, size: s0.size, left: s0.left, lives: s0.lives, tappable: s0.tappable.length },
  s1: { left: s1.left, taps: s1.taps }, firstFree, pFree,
  blocked, pBlocked, s2: { left: s2.left, lives: s2.lives, blockedTaps: s2.blockedTaps },
  steps, sSolved: { left: sSolved.left, blockedDuringSolve }, sNext: { level: sNext.level, left: sNext.left, lives: sNext.lives },
  sBig: { size: sBig.size, left: sBig.left }, sBigAfter: { left: sBigAfter.left },
  s6: { over: s6.over, result: s6.result, lives: s6.lives }, loseSheet,
  s7: { level: s7.level, lives: s7.lives, left: s7.left }, sheetAfter,
  sT0: { left: sT0.left }, sT1: { left: sT1.left, lives: sT1.lives }, sT2: { level: sT2.level, left: sT2.left },
  shots: [shotBoot, shotClear, shotBig, shotLose, shotTouch, shotTouchClear],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
