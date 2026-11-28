#!/usr/bin/env node
// Interaction gate for the Asteroid's Revenge port (F-Droid card com.game.asteroids_revenge,
// GPL-3.0-only): real CDP mouse / keyboard / touch on the SHIPPED page, with every assertion read
// back from the page's own state hook. A canvas that merely exists is not a pass.
//
// usage: node revenge-gate.mjs [site-root]      (default /home/cluer/kaos/work/site)
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
const FILE = 'games/arcade/asteroid-s-revenge/index.html';
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
const PROFILE = mkdtempSync('/tmp/revenge-gate-');
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
const dragTo = async (pt) => {
  await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(110);
  await S2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return null;
  await click(b);
  await sleep(450);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S2('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S2('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(240);
};
const st = () => ev('window.__revenge()');
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

// ---- 1) boot: hook live, clock running, fleet dealt, nobody dies on frame one
PHASE = 'boot';
const ready = await poll(async () => ((await ev('typeof window.__revenge')) === 'function' ? true : null), 90000, 400);
const hookType = await ev('typeof window.__revenge');
const s0 = await st();
const sDealt = await poll(async () => { const s = await st(); return s && s.ships >= 1 ? s : null; }, 30000, 200) || await st();
await sleep(900);
const s1 = await st();
const shotBoot = await shot('revenge-gate-boot');
T('boot ' + JSON.stringify({ ready, hookType, t0: s0 && s0.t, t1: s1 && s1.t, ships: sDealt && sDealt.ships, hull: s0 && s0.hull, over: s0 && s0.over, field: s1 && s1.field }));
T('bootShot ' + shotBoot);

// ---- 2) a real pointer press flies the asteroid left, then right
PHASE = 'steer';
await ev('window.__revenge.setup({ hold: true, x: 0, y: -2, noQueue: true })');
await sleep(200);
const pL = await ev('window.__revenge.pointAt(-3.6, -2)');
await dragTo(pL);
const sL = await poll(async () => { const s = await st(); return s && s.x < -1.5 ? s : null; }, 16000) || await st();
const pR = await ev('window.__revenge.pointAt(3.6, -2)');
await dragTo(pR);
const sR = await poll(async () => { const s = await st(); return s && s.x > 1.5 ? s : null; }, 16000) || await st();
T('steer ' + JSON.stringify({ pL, xL: sL && sL.x, pR, xR: sR && sR.x }));

// ---- 3) keyboard nudges the same target
PHASE = 'keys';
await ev('window.__revenge.setup({ hold: true, noQueue: true, x: 0, y: -2 })');
await sleep(240);
await keyTap('KeyA', 'a', 65);
const sA = await st();
await keyTap('KeyD', 'd', 68);
await keyTap('KeyD', 'd', 68);
const sD = await st();
await keyTap('KeyW', 'w', 87);
const sW = await st();
T('keys ' + JSON.stringify({ a: sA && sA.tx, d: sD && sD.tx, w: sW && sW.ty }));

// ---- 4) ramming is the weapon: a real pointer drag onto a scout kills it
PHASE = 'ram';
await ev('window.__revenge.setup({ hold: true, noQueue: true, hull: 60, x: 0, y: -2, ships: [{ type: "scout", x: 0, y: 0.6 }] })');
await sleep(220);
const preRam = await st();
const shipPt = await ev('window.__revenge.shipPoint(0)');
await dragTo(shipPt);
const sRam = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 24000);
const shotRam = await shot('revenge-gate-ram');
T('ram ' + JSON.stringify({ preShips: preRam && preRam.ships, preHull: preRam && preRam.hull, pt: shipPt, kills: sRam && sRam.kills, ramHits: sRam && sRam.ramHits, hull: sRam && sRam.hull, score: sRam && sRam.score, drops: sRam && sRam.drops, shot: shotRam }));

// ---- 5) a shielded hull takes two rams
PHASE = 'shield';
await ev('window.__revenge.setup({ hold: true, noQueue: true, x: 0, y: -1.5, ships: [{ type: "shield", x: 0, y: 0.2 }] })');
await sleep(220);
const shieldPt = await ev('window.__revenge.shipPoint(0)');
await dragTo(shieldPt);
const sShield = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 26000) || await st();
T('shield ' + JSON.stringify({ pt: shieldPt, kills: sShield && sShield.kills, ramHits: sShield && sShield.ramHits, hull: sShield && sShield.hull }));

// ---- 6) a laser costs mass
PHASE = 'laser';
await ev('window.__revenge.setup({ hold: true, noQueue: true, x: 0, y: -1, bullets: [{ x: 0, y: -1, vx: 0, vy: 0 }] })');
await sleep(220);
const sLaser = await poll(async () => { const s = await st(); return s && s.hull < 100 ? s : null; }, 12000) || await st();
T('laser ' + JSON.stringify({ hull: sLaser && sLaser.hull }));

