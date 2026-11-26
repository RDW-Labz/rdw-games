#!/usr/bin/env node
// Interaction gate for the Cube Run port (card "Cube-Run", F-Droid cube.run):
// real CDP mouse / keyboard / touch gestures on the shipped page, state-hook assertions for
// lane changes, the jump, the slide, the mid-air slam, a real wall clear, the crash, the
// circuit win, restart, plus a 390x844 portrait touch pass. A canvas that merely exists is
// not a pass: every check reads the page's own state hook before and after a real input.
//
// usage: node cube-run-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/cube-run/index.html';
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

const CMD = { timeout: 240000 };   // this box's CDP can take 60-100 s to answer under memory pressure
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD.timeout);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cuberun-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

const killAll = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('unhandledRejection', (e) => { T('FATAL ' + (e && e.message)); killAll(); process.exit(2); });
process.on('SIGTERM', () => { killAll(); process.exit(2); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 120000);
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
// Poll for the boot hook instead of a fixed sleep: a slow swiftshader boot is not a page bug.
let bootMs = 0;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if ((await ev('typeof window.__cuberun')) === 'function') break;
    await sleep(300);
  }
  bootMs = Date.now() - t0;
}
T('boot hook in ' + bootMs + 'ms');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(150);
};
const gesture = async (a, b) => {   // a real press-move-release: the port reads it as a swipe
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), button: 'left', buttons: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1, pointerType: 'mouse' });
  await sleep(40);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(150);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(260);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(140);
};
const st = () => ev('window.__cuberun()');
const poll = async (fn, ms = 5000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
// Act only when the QA row is about to arrive: a jump is 0.66 s of hang time, so leaping
// 18 m early lands the cube in time to be hit. Reading the row distance off the hook is the
// same information a visitor has on screen.
const near = async (m = 5, ms = 6000) => poll(async () => {
  const z = await ev('(()=>{const s=window.__cuberun();const g=s.groups[0];return g?Math.round((g.at-s.dist)*10)/10:null})()');
  return typeof z === 'number' && z <= m ? z : null;
}, ms, 60);
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

// ---- 1) boot: a function hook and a wall-clock pump that actually advances
const hookType = await ev('typeof window.__cuberun');
const s0 = await st();
await sleep(900);
const s1 = await st();
const shotBoot = await shot('cuberun-gate-boot');
T('boot ' + JSON.stringify({ hookType, dist0: s0 && s0.dist, dist1: s1 && s1.dist, groups: s1 && s1.groupCount, kinds: s1 && s1.groups && s1.groups.map((g) => g.kind) }));

// ---- 2) real clicks on the track: lane left, then right twice
const pL = await ev('window.__cuberun.lanePoint(0)');
await click(pL);
const sL = await st();
const pR = await ev('window.__cuberun.lanePoint(2)');
await click(pR);
await click(pR);
const sR = await st();
T('lanes ' + JSON.stringify({ pL, sL: sL && sL.lane, pR, sR: sR && sR.lane, inputs: sR && sR.inputs, dups: sR && sR.dups, taps: sR && sR.taps }));

// ---- 3) tap the middle for a jump, read the arc back out of the hook
const pJ = await ev('window.__cuberun.jumpPoint()');
await click(pJ);
const sAir = await poll(async () => { const s = await st(); return s && s.y > 0.3 ? s : null; }, 3000, 90);
const sLanded = await poll(async () => { const s = await st(); return s && s.y === 0 && s.jumps > 0 ? s : null; }, 4000, 120);
const shotJump = await shot('cuberun-gate-jump');
T('jump ' + JSON.stringify({ pJ, air: sAir && { y: sAir.y, jumps: sAir.jumps }, landed: sLanded && { y: sLanded.y } }));

// ---- 4) a real swipe up leaps a wall (QA row in the cube's own lane)
await ev('window.__cuberun.setup({dist: 150, lane: 1, spawn: [{kind: "wall", lane: 1, ahead: 20}]})');
await sleep(120);
const sWallPre = await st();
const zWall = await near(5);
const pSwipe = await ev('window.__cuberun.jumpPoint()');
await gesture({ x: pSwipe.x, y: Math.round(pSwipe.y + 60) }, { x: pSwipe.x, y: Math.round(pSwipe.y - 60) });
const sWallClear = await poll(async () => { const s = await st(); return s && (s.rows >= 1 || s.over) ? s : null; }, 5000, 120);
const shotWall = await shot('cuberun-gate-wall');
T('swipe-wall ' + JSON.stringify({ pre: sWallPre && sWallPre.rows, z: zWall, jumps: sWallClear && sWallClear.jumps, rows: sWallClear && sWallClear.rows, over: sWallClear && sWallClear.over, hits: sWallClear && sWallClear.hits }));

// ---- 5) a real swipe down slides under a bar
await ev('window.__cuberun.setup({dist: 260, lane: 1, spawn: [{kind: "bar", lane: 1, ahead: 20}]})');
await sleep(120);
const zBar = await near(4.5);
const pSw2 = await ev('window.__cuberun.slidePoint()');
await gesture({ x: pSw2.x, y: Math.round(pSw2.y - 60) }, { x: pSw2.x, y: Math.round(pSw2.y + 60) });
const sBar = await poll(async () => { const s = await st(); return s && (s.rows >= 1 || s.over) ? s : null; }, 5000, 120);
const shotBar = await shot('cuberun-gate-bar');
T('swipe-bar ' + JSON.stringify({ z: zBar, slides: sBar && sBar.slides, rows: sBar && sBar.rows, over: sBar && sBar.over, hits: sBar && sBar.hits }));

// ---- 6) the slam: jump, then swipe down in mid-air
await ev('window.__cuberun.setup({dist: 320, lane: 1})');
await sleep(120);
await keyTap('ArrowUp', 'ArrowUp', 38);
const sSlamAir = await poll(async () => { const s = await st(); return s && s.y > 0.6 ? s : null; }, 3000, 80);
const pSw3 = await ev('window.__cuberun.jumpPoint()');
await gesture({ x: pSw3.x, y: Math.round(pSw3.y - 60) }, { x: pSw3.x, y: Math.round(pSw3.y + 60) });
const sSlam = await poll(async () => { const s = await st(); return s && s.slams > 0 ? s : null; }, 3000, 100);
const sSlamLand = await poll(async () => { const s = await st(); return s && s.y === 0 ? s : null; }, 3000, 100);
T('slam ' + JSON.stringify({ air: sSlamAir && sSlamAir.y, slams: sSlam && sSlam.slams, landed: sSlamLand && { y: sSlamLand.y, slideT: sSlamLand.slideT } }));

// ---- 7) a keyboard slide (arrow down) under a bar
await ev('window.__cuberun.setup({dist: 400, lane: 2, spawn: [{kind: "bar", lane: 2, ahead: 20}]})');
await sleep(120);
const zKey = await near(4.5);
const zKey2 = await ev('(()=>{const s=window.__cuberun();const g=s.groups[0];return g?Math.round((g.at-s.dist)*10)/10:null})()');
await keyTap('ArrowDown', 'ArrowDown', 40);
const sKeySlide = await st();
const sKeyClear = await poll(async () => { const s = await st(); return s && (s.rows >= 1 || s.over) ? s : null; }, 5000, 120);
T('key-slide ' + JSON.stringify({ z: zKey, z2: zKey2, slides: sKeySlide && sKeySlide.slides, slideT: sKeySlide && sKeySlide.slideT, y: sKeySlide && sKeySlide.y, rows: sKeyClear && sKeyClear.rows, over: sKeyClear && sKeyClear.over, hits: sKeyClear && sKeyClear.hits, crash: sKeyClear && sKeyClear.crash }));

// ---- 8) the crash: a pillar in the cube's lane, no input → the run ends
await ev('window.__cuberun.setup({dist: 500, lane: 1, rows: 20, spawn: [{kind: "pillar", lane: 1, ahead: 9}]})');
await sleep(120);
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 6000, 140);
const shotLose = await shot('cuberun-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, crash: sLose && sLose.crash, title: sLose && sLose.title, sheet: sLose && sLose.sheet, best: sLose && sLose.best }));

// ---- 9) restart from the sheet's own button
await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ dist: sNew && sNew.dist, rows: sNew && sNew.rows, over: sNew && sNew.over, sheet: sNew && sNew.sheet }));

