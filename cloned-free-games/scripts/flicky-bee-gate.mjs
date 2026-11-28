#!/usr/bin/env node
// Interaction gate for the Flicky Bee port (card "Flicky Bee", F-Droid org.lettucepie.flickybee):
// real CDP mouse / keyboard / touch input on the shipped page, state-hook assertions for the
// flick, the nectar refill, the honey payout, the spent-flower rule, the wasp sting, the tired
// ending, the hive win, restart, and a 390x844 portrait touch pass. A canvas that merely exists
// is not a pass: every check reads the page's own state hook before and after a real input.
//
// usage: node flicky-bee-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/flicky-bee/index.html';
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
const PROFILE = mkdtempSync('/tmp/flicky-gate-');
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
await CDP.attach(endpoint);
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
  while (Date.now() - t0 < 120000) {
    if ((await ev('typeof window.__flicky')) === 'function') break;
    await sleep(300);
  }
  bootMs = Date.now() - t0;
}
T('boot hook in ' + bootMs + 'ms');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(300);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, autoRepeat: false });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(220);
};
const st = () => ev('window.__flicky()');
const poll = async (fn, ms = 6000, step = 120) => {
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

// ---- 1) boot: a function hook, a fresh meadow, and a clock that actually drains buzz
const hookType = await ev('typeof window.__flicky');
const s0 = await st();
await sleep(1200);
const s1 = await st();
const shotBoot = await shot('flicky-gate-boot');
T('boot ' + JSON.stringify({ hookType, idx: s0 && s0.idx, stam0: s0 && s0.stamina, stam1: s1 && s1.stamina, course: s1 && s1.course.length, wasps: s1 && s1.wasps.length }));

// ---- 2) a real click on the first flower: the bee flicks, nectar refills, honey is paid
await ev('window.__flicky.setup({flower: 0, stamina: 50, honey: 0, wasps: "none"})');
await sleep(200);
const pre = await st();
const firstTargets = pre && pre.targets ? pre.targets.slice() : [];
const p1 = await ev(`window.__flicky.point(${firstTargets[0]})`);
await click(p1);
const mid = await poll(async () => { const s = await st(); return s && (s.inFlight || s.idx === firstTargets[0]) ? s : null; }, 4000, 40);
const shotAir = await shot('flicky-gate-flight');
const land1 = await poll(async () => { const s = await st(); return s && s.idx === firstTargets[0] ? s : null; }, 6000, 100);
T('flick ' + JSON.stringify({ p1, pre: { idx: pre && pre.idx, stam: pre && pre.stamina, honey: pre && pre.honey }, mid: mid && { inFlight: mid.inFlight, y: mid.y }, land: land1 && { idx: land1.idx, stam: land1.stamina, honey: land1.honey, mult: land1.mult, flights: land1.flights } }));

// ---- 3) a spent bloom and a sibling are never targets again
const flightsBefore = (await st()).flights;
const p0 = await ev('window.__flicky.point(0)');
await click(p0);
await sleep(500);
const sSpent = await st();
T('spent ' + JSON.stringify({ flightsBefore, flights: sSpent.flights, idx: sSpent.idx, targets: sSpent.targets }));

// ---- 4) the wasp: a guard sat on the next bloom stings and knocks the bee back
await ev('window.__flicky.setup({flower: 6, stamina: 90, honey: 200, wasps: "none"})');
await ev('window.__flicky.setup({guard: {at: 8, r: 0}})');
await sleep(200);
const preSting = await st();
const p3 = await ev('window.__flicky.point(8)');
await click(p3);
const stung = await poll(async () => { const s = await st(); return s && s.stings > 0 ? s : null; }, 6000, 100);
const shotSting = await shot('flicky-gate-sting');
T('sting ' + JSON.stringify({ pre: { idx: preSting.idx, stam: preSting.stamina, honey: preSting.honey }, after: stung && { idx: stung.idx, stam: stung.stamina, honey: stung.honey, stings: stung.stings, mult: stung.mult, wasps: stung.wasps.length } }));

// ---- 5) the tired ending: buzz runs out on a flower, the hive sheet opens
await ev('window.__flicky.setup({flower: 0, stamina: 1.2, honey: 40, wasps: "none"})');
const tired = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 8000, 120);
const shotTired = await shot('flicky-gate-tired');
T('tired ' + JSON.stringify({ over: tired && tired.over, won: tired && tired.won, why: tired && tired.why, title: tired && tired.title, sheet: tired && tired.sheet, best: tired && tired.best }));

