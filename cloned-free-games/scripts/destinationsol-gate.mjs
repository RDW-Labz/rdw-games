#!/usr/bin/env node
// Interaction gate for the Destination Sol port (F-Droid card com.miloshpetrov.sol2.android):
// real CDP mouse / keyboard / touch on the SHIPPED page, with every assertion read back from the
// page's own state hook. A canvas that merely exists is not a pass — the belt has to change state.
//
// usage: node destinationsol-gate.mjs [site-root]      (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
let PHASE = 'start';
const WATCH = setTimeout(() => { T('WATCHDOG stalled in phase: ' + PHASE); process.exit(3); }, 1500000);
WATCH.unref?.();
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/destination-sol/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) { T('  TIMEOUT ' + method); bad(new Error('timeout ' + method)); } }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/destsol-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const killAll = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { killAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { T('unhandled ' + e); killAll(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 180000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S2 = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
await S2('Runtime.enable'); await S2('Page.enable'); await S2('Log.enable');
await S2('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S2('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S2('Page.navigate', { url });

const click = async (pt) => {
  await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
// hold the button down on a point for `ms` — the port's only "thrust and fire" gesture
const holdAt = async (pt, ms) => {
  await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(ms);
  await S2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
// hold the button down while re-aiming at a moving target — that is what a player's finger does
const holdAim = async (expr, ms) => {
  const p0 = await ev(expr);
  if (!p0 || p0.__err) return false;
  await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x, y: p0.y, button: 'none', pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  const t0 = Date.now();
  let last = p0;
  while (Date.now() - t0 < ms) {
    await sleep(120);
    const p = await ev(expr);
    if (!p || p.__err) continue;
    last = p;
    await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', pointerType: 'mouse', buttons: 1 });
  }
  await S2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return true;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return null;
  await click(b);
  await sleep(450);
  return b;
};
const keyHold = async (code, key, vk, ms) => {
  await S2('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await sleep(ms);
  await S2('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(180);
};
const st = () => ev('window.__destsol()');
const poll = async (fn, ms = 20000, step = 160) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const shot = async (name) => {
  const s = await S2('Page.captureScreenshot', { format: 'png' });
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

// ---- 1) boot: hook live, belt full, clock running, nothing dies on frame one
PHASE = 'boot';
const ready = await poll(async () => ((await ev('typeof window.__destsol')) === 'function' ? true : null), 90000, 400);
const hookType = await ev('typeof window.__destsol');
const s0 = await st();
const sDealt = await poll(async () => { const s = await st(); return s && s.pirates >= 1 ? s : null; }, 30000, 200) || await st();
await sleep(700);
const s1 = await st();
const shotBoot = await shot('destsol-gate-boot');
T('boot ' + JSON.stringify({ ready, hookType, t0: s0 && s0.t, t1: s1 && s1.t, rocks: s0 && s0.rocks, pirates: sDealt && sDealt.pirates, hull: s0 && s0.hull, credits: s0 && s0.credits, field: s1 && s1.field }));
T('bootShot ' + shotBoot);

// ---- 2) a real pointer press flies the ship at the finger
PHASE = 'steer';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 } })');
await sleep(200);
const pA = await ev('window.__destsol.pointAt(0, -3.4)');
await holdAt(pA, 900);
const sA = await poll(async () => { const s = await st(); return s && s.z < -1.2 ? s : null; }, 16000) || await st();
const pB = await ev('window.__destsol.pointAt(0, 3.4)');
await holdAt(pB, 2600);
const sB = await poll(async () => { const s = await st(); return s && s.z > 1.2 ? s : null; }, 20000) || await st();
T('steer ' + JSON.stringify({ pA, zA: sA && sA.z, pB, zB: sB && sB.z }));

// ---- 3) keyboard: throttle and yaw
PHASE = 'keys';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 } })');
await sleep(220);
const k0 = await st();
await keyHold('ArrowUp', 'ArrowUp', 38, 700);
const k1 = await st();
await keyHold('ArrowLeft', 'ArrowLeft', 37, 400);
const k2 = await st();
T('keys ' + JSON.stringify({ s0: k0 && k0.speed, s1: k1 && k1.speed, x1: k1 && k1.x, a1: k1 && k1.a, a2: k2 && k2.a }));

// ---- 4) the gun cuts rock, and the rock pays in ore
PHASE = 'mine';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: -4.1, z: 3.2, a: -Math.PI/2 }, rocks: [{ kind: "iron", x: -4.1, z: -1.0 }] })');
await sleep(220);
const preMine = await st();
const rockPt = await ev('window.__destsol.rockPoint(0)');
await holdAt(rockPt, 1500);
const sMine = await poll(async () => { const s = await st(); return s && (s.mined >= 1 || s.ore > 0) ? s : null; }, 20000) || await st();
const shotMine = await shot('destsol-gate-mine');
T('mine ' + JSON.stringify({ rockPt, preHp: preMine && preMine.rockList[0] && preMine.rockList[0].hp, mined: sMine && sMine.mined, ore: sMine && sMine.ore, shots: sMine && sMine.shots, hull: sMine && sMine.hull, credits: sMine && sMine.credits, shot: shotMine }));

