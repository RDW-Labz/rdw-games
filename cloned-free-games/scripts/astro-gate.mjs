#!/usr/bin/env node
// Interaction gate for the Astro Loop port (Astro Loop card, PubDeer/astro-loop, GPL-3.0-only):
// real CDP mouse / keyboard / touch on the shipped page, state-hook assertions for steering,
// autofire kills, the wave-clear upgrade sheet, the ram loss, the wave-10 win, restart, plus a
// 390x844 portrait pass. A canvas that merely exists is not a pass.
//
// usage: node astro-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
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
const FILE = 'games/arcade/astro-loop/index.html';
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
    if (this.slowLog && (method === 'Runtime.evaluate' || method === 'Page.captureScreenshot')) T('  send ' + method);
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) { T('  TIMEOUT ' + method); bad(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/astro-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

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
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(5200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const dragTo = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(450);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(220);
};
const st = () => ev('window.__astro()');
const poll = async (fn, ms = 6000, step = 150) => {
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

// ---- 1) boot: the hook is live, the clock runs, the first wave is dealt, nobody dies on frame 1
PHASE = 'boot';
const ready = await poll(async () => ((await ev('typeof window.__astro')) === 'function' ? true : null), 45000, 400);
const hookType = await ev('typeof window.__astro');
const s0 = await st();
const s1 = await poll(async () => { const s = await st(); return s && s.rocks >= 2 ? s : null; }, 25000, 250) || await st();
// Measure the clock over a real interval: the first wave is dealt on frame 1, so s1 can return on its
// very first poll and a back-to-back s1b would read the same frame and look like a frozen clock.
await sleep(800);
const s1b = await st();
const shotBoot = await shot('astro-gate-boot');
T('boot ' + JSON.stringify({ ready, hookType, t0: s0 && s0.t, t1: s1 && s1.t, t2: s1b && s1b.t, rocks1: s1 && s1.rocks, hp1: s1 && s1.hp, over1: s1 && s1.over, shots1: s1 && s1.shots }));
T('bootShot ' + shotBoot);

// ---- 2) a real pointer press steers the ship left, then right
PHASE = 'steer';
const pL = await ev('window.__astro.pointAt(-3.6, -1.4)');
await dragTo(pL);
const sL = await poll(async () => { const s = await st(); return s && s.x < -1.4 ? s : null; }, 14000, 160) || await st();
const pR = await ev('window.__astro.pointAt(3.6, -1.4)');
await dragTo(pR);
const sR = await poll(async () => { const s = await st(); return s && s.x > 1.4 ? s : null; }, 14000, 160) || await st();
T('steer ' + JSON.stringify({ pL, sL: { x: sL && sL.x, y: sL && sL.y }, pR, sR: { x: sR && sR.x, y: sR && sR.y } }));

// ---- 3) keyboard nudges the same target
PHASE = 'keys';
await ev('window.__astro.setup({ hold: true, x: 0, y: -1.6 })');
await sleep(260);
await keyTap('KeyA', 'a', 65);
const sA = await st();
await keyTap('KeyD', 'd', 68);
await keyTap('KeyD', 'd', 68);
await sleep(240);
const sD = await st();
await keyTap('KeyW', 'w', 87);
await sleep(240);
const sW = await st();
T('keys ' + JSON.stringify({ a: sA && sA.tx, d: sD && sD.tx, w: sW && sW.ty }));

// ---- 4) the guns are automatic and a rock really dies on the firing line
PHASE = 'kill';
await ev('window.__astro.setup({ hold: true, x: 0, y: -1.8, rocks: [{ x: 0, y: 1.2, r: 0.6, hp: 1 }] })');
await sleep(220);
const preKill = await st();
const sKill = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 22000, 160);
const shotMid = await shot('astro-gate-mid');
T('kill ' + JSON.stringify({ preRocks: preKill && preKill.rocks, preShots: preKill && preKill.shots, kills: sKill && sKill.kills, rocks: sKill && sKill.rocks, score: sKill && sKill.score, shot: shotMid }));

// ---- 5) clearing a wave opens three upgrade cards; a real click on one is taken
PHASE = 'upgrade';
await ev('window.__astro.setup({ hold: false, wave: 2, x: 0, y: -1.8, rocks: [{ x: 0, y: 1.2, r: 0.6, hp: 1 }] })');
await sleep(200);
const sPick = await poll(async () => { const s = await st(); return s && s.mode === "pick" ? s : null; }, 22000, 160);
const cardBtn = await clickEl('card0');
const sPicked = await st();
const shotPick = await shot('astro-gate-upgrade');
T('upgrade ' + JSON.stringify({ pickOpen: sPick && sPick.mode, cards: sPick && sPick.pick, sheet: sPick && sPick.sheet, title: sPick && sPick.title, btn: cardBtn, upgrades: sPicked && sPicked.upgrades, wave: sPicked && sPicked.wave, mode: sPicked && sPicked.mode, sheet2: sPicked && sPicked.sheet, shot: shotPick }));

// ---- 6) loss: a rock already overlapping the hull ends the run on the sheet
await ev('window.__astro.setup({ hold: true, hp: 12, x: 0, y: -1.8, rocks: [{ x: 0, y: -1.8, r: 0.9, hp: 4 }] })');
await sleep(220);
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 16000, 160);
const shotLose = await shot('astro-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, hp: sLose && sLose.hp, sheet: sLose && sLose.sheet, title: sLose && sLose.title, shot: shotLose }));

// ---- 7) restart from the sheet's own button
const rBtn = await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ btn: rBtn, over: sNew && sNew.over, hp: sNew && sNew.hp, wave: sNew && sNew.wave, score: sNew && sNew.score, sheet: sNew && sNew.sheet }));

