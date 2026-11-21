#!/usr/bin/env node
// Interaction gate for the Clavierhaus Backgammon port: real CDP mouse + touch on the shipped page,
// state-hook assertions for lifting a checker, moving it, entering from the bar, hitting a blot,
// bearing off to win, the CPU taking its turn, restart, and a 390x844 portrait pass (the board
// rotates to a tall layout there).
//
// usage: node backgammon-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/backgammon/index.html';
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
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/bg-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
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
await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(400);
  return b;
};
const st = () => ev('window.__bg()');
const poll = async (fn, ms = 5000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const consoleErrors = () => pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 1) boot
const hookType = await ev('typeof window.__bg');
const b0 = await st();
const shotBoot = await shot('bg-gate-boot');
T('boot ' + JSON.stringify({ hookType, turn: b0 && b0.turn, pipW: b0 && b0.pipW, pipB: b0 && b0.pipB, dice: b0 && b0.dice, legal: b0 && b0.legal, rot: b0 && b0.rot }));

// a board with 30 checkers on it
const tally = (b) => {
  if (!b) return null;
  let w = b.offW + b.barW, bl = b.offB + b.barB;
  for (const v of b.pts) { if (v > 0) w += v; else bl -= v; }
  return { w, b: bl };
};
const t0c = tally(b0);

// ---- 2) lift one of your own checkers, then move it onto a gold destination
const src = (b0 && b0.legal) ? await ev('JSON.stringify(window.__bg.legal()[0])') : null;
const mv0 = src ? JSON.parse(src) : null;
let selState = null, movedState = null;
if (mv0 && mv0.from >= 0) {
  const pS = await ev(`window.__bg.pointPoint(${mv0.from})`);
  await click(pS);
  selState = await st();
  const pD = await ev(`window.__bg.pointPoint(${mv0.to})`);
  await click(pD);
  await sleep(400);
  movedState = await st();
  T('move ' + JSON.stringify({ mv0, pS, pD, sel: selState && selState.sel, inputs: movedState && movedState.inputs, moves: movedState && movedState.moves, pipW: movedState && movedState.pipW }));
} else {
  T('move SKIPPED: no opening move ' + src);
}

// ---- 3) a checker on the bar must re-enter (and the tap on the bar is a real one)
await ev('window.__bg.setup({ pts: [0,0,0,0,0,0,0,0,0,0,0,-5,5,0,0,0,0,0,0,0,0,0,2,0], bar: { w: 1, b: 0 }, off: { w: 0, b: 0 }, dice: [2] })');
await sleep(300);
const barPre = await st();
const pBar = await ev('window.__bg.barPoint()');
await click(pBar);
const barSel = await st();
const pEnter = await ev('window.__bg.pointPoint(1)');
await click(pEnter);
await sleep(300);
const barPost = await st();
T('bar ' + JSON.stringify({ pBar, preBar: barPre && barPre.barW, sel: barSel && barSel.sel, pEnter, postBar: barPost && barPost.barW, pts1: barPost && barPost.pts[1] }));

// ---- 4) hitting a blot sends it to the bar
const hitSetup = await ev('window.__bg.setup({ pts: [0,0,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0], bar: { w: 0, b: 0 }, off: { w: 0, b: 0 }, dice: [3,5] })');
await sleep(300);
const hitPts = await ev('({at10: window.__bg().pts[10], at7: window.__bg().pts[7], barB: window.__bg().barB, legal: JSON.stringify(window.__bg.legal())})');
await click(await ev('window.__bg.pointPoint(10)'));
const hitSel = await st();
await click(await ev('window.__bg.pointPoint(7)'));
await sleep(300);
const hitState = await st();
T('hit ' + JSON.stringify({ hitSetup, hitPts, sel: hitSel && hitSel.sel, barB: hitState && hitState.barB, p7: hitState && hitState.pts[7], p10: hitState && hitState.pts[10], inputs: hitState && hitState.inputs }));

// ---- 5) bearing off the last checker wins, and the sheet says so
await ev('window.__bg.setup({ pts: [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], bar: { w: 0, b: 0 }, off: { w: 14, b: 0 }, dice: [1] })');
await sleep(300);
await click(await ev('window.__bg.pointPoint(0)'));
await click(await ev('window.__bg.offPoint("w")'));
const winState = await poll(async () => { const s = await st(); return s && s.phase === 'over' ? s : null; }, 5000, 120);
const shotWin = await shot('bg-gate-win');
T('win ' + JSON.stringify({ offW: winState && winState.offW, phase: winState && winState.phase, winner: winState && winState.winner, sheet: winState && winState.sheet, title: winState && winState.title, shot: shotWin }));

// ---- 6) restart from the sheet's own button
const rBtn = await clickEl('overBtn');
await sleep(500);
const restarted = await st();
T('restart ' + JSON.stringify({ btn: rBtn, phase: restarted && restarted.phase, pipW: restarted && restarted.pipW, offW: restarted && restarted.offW, sheet: restarted && restarted.sheet }));