// ---- 5) the ore chunks fly into the hold
PHASE = 'pickup';
const sPick = await poll(async () => { const s = await st(); return s && s.picked >= 1 ? s : null; }, 16000) || await st();
T('pickup ' + JSON.stringify({ picked: sPick && sPick.picked, cargo: sPick && sPick.cargo, total: sPick && sPick.cargoTotal }));

// ---- 6) the pad is the payday
PHASE = 'dock';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, hull: 62, cargo: { iron: 5 }, player: { x: 0.5, z: 0.5, a: -Math.PI/2 } })');
await sleep(200);
await ev('window.__destsol.release()');
const sDock = await poll(async () => { const s = await st(); return s && s.credits > 0 ? s : null; }, 20000) || await st();
const shotDock = await shot('destsol-gate-dock');
T('dock ' + JSON.stringify({ credits: sDock && sDock.credits, sold: sDock && sDock.sold, trips: sDock && sDock.trips, hull: sDock && sDock.hull, cargo: sDock && sDock.cargo, inDock: sDock && sDock.inDock, shot: shotDock }));

// ---- 7) a pirate pays a bounty (and a real pointer press aims the gun)
PHASE = 'bounty';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 }, pirates: [{ x: 0, z: -2.6, hp: 2 }] })');
await sleep(220);
const piratePt = await ev('window.__destsol.piratePoint(0)');
await holdAim('window.__destsol.piratePoint(0)', 2400);
const sKill = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 20000) || await st();
T('bounty ' + JSON.stringify({ piratePt, kills: sKill && sKill.kills, pirates: sKill && sKill.pirates, credits: sKill && sKill.credits, shots: sKill && sKill.shots }));

// ---- 8) pirate fire costs hull
PHASE = 'hit';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: 0, z: 0 }, bullets: [{ x: 0.1, z: 0, vx: 0, vz: 0 }] })');
await ev('window.__destsol.release()');
const sHit = await poll(async () => { const s = await st(); return s && s.hull < 100 ? s : null; }, 12000) || await st();
T('hit ' + JSON.stringify({ hull: sHit && sHit.hull }));

// ---- 9) the empty-hold rule: park on the pad with nothing to sell and earn nothing
PHASE = 'noIdlePay';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, cheap: true, player: { x: 0.4, z: 0.4 } })');
await ev('window.__destsol.release()');
await sleep(3000);
const sIdlePay = await st();
T('noIdlePay ' + JSON.stringify({ credits: sIdlePay && sIdlePay.credits, dockT: sIdlePay && sIdlePay.dockT }));

// ---- 10) loss: hull gone opens the sheet
PHASE = 'lose';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, hull: 6, player: { x: 0, z: 0 }, bullets: [{ x: 0, z: 0, vx: 0, vz: 0 }] })');
await ev('window.__destsol.release()');
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 16000) || await st();
const shotLose = await shot('destsol-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, hull: sLose && sLose.hull, sheet: sLose && sLose.sheet, title: sLose && sLose.title, shot: shotLose }));

// ---- 11) restart from the sheet's own button
PHASE = 'restart';
const rBtn = await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ btn: rBtn, over: sNew && sNew.over, hull: sNew && sNew.hull, credits: sNew && sNew.credits, wave: sNew && sNew.wave, rocks: sNew && sNew.rocks, sheet: sNew && sNew.sheet }));