// ---- 10) the circuit win on the last row
await ev('window.__cuberun.setup({dist: 1900, lane: 1, rows: 89, spawn: [{kind: "wall", lane: 0, ahead: 10}]})');
await sleep(120);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 6000, 140);
const shotWin = await shot('cuberun-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, rows: sWin && sWin.rows, title: sWin && sWin.title, sheet: sWin && sWin.sheet }));
const contVisible = await ev('!document.getElementById("contBtn").classList.contains("hide")');

// ---- 11) keep running from the win sheet, then R restarts
await clickEl('contBtn');
await sleep(400);
const sCont = await st();
await keyTap('KeyR', 'r', 82);
await sleep(320);
const sRKey = await st();
T('continue+r ' + JSON.stringify({ cont: sCont && { over: sCont.over, rows: sCont.rows }, r: sRKey && { dist: sRKey.dist, over: sRKey.over, sheet: sRKey.sheet } }));

// ---- 12) a playable board for the tile art: walls, a bar and a pillar ahead
await ev('window.__cuberun.setup({dist: 640, lane: 1, rowsDef: [{ahead: 12, kind: "wall1", items: [{kind: "wall", lane: 0}]}, {ahead: 22, kind: "bar1", items: [{kind: "bar", lane: 2}]}, {ahead: 34, kind: "pillar2", items: [{kind: "pillar", lane: 0}, {kind: "pillar", lane: 1}]}]})');
await sleep(700);
const sBoard = await st();
const shotBoard = await shot('cuberun-gate-board');
T('board ' + JSON.stringify({ kinds: sBoard && sBoard.groups && sBoard.groups.map((g) => g.kind), lane: sBoard && sBoard.lane, over: sBoard && sBoard.over }));

const errors1 = consoleErrors();

// ---- 13) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
{
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if ((await ev('typeof window.__cuberun')) === 'function') break;
    await sleep(300);
  }
}
await sleep(500);
const tapAt = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
const t0 = await st();
const tpL = await ev('window.__cuberun.lanePoint(0)');
await tapAt(tpL);
const t1 = await st();
const tpJ = await ev('window.__cuberun.jumpPoint()');
await tapAt(tpJ);
const tAir = await poll(async () => { const s = await st(); return s && s.y > 0.3 ? s : null; }, 3000, 100);
const shotTouch = await shot('cuberun-gate-touch');
const lane0 = await ev('window.__cuberun.lanePoint(0)');
const lane2 = await ev('window.__cuberun.lanePoint(2)');
T('touch ' + JSON.stringify({ t0: t0 && t0.lane, t1: t1 && t1.lane, air: tAir && tAir.y, tpL, tpJ, lane0, lane2 }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.score === 0,
  clockRuns: !!s1 && s1.dist > s0.dist && s1.dist < 80,
  rowsSpawn: !!s1 && s1.groupCount > 1,
  laneLeft: !!sL && sL.lane === 0 && sL.inputs >= 1,
  laneRight: !!sR && sR.lane === 2 && sR.inputs >= 2,
  tapPointsSane: !!pL && pL.x < 1280 * 0.3 && pL.y > 0 && pL.y < 800 && !!pR && pR.x > 1280 * 0.7,
  jumped: !!sAir && sAir.jumps === 1 && sAir.y > 0.3,
  landed: !!sLanded && sLanded.y === 0,
  swipedOverWall: !!sWallClear && sWallClear.over === false && sWallClear.rows >= 1 && sWallClear.hits === 0 && sWallClear.jumps >= 1,
  swipedUnderBar: !!sBar && sBar.over === false && sBar.rows >= 1 && sBar.hits === 0 && sBar.slides >= 1,
  slammed: !!sSlam && sSlam.slams >= 1 && !!sSlamLand && sSlamLand.y === 0,
  keySlides: !!sKeySlide && sKeySlide.slides >= 1 && !!sKeyClear && sKeyClear.over === false && sKeyClear.rows >= 1 && sKeyClear.hits === 0,
  crashed: !!sLose && sLose.over === true && sLose.won === false && sLose.why === 'crash' &&
    !!sLose.crash && sLose.crash.kind === 'pillar' && sLose.sheet === true && /run ends/i.test(sLose.title),
  bestRecorded: !!sLose && sLose.best > 0,
  restarted: !!sNew && sNew.dist < 40 && sNew.rows === 0 && sNew.over === false && sNew.sheet === false,
  won: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'circuit' && sWin.sheet === true && /circuit complete/i.test(sWin.title),
  continueButton: contVisible === true && !!sCont && sCont.over === false,
  keyRestart: !!sRKey && sRKey.dist < 40 && sRKey.over === false && sRKey.sheet === false,
  boardLive: !!sBoard && sBoard.over === false && sBoard.groups.length >= 3,
  touchLane: !!t1 && t1.lane === 0 && t1.inputs >= 1,
  touchJump: !!tAir && tAir.y > 0.3,
  touchPointsOnScreen: !!tpL && tpL.x > 6 && tpL.x < 384 && tpL.y > 6 && tpL.y < 838 &&
    !!lane0 && lane0.x < 390 * 0.3 && !!lane2 && lane2.x > 390 * 0.7 && !!tpJ && tpJ.x > 100 && tpJ.x < 290,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({
  checks, failed, errors1, errors2, bootMs,
  s0: { dist: s0 && s0.dist, score: s0 && s0.score },
  s1: { dist: s1 && s1.dist, groups: s1 && s1.groupCount, kinds: s1 && s1.groups && s1.groups.map((g) => g.kind) },
  pL, pR, pJ,
  sAir: { y: sAir && sAir.y, jumps: sAir && sAir.jumps }, sLanded: { y: sLanded && sLanded.y },
  sWallClear: { rows: sWallClear && sWallClear.rows, jumps: sWallClear && sWallClear.jumps, hits: sWallClear && sWallClear.hits, over: sWallClear && sWallClear.over },
  sBar: { rows: sBar && sBar.rows, slides: sBar && sBar.slides, hits: sBar && sBar.hits, over: sBar && sBar.over },
  sSlam: { slams: sSlam && sSlam.slams }, sSlamLand: { y: sSlamLand && sSlamLand.y },
  sKeyClear: { rows: sKeyClear && sKeyClear.rows, hits: sKeyClear && sKeyClear.hits },
  sLose: { over: sLose && sLose.over, why: sLose && sLose.why, crash: sLose && sLose.crash, title: sLose && sLose.title, best: sLose && sLose.best },
  sNew: { dist: sNew && sNew.dist, rows: sNew && sNew.rows },
  sWin: { over: sWin && sWin.over, won: sWin && sWin.won, rows: sWin && sWin.rows, title: sWin && sWin.title, sheet: sWin && sWin.sheet },
  sCont: { over: sCont && sCont.over, rows: sCont && sCont.rows }, sRKey: { dist: sRKey && sRKey.dist, over: sRKey && sRKey.over },
  sBoard: { kinds: sBoard && sBoard.groups && sBoard.groups.map((g) => g.kind) },
  t0: t0 && { lane: t0.lane, dist: t0.dist }, t1: t1 && { lane: t1.lane, inputs: t1.inputs }, tAir: tAir && { y: tAir.y },
  tpL, tpJ, lane0, lane2,
  shots: [shotBoot, shotJump, shotWall, shotBar, shotLose, shotWin, shotBoard, shotTouch],
}, null, 0));
console.log(failed.length ? 'GATE FAIL' : 'GATE PASS');
killAll(); server.close();
process.exit(failed.length ? 1 : 0);