// ---- 7) a cleared wave advances (released wave door)
PHASE = 'wave';
await ev('window.__revenge.setup({ hold: true, wave: 2, noQueue: true, x: 0, y: -2, score: 100 })');
await sleep(200);
const preWave = await st();
await ev('window.__revenge.release()');
const sWave = await poll(async () => { const s = await st(); return s && s.wave >= 3 ? s : null; }, 12000) || await st();
T('wave ' + JSON.stringify({ before: preWave && preWave.wave, after: sWave && sWave.wave, score: sWave && sWave.score }));

// ---- 8) loss: hull gone opens the run-over sheet
PHASE = 'lose';
await ev('window.__revenge.setup({ hold: true, noQueue: true, hull: 8, x: 0, y: -1, bullets: [{ x: 0, y: -1, vx: 0, vy: 0 }] })');
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 16000) || await st();
const shotLose = await shot('revenge-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, hull: sLose && sLose.hull, sheet: sLose && sLose.sheet, title: sLose && sLose.title, shot: shotLose }));

// ---- 9) restart from the sheet's own button
PHASE = 'restart';
const rBtn = await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ btn: rBtn, over: sNew && sNew.over, hull: sNew && sNew.hull, wave: sNew && sNew.wave, score: sNew && sNew.score, sheet: sNew && sNew.sheet }));

// ---- 10) the win chain: ram the dreadnought, then the last charge into Earth
PHASE = 'win';
await ev('window.__revenge.setup({ hold: true, noQueue: true, wave: 10, x: 0, y: -2, ships: [{ type: "dread", x: 0, y: 0.4, hp: 1 }] })');
await sleep(220);
const dreadPt = await ev('window.__revenge.shipPoint(0)');
await dragTo(dreadPt);
const sDread = await poll(async () => { const s = await st(); return s && s.ships === 0 ? s : null; }, 24000) || await st();
const earthPt = await ev('window.__revenge.earthPoint()');
await dragTo(earthPt);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 26000) || await st();
const shotWin = await shot('revenge-gate-win');
T('win ' + JSON.stringify({ dreadPt, dreadKills: sDread && sDread.kills, shieldAfterDread: sDread && sDread.earth && sDread.earth.shield, earthPt, over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, title: sWin && sWin.title, sheet: sWin && sWin.sheet, score: sWin && sWin.score, shot: shotWin }));

// ---- 11) "Keep flying" heads into the endless waves past the win
PHASE = 'endless';
const kBtn = await clickEl('againBtn');
const sKeep = await st();
T('endless ' + JSON.stringify({ btn: kBtn, endless: sKeep && sKeep.endless, wave: sKeep && sKeep.wave, over: sKeep && sKeep.over, sheet: sKeep && sKeep.sheet }));

// ---- 12) live board for the tile art: a rigged fleet, not an empty field
PHASE = 'board';
await ev(`window.__revenge.setup({ hold: true, noQueue: true, wave: 9, x: -0.7, y: -2.4, hull: 74, score: 2140,
  ships: [{ type: 'gunner', x: -2.8, y: 2.4 }, { type: 'shield', x: 2.5, y: 0.9 }, { type: 'scout', x: 0.5, y: 3.9 },
          { type: 'scout', x: 3.3, y: 4.9 }, { type: 'gunner', x: -3.1, y: 4.4 }, { type: 'scout', x: 1.9, y: 1.6 }],
  bullets: [{ x: -1.0, y: 1.5, vx: 0.15, vy: -1.4 }, { x: 1.7, y: 2.9, vx: -0.35, vy: -1.1 }, { x: 3.0, y: 3.6, vx: -0.1, vy: -1.5 }],
  iron: [{ x: -2.2, y: -0.6 }, { x: 2.9, y: -1.4 }] })`);