// ---- 6) restart from the sheet's own button
await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ idx: sNew.idx, stam: sNew.stamina, honey: sNew.honey, over: sNew.over, sheet: sNew.sheet, wasps: sNew.wasps.length }));

// ---- 7) the win: one flick from the last flower into the hive
await ev('window.__flicky.setup({flower: 23, stamina: 100, honey: 500, wasps: "none"})');
await sleep(200);
const pHive = await ev('window.__flicky.point(24)');
await click(pHive);
const wonS = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 7000, 100);
const shotWin = await shot('flicky-gate-win');
T('win ' + JSON.stringify({ pHive, over: wonS && wonS.over, won: wonS && wonS.won, why: wonS && wonS.why, honey: wonS && wonS.honey, title: wonS && wonS.title, sheet: wonS && wonS.sheet, idx: wonS && wonS.idx }));

// ---- 8) keyboard: arrows pick, space flies, R restarts
await ev('window.__flicky.setup({flower: 0, stamina: 100, honey: 0, wasps: "none"})');
await sleep(150);
const kAim0 = (await st()).aim;
await keyTap('ArrowRight', 'ArrowRight', 39);
const kAim1 = (await st()).aim;
await keyTap('Space', ' ', 32);
const kFly = await poll(async () => { const s = await st(); return s && s.idx > 0 ? s : null; }, 6000, 100);
await keyTap('KeyR', 'r', 82);
await sleep(400);
const kReset = await st();
T('keys ' + JSON.stringify({ aim0: kAim0, aim1: kAim1, idx: kFly && kFly.idx, honey: kFly && kFly.honey, afterR: { idx: kReset.idx, over: kReset.over, sheet: kReset.sheet } }));

// ---- 9) a playable board for the tile art: mid-meadow, wasps out, a flight under way
await ev('window.__flicky.setup({flower: 9, stamina: 84, honey: 640, wasps: 1})');
await sleep(950);
const sBoard = await st();
const shotBoard = await shot('flicky-gate-board');
T('board ' + JSON.stringify({ idx: sBoard.idx, stamina: sBoard.stamina, wasps: sBoard.wasps.length, over: sBoard.over }));

const errors1 = consoleErrors();

