#!/usr/bin/env node
// Interaction gate for the Pipes (water flow) port: real CDP mouse clicks on the board,
// state-hook assertions for turn / water / win / out-of-turns / undo / restart / next level,
// plus portrait touch. usage: node pipes-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/pipes-water-flow-puzzle/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/pipes-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-30));
const server = await serve();
const port = server.address().port;
T('serving ' + port);
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('no page target');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const point = (c, r) => ev(`window.__pipes.tilePoint(${c},${r})`);
const tapCell = async (c, r, n = 1) => {
  const p = await point(c, r);
  if (!p || p.__err) return { p, err: p.__err };
  for (let i = 0; i < n; i++) { await click(p); await sleep(120); }
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// Play a level the honest way: for each cell, click it exactly as many quarter-turns as the
// page's own plan says it still needs, on its reported screen point.
const solveLevel = async () => {
  const plan = await ev('window.__pipes.plan()');
  const rot = await ev('window.__pipes.rot()');
  const st0 = await ev('window.__pipes()');
  let clicks = 0;
  for (let r = 0; r < rot.length; r++) {
    for (let c = 0; c < rot[r].length; c++) {
      const n = plan[r * rot[r].length + c];
      if (!n) continue;
      const p = await point(c, r);
      if (!p || p.__err) return { err: 'no point ' + r + ',' + c, clicks };
      for (let k = 0; k < n; k++) { await click(p); await sleep(110); clicks++; }
    }
  }
  await sleep(400);
  return { clicks, st0 };
};

// ---- 1) boot
const hookType = await ev('typeof window.__pipes');
const s0 = await ev('window.__pipes()');
const corners = [await point(0, 0), await point(s0.size.w - 1, s0.size.h - 1)];
const shotBoot = await shot('pipes-gate-boot');
T('boot ' + JSON.stringify(s0));

// ---- 2) one real click turns a pipe and moves the water
const plan0 = await ev('window.__pipes.plan()');
let firstCell = null;
for (let r = 0; r < s0.size.h && !firstCell; r++) {
  for (let c = 0; c < s0.size.w && !firstCell; c++) {
    const rot = await ev(`window.__pipes.rot()[${r}]`);
    if (rot && rot[c] && rot[c] !== 'X') firstCell = [c, r];
  }
}
const rotBefore = await ev('window.__pipes.rot()');
await tapCell(firstCell[0], firstCell[1], 1);
const rotAfter = await ev('window.__pipes.rot()');
const s1 = await ev('window.__pipes()');
const shotOne = null;
T('one click ' + JSON.stringify({ steps: s1.steps, left: s1.left }));

// ---- 3) undo puts that turn back
await clickEl('undo');
const rotUndo = await ev('window.__pipes.rot()');
const sUndo = await ev('window.__pipes()');

// ---- 4) solve level 1 through the board
const solve1 = await solveLevel();
const sWin = await ev('window.__pipes()');
const winSheet = await sheet();
const shotWin = await shot('pipes-gate-win');
T('win ' + JSON.stringify({ clicks: solve1.clicks, won: sWin.won, wet: sWin.wetOutlets }));

// ---- 5) next level from the sheet
await clickEl('overNext');
await sleep(500);
const sLvl2 = await ev('window.__pipes()');
const shotMid = await shot('pipes-gate-level2');

// ---- 6) solve level 2 as well (three drains)
const solve2 = await solveLevel();
const sWin2 = await ev('window.__pipes()');
const winSheet2 = await sheet();
T('win2 ' + JSON.stringify({ clicks: solve2.clicks, won: sWin2.won, wet: sWin2.wetOutlets, outlets: sWin2.outlets }));

// ---- 7) out of turns: a tiny budget, then one wrong turn too many
await ev('window.__pipes.setup(0, 2)');
await sleep(300);
const sQa = await ev('window.__pipes()');
const wrong = firstCell;
await tapCell(wrong[0], wrong[1], 3);
await sleep(400);
const sLose = await ev('window.__pipes()');
const loseSheet = await sheet();
const shotLose = null;
T('lose ' + JSON.stringify({ over: sLose.over, won: sLose.won, left: sLose.left, title: loseSheet.title }));

// ---- 8) play again from the sheet, then R
await clickEl('overRetry');
await sleep(500);
const sRetry = await ev('window.__pipes()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sR = await ev('window.__pipes()');

const errors1 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 9) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
};
const sP = await ev('window.__pipes()');
const pEdge = [await point(0, 0), await point(sP.size.w - 1, sP.size.h - 1)];
const rotP0 = await ev('window.__pipes.rot()');
const pTouch = await point(2, 1);
await tap(pTouch);
await tap(pTouch);
const rotP1 = await ev('window.__pipes.rot()');
const sTouch = await ev('window.__pipes()');
const shotTouch = await shot('pipes-gate-touch');
const errors2 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');
T('touch ' + JSON.stringify({ steps: sTouch.steps }));