// ---- 8) win: wave 10 is the loop's edge
PHASE = 'win';
await ev('window.__astro.setup({ hold: false, wave: 10, x: 0, y: -1.8, rocks: [{ x: 0, y: 1.2, r: 0.6, hp: 1 }] })');
await sleep(220);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 26000, 180);
const shotWin = await shot('astro-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, title: sWin && sWin.title, sheet: sWin && sWin.sheet, score: sWin && sWin.score, shot: shotWin }));

// ---- 9) "Keep flying" resumes past the win, then R starts a clean run
PHASE = 'resume';
const kBtn = await clickEl('overBtn');
const sKeep = await st();
await keyTap('KeyR', 'r', 82);
await sleep(400);
const sRKey = await st();
T('resume ' + JSON.stringify({ btn: kBtn, over: sKeep && sKeep.over, wave: sKeep && sKeep.wave, sheet: sKeep && sKeep.sheet, rOver: sRKey && sRKey.over, rWave: sRKey && sRKey.wave, rScore: sRKey && sRKey.score, rHp: sRKey && sRKey.hp }));

// ---- 10) a live board for the tile art
PHASE = 'board';
await ev(`window.__astro.setup({ hold: true, wave: 4, x: -0.4, y: -1.5, hp: 78, score: 860,
  rocks: [{ x: -2.6, y: 1.9, r: 0.9, hp: 4 }, { x: 2.9, y: 0.4, r: 0.62, hp: 2 }, { x: 1.1, y: 3.3, r: 0.5, hp: 2 }],
  enemies: [{ type: 'hunter', x: 1.9, y: 2.2 }, { type: 'juke', x: -1.4, y: 3.0 }, { type: 'rusher', x: -3.1, y: -0.2 }] })`);
await sleep(700);
const sBoard = await st();
const shotBoard = await shot('astro-gate-board');
T('board ' + JSON.stringify({ rocks: sBoard && sBoard.rocks, enemies: sBoard && sBoard.enemies, bullets: sBoard && sBoard.bullets, hp: sBoard && sBoard.hp, over: sBoard && sBoard.over, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 11) portrait touch: 390x844 phone
PHASE = 'touch'; // a finger steers and the guns clear a rock
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
const touchDrag = async (from, to) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, radiusX: 9, radiusY: 9, force: 1 }] });
  for (let i = 1; i <= 4; i++) {
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4, radiusX: 9, radiusY: 9, force: 1 }] });
    await sleep(40);
  }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
};
const t0 = await st();
const tf = await st();
const bnd = tf && tf.field;
const midY = bnd ? (bnd.y0 + bnd.y1) / 2 : 400;
const tpL = await ev(`window.__astro.pointAt(${bnd ? bnd.x0 + 0.5 : -2}, ${midY})`);
const tpR = await ev(`window.__astro.pointAt(${bnd ? bnd.x1 - 0.5 : 2}, ${midY})`);
await touchDrag(tpR, tpL);
const t1 = await poll(async () => { const s = await st(); return s && s.x < -0.6 ? s : null; }, 14000, 160) || await st();
await touchDrag(tpL, tpR);
const t2 = await poll(async () => { const s = await st(); return s && s.x > 0.4 ? s : null; }, 14000, 160) || await st();
await ev('window.__astro.setup({ hold: true, x: 0, y: -1.8, rocks: [{ x: 0, y: 1.0, r: 0.6, hp: 1 }] })');
await sleep(200);
const tKill = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 22000, 160);
const shotTouch = await shot('astro-gate-touch');
const tpMiss = [tpL, tpR].filter((p) => !p || p.x < 2 || p.x > 388 || p.y < 2 || p.y > 842).length;
T('touch ' + JSON.stringify({ t0: t0 && t0.x, tpL, tpR, t1: t1 && t1.x, t2: t2 && t2.x, kills: tKill && tKill.kills, miss: tpMiss, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.hp === 100,
  clockRuns: !!s1b && s1b.t > (s0.t || 0) + 0.3 && s1b.t < 600 && !!s1 && s1.t > 0,
  waveDealt: !!s1 && s1.rocks >= 2,
  autofire: !!s1 && s1.shots >= 1,
  noInstantLoss: !!s1 && s1.over === false && s1.hp === 100,
  steerLeft: !!sL && sL.x < -1.4,
  steerRight: !!sR && sR.x > 1.4,
  pointsOnScreen: !!pL && pL.x > 30 && pL.x < 1250 && pL.y > 30 && pL.y < 770 &&
    !!pR && pR.x > 30 && pR.x < 1250 && pR.y > 30 && pR.y < 770,
  keysSteer: !!sA && sA.tx < -0.4 && !!sD && sD.tx > 0.6 && !!sW && sW.ty > -1.6,
  rockKilled: !!sKill && sKill.kills >= 1 && sKill.rocks === 0 && sKill.score > 0 && sKill.shots > 0,
  upgradeOffered: !!sPick && sPick.mode === 'pick' && sPick.pick.length === 3 && sPick.sheet === true && /cleared/i.test(sPick.title),
  upgradeTaken: !!sPicked && sPicked.upgrades.length === 1 && sPicked.mode === 'combat' && sPicked.sheet === false && sPicked.wave === 3,
  ramLoss: !!sLose && sLose.over === true && sLose.won === false && sLose.hp === 0 && sLose.sheet === true && /run over/i.test(sLose.title),
  restarted: !!sNew && sNew.over === false && sNew.hp === 100 && sNew.wave === 1 && sNew.score === 0 && sNew.sheet === false,
  won: !!sWin && sWin.over === true && sWin.won === true && sWin.sheet === true && /loop cleared/i.test(sWin.title),
  keepFlying: !!sKeep && sKeep.over === false && sKeep.wave === 11 && sKeep.sheet === false,
  keyRestart: !!sRKey && sRKey.over === false && sRKey.wave === 1 && sRKey.score === 0 && sRKey.hp === 100,
  boardLive: !!sBoard && sBoard.rocks >= 3 && sBoard.enemies >= 2 && sBoard.over === false,
  touchLeft: !!t1 && t1.x < -0.6,
  touchRight: !!t2 && t2.x > 0.4,
  touchPointsOnScreen: tpMiss === 0,
  touchKill: !!tKill && tKill.kills >= 1,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, s0, s1, sL, sR, sA, sD, sW, sKill, sPick: sPick && { mode: sPick.mode, pick: sPick.pick, title: sPick.title }, sPicked, sLose, sNew, sWin, sKeep, sRKey, sBoard, t1, t2, shots: { boot: shotBoot, mid: shotMid, pick: shotPick, lose: shotLose, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(failed.length ? 1 : 0);