// ---- 7) the CPU takes its turn by itself
await ev('window.__bg.setup({ pts: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-1,0,0,0,0,2,0], bar: { w: 0, b: 0 }, off: { w: 0, b: 5 }, turn: "b", dice: [3,2] })');
await sleep(200);
const cpuPre = await st();
const cpuPost = await poll(async () => { const s = await st(); return s && s.turn === 'w' ? s : null; }, 9000, 200);
T('cpu ' + JSON.stringify({ preTurn: cpuPre && cpuPre.turn, prePipB: cpuPre && cpuPre.pipB, postTurn: cpuPost && cpuPost.turn, postPipB: cpuPost && cpuPost.pipB, turnNo: cpuPost && cpuPost.turnNo }));

// ---- 8) a mid-game board for the tile art
await ev('window.__bg.setup({ pts: [2,-1,0,0,0,0,-3,2,0,0,3,-4,5,-2,0,0,0,2,-3,0,0,1,3,0], bar: { w: 0, b: 1 }, off: { w: 2, b: 3 }, turn: "w", dice: [4,6] })');
await sleep(600);
const boardState = await st();
const shotBoard = await shot('bg-gate-board');
T('board ' + JSON.stringify({ pipW: boardState && boardState.pipW, pipB: boardState && boardState.pipB, offW: boardState && boardState.offW, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 9) portrait touch: the board rotates tall, a finger lifts and moves a checker
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
const touchTap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
const p0 = await st();
const legal0 = JSON.parse(await ev('JSON.stringify(window.__bg.legal())') || '[]');
const pmv = legal0.find((m) => m.from >= 0);
let pSel = null, pMoved = null, pPts = null;
if (pmv) {
  pPts = { s: await ev(`window.__bg.pointPoint(${pmv.from})`), d: await ev(`window.__bg.pointPoint(${pmv.to})`) };
  await touchTap(pPts.s);
  pSel = await st();
  await touchTap(pPts.d);
  await sleep(400);
  pMoved = await st();
}
const offScreen = [pPts && pPts.s, pPts && pPts.d].filter((p) => !p || p.x < 2 || p.x > 388 || p.y < 2 || p.y > 842).length;
await ev('window.__bg.setup({ pts: [0,0,0,0,0,0,0,0,0,0,0,-5,5,0,0,0,0,0,0,0,0,0,2,0], bar: { w: 0, b: 0 }, off: { w: 0, b: 0 }, turn: "w", dice: [3,1] })');
await sleep(400);
const shotTouch = await shot('bg-gate-touch');
T('touch ' + JSON.stringify({ rot: p0 && p0.rot, pmv, pSel: pSel && pSel.sel, inputs: pMoved && pMoved.inputs, moves: pMoved && pMoved.moves, offScreen, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function',
  openingBoard: !!b0 && b0.turn === 'w' && b0.pipW === 167 && b0.pipB === 167 && (b0.dice.length === 2 || b0.dice.length === 4) && b0.dice.every((d) => d >= 1 && d <= 6) && b0.offW === 0 && b0.offB === 0,
  thirtyCheckers: !!t0c && t0c.w === 15 && t0c.b === 15,
  landscapeBoard: !!b0 && b0.rot === 0,
  liftWorks: !!selState && selState.sel === mv0.from && !!movedState && movedState.moves >= 1 && movedState.inputs >= 2,
  moveLowersPips: !!movedState && movedState.pipW < b0.pipW,
  barEntryWorks: !!barPost && barPost.barW === 0 && barPost.pts[1] > 0 && !!barSel && barSel.sel === -1,
  hitWorks: !!hitState && hitState.barB === 1 && hitState.pts[7] === 1,
  bearOffWins: !!winState && winState.phase === 'over' && winState.winner === 'w' && winState.offW === 15 && winState.sheet === true && /you win/i.test(winState.title),
  restartWorks: !!restarted && restarted.phase === 'move' && restarted.pipW === 167 && restarted.sheet === false,
  cpuMoves: !!cpuPost && cpuPost.turn === 'w' && (cpuPost.pipB < cpuPre.pipB || cpuPost.offB > cpuPre.offB),
  boardLive: !!boardState && boardState.phase === 'move' && boardState.turn === 'w',
  portraitRotated: !!p0 && Math.abs(p0.rot + 1.57) < 0.05,
  touchLiftsAndMoves: !!pmv && !!pMoved && pMoved.moves >= 1 && pMoved.inputs >= 2,
  touchOnScreen: offScreen === 0,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, b0, t0c, mv0, sel: selState && selState.sel, moved: movedState && { inputs: movedState.inputs, moves: movedState.moves, pipW: movedState.pipW }, bar: { pre: barPre && barPre.barW, sel: barSel && barSel.sel, post: barPost && barPost.barW }, hit: hitState && { barB: hitState.barB, p7: hitState.pts[7] }, win: winState && { phase: winState.phase, winner: winState.winner, offW: winState.offW, title: winState.title }, restarted: restarted && { phase: restarted.phase, pipW: restarted.pipW }, cpu: { pre: cpuPre && cpuPre.pipB, post: cpuPost && cpuPost.pipB, turn: cpuPost && cpuPost.turn }, shots: { boot: shotBoot, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(failed.length ? 1 : 0);