const checks = {
  boot: hookType === 'function' && s0 && s0.level === 0 && s0.won === false && s0.over === false && s0.steps === 0 && s0.open >= 6 && s0.left > 0,
  framed: corners.every((p) => p && p.x > 4 && p.x < 1276 && p.y > 4 && p.y < 796),
  firstTapTurns: s1.steps === 1 && rotAfter.some((row, i) => row !== rotBefore[i]),
  firstTapDecides: s1.left === s0.left - 1,
  undoRestores: JSON.stringify(rotUndo) === JSON.stringify(rotBefore) && sUndo.steps === 0 && sUndo.left === s0.left,
  won: sWin.won === true && sWin.wetOutlets === sWin.outlets && winSheet.open === true && /running/i.test(winSheet.title),
  usedTheBoard: solve1.clicks >= 6,
  nextLevel: sLvl2.level === 1 && sLvl2.won === false && sLvl2.steps === 0 && sLvl2.over === false,
  won2: sWin2.won === true && sWin2.wetOutlets === sWin2.outlets && sWin2.outlets === 3 && winSheet2.open === true,
  qaBudget: sQa.left === 2 && sQa.won === false,
  outOfTurns: sLose.over === true && sLose.won === false && sLose.left === 0 && loseSheet.open === true && /out of turns/i.test(loseSheet.title),
  retried: sRetry.level === 0 && sRetry.steps === 0 && sRetry.won === false && sRetry.over === false && sRetry.left === s0.left,
  keyRestart: sR.steps === 0 && sR.won === false && sR.over === false,
  portraitFramed: pEdge.every((p) => p && p.x > 2 && p.x < 388 && p.y > 2 && p.y < 842),
  touchTurns: sTouch.steps === 2 && rotP1.some((row, i) => row !== rotP0[i]),
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0, s1: { steps: s1.steps, left: s1.left, wet: s1.wet },
  sUndo: { steps: sUndo.steps, left: sUndo.left },
  sWin: { won: sWin.won, wetOutlets: sWin.wetOutlets, outlets: sWin.outlets, steps: sWin.steps }, winSheet,
  sLvl2: { level: sLvl2.level, open: sLvl2.open, left: sLvl2.left },
  sWin2: { won: sWin2.won, wetOutlets: sWin2.wetOutlets, outlets: sWin2.outlets }, winSheet2, solve1, solve2,
  sQa: { left: sQa.left }, sLose: { over: sLose.over, won: sLose.won, left: sLose.left, wetOutlets: sLose.wetOutlets }, loseSheet,
  sRetry: { level: sRetry.level, steps: sRetry.steps, left: sRetry.left }, sR: { steps: sR.steps },
  sTouch: { steps: sTouch.steps, level: sTouch.level }, pEdge, pTouch,
  shots: [shotBoot, shotOne, shotWin, shotMid, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