await sleep(700);
const sBoard = await st();
const shotBoard = await shot('revenge-gate-board');
T('board ' + JSON.stringify({ ships: sBoard && sBoard.ships, bullets: sBoard && sBoard.bullets, hull: sBoard && sBoard.hull, over: sBoard && sBoard.over, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 13) portrait touch: a finger steers, and a tap on a hull rams it
PHASE = 'touch';
await S2('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S2('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S2('Page.navigate', { url });
await poll(async () => ((await ev('typeof window.__revenge')) === 'function' ? true : null), 90000, 400);
await sleep(600);
const touchDrag = async (from, to) => {
  await S2('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, radiusX: 9, radiusY: 9, force: 1, id: 1 }] });
  for (let i = 1; i <= 4; i++) {
    await S2('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4, radiusX: 9, radiusY: 9, force: 1, id: 1 }] });
    await sleep(45);
  }
  await sleep(70);
  await S2('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
const tFrame = await st();
const tf = tFrame && tFrame.field;
const midY = tf ? (tf.y0 + tf.y1) / 2 : 0;
const tpL = await ev(`window.__revenge.pointAt(${tf ? tf.x0 + 0.4 : -2}, ${midY})`);
const tpR = await ev(`window.__revenge.pointAt(${tf ? tf.x1 - 0.4 : 2}, ${midY})`);
await ev('window.__revenge.setup({ hold: true, noQueue: true, x: 0, y: -2 })');
await sleep(250);
await touchDrag(tpR, tpL);
const t1 = await poll(async () => { const s = await st(); return s && s.x < -0.8 ? s : null; }, 16000) || await st();
await touchDrag(tpL, tpR);
const t2 = await poll(async () => { const s = await st(); return s && s.x > 0.8 ? s : null; }, 16000) || await st();
await ev('window.__revenge.setup({ hold: true, noQueue: true, x: 0, y: -2, ships: [{ type: "scout", x: 0, y: 0.4 }] })');
await sleep(220);
const tShip = await ev('window.__revenge.shipPoint(0)');
await touchDrag({ x: 195, y: 620 }, tShip);
const tKill = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 26000);
const shotTouch = await shot('revenge-gate-touch');
const tpMiss = [tpL, tpR, tShip].filter((p) => !p || p.__err || p.x < 2 || p.x > 388 || p.y < 2 || p.y > 842).length;
T('touch ' + JSON.stringify({ start: tFrame && tFrame.x, tpL, tpR, t1: t1 && t1.x, t2: t2 && t2.x, tShip, kills: tKill && tKill.kills, miss: tpMiss, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.hull === 100 && s0.wave === 1,
  clockRuns: !!s0 && !!s1 && s1.t > s0.t + 0.25 && s1.t < 900,
  fleetDealt: !!sDealt && sDealt.ships >= 1,
  noInstantLoss: !!sDealt && sDealt.over === false && sDealt.hull === 100,
  steerLeft: !!sL && sL.x < -1.5,
  steerRight: !!sR && sR.x > 1.5,
  pointsOnScreen: !!pL && !pL.__err && pL.x > 20 && pL.x < 1260 && pL.y > 20 && pL.y < 780 &&
    !!pR && !pR.__err && pR.x > 20 && pR.x < 1260 && pR.y > 20 && pR.y < 780,
  keysSteer: !!sA && sA.tx < -0.4 && !!sD && sD.tx > 0.6 && !!sW && sW.ty > -2,
  ramKilled: !!sRam && sRam.kills >= 1 && sRam.ships === 0 && sRam.score > 0 && sRam.hull >= 55 && sRam.hull <= 60,
  shieldedNeedsTwo: !!sShield && sShield.kills >= 1 && sShield.ramHits >= 2,
  laserHurts: !!sLaser && sLaser.hull < 100,
  waveAdvanced: !!sWave && sWave.wave >= 3 && sWave.score > 100,
  loseSheet: !!sLose && sLose.over === true && sLose.won === false && sLose.hull === 0 && sLose.sheet === true && /run over/i.test(sLose.title || ''),
  restarted: !!sNew && sNew.over === false && sNew.hull === 100 && sNew.wave === 1 && sNew.score === 0 && sNew.sheet === false,
  dreadDropsShield: !!sDread && sDread.kills >= 1 && sDread.ships === 0 && sDread.earth && sDread.earth.shield === false,
  earthWon: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'earth' && sWin.sheet === true && /earth falls/i.test(sWin.title || ''),
  keepFlying: !!sKeep && sKeep.endless === true && sKeep.wave >= 11 && sKeep.over === false && sKeep.sheet === false,
  boardLive: !!sBoard && sBoard.ships >= 4 && sBoard.bullets >= 2 && sBoard.over === false,
  touchLeft: !!t1 && t1.x < -0.8,
  touchRight: !!t2 && t2.x > 0.8,
  touchPointsOnScreen: tpMiss === 0,
  touchRam: !!tKill && tKill.kills >= 1,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, s0, sDealt, s1, sL, sR, sA, sD, sW, sRam, sShield, sLaser, sWave, sLose, sNew, sDread, sWin, sKeep, sBoard, t1, t2, tpMiss, shots: { boot: shotBoot, ram: shotRam, lose: shotLose, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
killAll();
server.close();
process.exit(failed.length ? 1 : 0);