// ---- 12) the jump: a sold hold crosses the goal
PHASE = 'win';
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, credits: 2955, cargo: { crystal: 1 }, player: { x: 0.4, z: 0.4 } })');
await sleep(180);
await ev('window.__destsol.release()');
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 20000) || await st();
const shotWin = await shot('destsol-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, credits: sWin && sWin.credits, sheet: sWin && sWin.sheet, title: sWin && sWin.title, shot: shotWin }));

// ---- 13) "Keep mining" heads into the endless belt past the jump
PHASE = 'endless';
const kBtn = await clickEl('againBtn');
const sKeep = await st();
T('endless ' + JSON.stringify({ btn: kBtn, endless: sKeep && sKeep.endless, over: sKeep && sKeep.over, sheet: sKeep && sKeep.sheet, hull: sKeep && sKeep.hull }));

// ---- 14) live board for the tile art
PHASE = 'board';
await ev(`window.__destsol.setup({ hold: true, noPirates: true, wave: 4, credits: 1180, hull: 72, cargo: { iron: 3, gold: 2 },
  player: { x: -1.1, z: 1.3, a: -0.35 },
  rocks: [{ kind: 'iron', x: 2.9, z: -1.6, hp: 5 }, { kind: 'gold', x: -3.4, z: -2.2, hp: 8 }, { kind: 'crystal', x: 3.6, z: 1.9, hp: 11 },
          { kind: 'iron', x: -4.2, z: 2.6, hp: 7 }, { kind: 'gold', x: 0.4, z: -3.6, hp: 9 }],
  pirates: [{ x: 2.2, z: 2.4, hp: 2 }, { x: -2.6, z: 0.4, hp: 2 }],
  ore: [{ x: 1.4, z: -0.5, kind: 'gold' }, { x: -0.6, z: 2.5, kind: 'iron' }],
  bullets: [{ x: 1.1, z: 0.2, vx: 6, vz: -2, owner: 'p' }, { x: 1.6, z: 2.0, vx: -3, vz: -4, owner: 'b' }] })`);
await sleep(700);
const sBoard = await st();
const shotBoard = await shot('destsol-gate-board');
T('board ' + JSON.stringify({ rocks: sBoard && sBoard.rocks, pirates: sBoard && sBoard.pirates, ore: sBoard && sBoard.ore, credits: sBoard && sBoard.credits, hull: sBoard && sBoard.hull, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 15) portrait touch: a finger flies the ship and a finger cuts rock
PHASE = 'touch';
await S2('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S2('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S2('Page.navigate', { url });
await poll(async () => ((await ev('typeof window.__destsol')) === 'function' ? true : null), 90000, 400);
await sleep(700);
const touchHold = async (pt, ms) => {
  await S2('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, radiusX: 9, radiusY: 9, force: 1, id: 1 }] });
  await sleep(ms);
  await S2('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(220);
};
const tFrame = await st();
const tf = tFrame && tFrame.field;
const tpUp = await ev(`window.__destsol.pointAt(${tf ? (tf.x0 + tf.x1) / 2 : 0}, ${tf ? tf.z0 + 0.6 : -4})`);
const tpDown = await ev(`window.__destsol.pointAt(${tf ? (tf.x0 + tf.x1) / 2 : 0}, ${tf ? tf.z1 - 0.6 : 4})`);
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: 0, z: 0, a: 0 } })');
await sleep(250);
const tPre = await st();
await touchHold(tpUp, 900);
const t1 = await poll(async () => { const s = await st(); return s && s.z < -1.0 ? s : null; }, 16000) || await st();
await sleep(600);
const t1b = await st();
await touchHold(tpDown, 2000);
const t2 = await poll(async () => { const s = await st(); return s && s.z > 1.0 ? s : null; }, 16000) || await st();
T('touchTrace ' + JSON.stringify({ tPre: { t: tPre && tPre.t, z: tPre && tPre.z, hold: tPre && tPre.hold },
  t1: { t: t1 && t1.t, z: t1 && t1.z, vz: t1 && t1.vz }, t1b: { t: t1b && t1b.t, z: t1b && t1b.z, vz: t1b && t1b.vz },
  t2: { t: t2 && t2.t, z: t2 && t2.z, vz: t2 && t2.vz } }));
await ev('window.__destsol.setup({ hold: true, noPirates: true, noRocks: true, player: { x: -4.1, z: 2.8, a: -Math.PI/2 }, rocks: [{ kind: "iron", x: -4.1, z: -1.4 }] })');
await sleep(250);
const tRock = await ev('window.__destsol.rockPoint(0)');
await touchHold(tRock, 1700);
const tMine = await poll(async () => { const s = await st(); return s && (s.mined >= 1 || s.ore > 0) ? s : null; }, 20000) || await st();
const shotTouch = await shot('destsol-gate-touch');
const tpMiss = [tpUp, tpDown, tRock].filter((p) => !p || p.__err || p.x < 2 || p.x > 388 || p.y < 2 || p.y > 842).length;
T('touch ' + JSON.stringify({ start: tFrame && tFrame.z, tpUp, tpDown, t1: t1 && t1.z, t2: t2 && t2.z, tRock, mined: tMine && tMine.mined, ore: tMine && tMine.ore, miss: tpMiss, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.hull === 100 && s0.credits === 0 && s0.rocks >= 8,
  clockRuns: !!s0 && !!s1 && s1.t > s0.t + 0.25 && s1.t < 900,
  piratesDealt: !!sDealt && sDealt.pirates >= 1,
  noInstantLoss: !!sDealt && sDealt.over === false && sDealt.hull === 100,
  flyUp: !!sA && sA.z < -1.2,
  flyDown: !!sB && sB.z > 1.2,
  pointsOnScreen: !!pA && !pA.__err && pA.x > 20 && pA.x < 1260 && pA.y > 20 && pA.y < 780 &&
    !!pB && !pB.__err && pB.x > 20 && pB.x < 1260 && pB.y > 20 && pB.y < 780,
  throttle: !!k1 && k1.speed > 0.8 && k1.x > 0.2,
  yaw: !!k2 && Math.abs(k2.a - (k1 && k1.a)) > 0.2,
  mined: !!sMine && sMine.mined >= 1 && sMine.shots > 0,
  beltInView: !!s0 && !!s0.view && s0.view.x0 <= s0.field.x0 && s0.view.x1 >= s0.field.x1 && s0.view.z0 <= s0.field.z0 && s0.view.z1 >= s0.field.z1,
  oreDropped: !!sPick && sPick.picked >= 2,
  noPaidOnBreak: !!sMine && sMine.credits === 0,
  cargoPicked: !!sPick && sPick.picked >= 1 && sPick.cargoTotal >= 1,
  dockPaid: !!sDock && sDock.credits === 50 && sDock.sold === 5 && sDock.trips === 1,
  dockPatched: !!sDock && sDock.hull === 97 && sDock.cargoTotal === 0,
  bountyPaid: !!sKill && sKill.kills >= 1 && sKill.credits === 60 * sKill.kills,
  pirateFire: !!sHit && sHit.hull === 90,
  emptyHoldPays: !!sIdlePay && sIdlePay.credits === 0,
  loseSheet: !!sLose && sLose.over === true && sLose.won === false && sLose.why === 'hull' && sLose.hull === 0 && sLose.sheet === true && /hull lost/i.test(sLose.title || ''),
  restarted: !!sNew && sNew.over === false && sNew.hull === 100 && sNew.credits === 0 && sNew.wave === 1 && sNew.sheet === false && sNew.rocks >= 8,
  jumpWon: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'jump' && sWin.credits >= 3000 && sWin.sheet === true && /jump ready/i.test(sWin.title || ''),
  keepMining: !!sKeep && sKeep.endless === true && sKeep.over === false && sKeep.sheet === false,
  boardLive: !!sBoard && sBoard.rocks >= 5 && sBoard.pirates >= 2 && sBoard.ore >= 2 && sBoard.over === false,
  touchUp: !!t1 && t1.z < -1.0,
  touchDown: !!t2 && t2.z > 1.0,
  touchPointsOnScreen: tpMiss === 0,
  touchMine: !!tMine && tMine.mined >= 1,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, s0, sDealt, s1, sA, sB, k0, k1, k2, sMine, sPick, sDock, sKill, sHit, sIdlePay, sLose, sNew, sWin, sKeep, sBoard, t1, t2, tpMiss, shots: { boot: shotBoot, mine: shotMine, dock: shotDock, lose: shotLose, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
killAll();
server.close();
process.exit(failed.length ? 1 : 0);