// ---- 10) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
{
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if ((await ev('typeof window.__flicky')) === 'function') break;
    await sleep(300);
  }
}
await sleep(600);
const tapAt = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
const t0s = await st();
const tTargets = (t0s && t0s.targets) || [];
const tp1 = await ev(`window.__flicky.point(${tTargets[0]})`);
await tapAt(tp1);
const t1s = await poll(async () => { const s = await st(); return s && s.idx === tTargets[0] ? s : null; }, 6000, 100);
const shotTouch = await shot('flicky-gate-touch');
T('touch ' + JSON.stringify({ tp1, t0: t0s && { idx: t0s.idx, stam: t0s.stamina }, last: (await st()).lastPointer, t1: t1s && { idx: t1s.idx, honey: t1s.honey } }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const onScreen = (p, w, h) => !!p && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.idx === 0 && s0.honey === 0,
  freshMeadow: !!s1 && s1.course.length === 25 && s1.course[24].hive === true && s1.course.filter((f) => f.d === 0).length === 2 && s1.visited.every((v) => v === false),
  clockDrains: !!s1 && s1.stamina < s0.stamina,
  waspsLive: !!s1 && s1.wasps.length >= 3,
  twoChoicesOffered: !!s0 && Array.isArray(s0.targets) && s0.targets.length === 2 && s0.targets.every((i) => s0.course[i].d === 1),
  firstPointOnScreen: onScreen(p1, 1280, 800),
  clickedFlew: !!mid && (mid.inFlight === true || mid.idx === firstTargets[0]),
  landed: !!land1 && land1.idx === firstTargets[0] && land1.visited[firstTargets[0]] === true && land1.depth === 1,
  nectarRefilled: !!land1 && land1.stamina > 50,
  honeyPaid: !!land1 && land1.honey >= 13,
  flightCounted: !!land1 && land1.flights === 1,
  spentFlowerRefused: !!sSpent && sSpent.idx !== 0 && !sSpent.targets.includes(0) && !sSpent.targets.includes(1) && !sSpent.targets.includes(firstTargets[0]) && sSpent.targets.every((i) => sSpent.course[i].d === 2),
  stung: !!stung && stung.stings >= 1 && stung.idx === 6 && stung.honey < 200 && stung.stamina < 90,
  tired: !!tired && tired.over === true && tired.won === false && tired.why === 'tired' && tired.sheet === true && /hive/i.test(tired.title || ''),
  bestRecorded: !!tired && tired.best >= 0,
  restarted: !!sNew && sNew.idx === 0 && sNew.over === false && sNew.sheet === false && sNew.stamina >= 96,
  won: !!wonS && wonS.over === true && wonS.won === true && wonS.why === 'hive' && wonS.sheet === true && /home to the hive/i.test(wonS.title || '') && wonS.idx === 24,
  arrowPicks: typeof kAim0 === 'number' && kAim1 !== kAim0 && kAim1 >= 0,
  spaceFlies: !!kFly && kFly.idx > 0,
  rRestarts: !!kReset && kReset.idx === 0 && kReset.over === false && kReset.sheet === false,
  boardLive: !!sBoard && sBoard.over === false && sBoard.wasps.length >= 1 && sBoard.idx === 9,
  touchFlower: !!t1s && t1s.idx === tTargets[0] && t1s.honey >= 13,
  touchPointOnScreen: onScreen(tp1, 390, 844),
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({
  checks, failed, errors1, errors2, bootMs,
  s0: { idx: s0 && s0.idx, stamina: s0 && s0.stamina, honey: s0 && s0.honey },
  s1: { stamina: s1 && s1.stamina, wasps: s1 && s1.wasps.length, course: s1 && s1.course.length },
  p1, mid: mid && { inFlight: mid.inFlight, y: Math.round(mid.y * 100) / 100 },
  land1: land1 && { idx: land1.idx, stamina: land1.stamina, honey: land1.honey, mult: land1.mult },
  sSpent: sSpent && { idx: sSpent.idx, flights: sSpent.flights, targets: sSpent.targets },
  stung: stung && { idx: stung.idx, stamina: stung.stamina, honey: stung.honey, stings: stung.stings },
  tired: tired && { over: tired.over, why: tired.why, title: tired.title, best: tired.best },
  sNew: sNew && { idx: sNew.idx, stamina: sNew.stamina, over: sNew.over },
  wonS: wonS && { won: wonS.won, why: wonS.why, honey: wonS.honey, title: wonS.title },
  kAim0, kAim1, kFly: kFly && { idx: kFly.idx },
  t1s: t1s && { idx: t1s.idx, honey: t1s.honey },
  shots: [shotBoot, shotAir, shotSting, shotTired, shotWin, shotBoard, shotTouch],
}, null, 0));
console.log(failed.length ? 'GATE FAIL' : 'GATE PASS');
killAll(); server.close();
process.exit(failed.length ? 1 : 0);
