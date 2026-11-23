#!/usr/bin/env node
// Interaction gate for the AAAAAXY port (card: AAAAAXY, io.github.divverent.aaaaxy):
// real CDP mouse holds on the on-screen pad, state-hook assertions for walking, jumping,
// the gravity flip and ceiling walking, a spike death, the sealed door, a level clear, the
// final win, restart, plus a 390x844 touch pass. A canvas that merely exists is not a pass.
//
// Everything is *polled while the input is held* rather than asserted after a fixed sleep:
// this box runs several headless gates at once, so a starved renderer moves the hero less in
// the same wall-clock window and a duration-based assertion flake reads as a dead port.
//
// usage: node aaaaxy-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/aaaaxy/';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/aaaaxy-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${PROFILE}`, 'about:blank'],
{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });

const press = async (type, x, y) => S('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
const clickAt = async (pt) => { await press('mouseMoved', pt.x, pt.y); await press('mousePressed', pt.x, pt.y); await press('mouseReleased', pt.x, pt.y); };
const st = () => ev('window.__aaaaxy && window.__aaaaxy()');
const poll = async (fn, ms = 5000, step = 130) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const btn = (name) => ev(`window.__aaaaxy && window.__aaaaxy.btnPoint('${name}')`);
// hold a pad button until the predicate sees the state change (or the budget runs out)
const holdUntil = async (name, pred, maxMs = 8000) => {
  const pt = await btn(name);
  if (!pt) return { pt: null, state: null };
  await press('mouseMoved', pt.x, pt.y);
  await press('mousePressed', pt.x, pt.y);
  const t0 = Date.now();
  let hit = null, last = null;
  while (Date.now() - t0 < maxMs) {
    const s = await st();
    last = s;
    if (s && pred(s)) { hit = s; break; }
    await sleep(120);
  }
  await press('mouseReleased', pt.x, pt.y);
  await sleep(140);
  return { pt, state: hit || last };
};
const tapBtn = async (name) => {
  const pt = await btn(name);
  if (!pt) return null;
  await clickAt(pt);
  await sleep(180);
  return pt;
};
const clickBtn = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await clickAt(b);
  await sleep(420);
  return b;
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

// ---- 1) boot: the hook is a function and the board is live
const hookType = await poll(async () => { const t = await ev('typeof window.__aaaaxy'); return t === 'function' ? t : null; }, 25000, 400);
await poll(async () => { const s = await st(); return s && s.lives ? s : null; }, 15000, 300);
const s0 = await st();
const canvasOk = await ev('(()=>{const c=document.querySelector("canvas");return !!c && c.width>200 && c.height>200;})()');
const band = await ev('window.__aaaaxy.hudBand()');
const shotBoot = await shot('aaaaxy-gate-boot');
T('boot ' + JSON.stringify({ hookType, canvasOk, level: s0 && s0.level, name: s0 && s0.name, lives: s0 && s0.lives, total: s0 && s0.total, band }));

// ---- 2) hold the right pad: the hero walks and picks gems up
// Chromium can swallow the first mouse event after a metrics override: prime it on the HUD.
await clickAt({ x: 640, y: 60 });
await sleep(200);
const before = await st();
const walk = await holdUntil('right', (s) => s.x > before.x + 2.5 && s.gems >= 1, 9000);
const sWalk = walk.state;
T('walk ' + JSON.stringify({ pRight: walk.pt, x0: before.x, x1: sWalk && sWalk.x, gems: sWalk && sWalk.gems, deaths: sWalk && sWalk.deaths }));

// ---- 3) the jump pad: the hero leaves the floor
const beforeJump = await st();
const jump = await holdUntil('jump', (s) => s.jumps > beforeJump.jumps && s.y > 1.5, 6000);
const sAir = jump.state;
const shotPlay = await shot('aaaaxy-gate-play');
T('jump ' + JSON.stringify({ pJump: jump.pt, jumps: sAir && sAir.jumps, y: sAir && sAir.y }));

// ---- 4) the flip pad: gravity inverts, the hero settles under the ceiling
const beforeFlip = await st();
const pFlip = await tapBtn('flip');
const sFlip = await poll(async () => { const s = await st(); return s && s.g !== beforeFlip.g && s.flips > beforeFlip.flips ? s : null; }, 5000, 120);
const sCeil = await poll(async () => { const s = await st(); return s && s.g === -1 && s.grounded === true ? s : null; }, 8000, 140);
T('flip ' + JSON.stringify({ pFlip, gBefore: beforeFlip && beforeFlip.g, gAfter: sFlip && sFlip.g, flips: sFlip && sFlip.flips, ceilY: sCeil && sCeil.y }));

// ---- 5) the spikes cost the last life: a QA position one step from the patch
await ev('window.__aaaaxy.setup({level:0, lives:1, x:16.2, y:1})');
await sleep(260);
const sPre = await st();
const lose = await holdUntil('right', (s) => s.over === true, 8000);
const sLose = lose.state;
const shotLose = await shot('aaaaxy-gate-lose');
T('lose ' + JSON.stringify({ x0: sPre && sPre.x, g: sPre && sPre.g, over: sLose && sLose.over, why: sLose && sLose.why, title: sLose && sLose.title, sheet: sLose && sLose.sheet }));

// ---- 6) restart from the sheet through its own button
const pOver = await clickBtn('overBtn');
const sNew = await poll(async () => { const s = await st(); return s && !s.sheet && s.lives === 3 ? s : null; }, 4000, 150);
T('restart ' + JSON.stringify({ pOver, level: sNew && sNew.level, lives: sNew && sNew.lives, over: sNew && sNew.over, sheet: sNew && sNew.sheet }));

// ---- 7) the sealed door: no gems, so the door refuses and hints
await ev('window.__aaaaxy.setup({level:0, lives:3, x:22.4, y:1})');
await sleep(260);
const seal = await holdUntil('right', (s) => s.hints >= 1, 8000);
const sSealed = seal.state;
T('sealed ' + JSON.stringify({ pSeal: seal.pt, gems: sSealed && sSealed.gems, total: sSealed && sSealed.total, cleared: sSealed && sSealed.cleared, hints: sSealed && sSealed.hints, x: sSealed && sSealed.x }));

// ---- 8) level clear: walk into the door with every gem
await ev('window.__aaaaxy.setup({level:0, lives:3, gems:2, x:21.6, y:1})');
await sleep(260);
const door = await holdUntil('right', (s) => s.cleared === true, 9000);
const sClear = door.state;
T('clear ' + JSON.stringify({ pDoor: door.pt, cleared: sClear && sClear.cleared, won: sClear && sClear.won, title: sClear && sClear.title, sheet: sClear && sClear.sheet }));

// ---- 9) next level from the clear sheet, then the final ceiling door wins the game
const pNext = await clickBtn('nextBtn');
const sNext = await poll(async () => { const s = await st(); return s && s.level === 2 && !s.sheet ? s : null; }, 4000, 150);
T('next ' + JSON.stringify({ pNext, level: sNext && sNext.level, name: sNext && sNext.name, sheet: sNext && sNext.sheet }));
await ev('window.__aaaaxy.setup({level:2, lives:3, gems:3, g:-1, x:22.2, y:9.14})');
await sleep(300);
const end = await holdUntil('right', (s) => s.cleared === true, 9000);
const sWin = end.state;
T('win ' + JSON.stringify({ pEnd: end.pt, cleared: sWin && sWin.cleared, won: sWin && sWin.won, title: sWin && sWin.title, sheet: sWin && sWin.sheet }));

// ---- 10) the R key restarts the level
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
const sKey = await poll(async () => { const s = await st(); return s && !s.cleared && !s.sheet && s.lives === 3 ? s : null; }, 4000, 150);
T('r-key ' + JSON.stringify({ level: sKey && sKey.level, lives: sKey && sKey.lives, sheet: sKey && sKey.sheet }));

// ---- 11) a real keyboard walk (arrows) as well as the buttons
const kx0 = (await st()).x;
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
const sKeys = await poll(async () => { const s = await st(); return s && s.x > kx0 + 1.5 ? s : null; }, 6000, 130);
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
await sleep(160);
const kx1 = (await st()).x;
T('keys ' + JSON.stringify({ kx0, kx1 }));

const errors1 = consoleErrors();

// ---- 12) portrait touch: tap the pad, tap the board
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await poll(async () => { const t = await ev('typeof window.__aaaaxy'); return t === 'function' ? t : null; }, 25000, 400);
await poll(async () => { const s = await st(); return s && s.lives ? s : null; }, 15000, 300);
const tapAt = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
// Chromium can swallow the first touch after a metrics override: prime on the HUD once
await tapAt(await ev(`window.__aaaaxy.btnPoint('left')`));
await sleep(400);
const t0 = await st();
const tRight = await ev(`window.__aaaaxy.btnPoint('right')`);
await tapAt(tRight);
const t1 = await poll(async () => { const s = await st(); return s && s.x > t0.x + 0.15 ? s : null; }, 3000, 120) || await st();
const tFlipP = await ev(`window.__aaaaxy.btnPoint('flip')`);
await tapAt(tFlipP);
const t2 = await poll(async () => { const s = await st(); return s && s.g === -1 ? s : null; }, 3000, 120) || await st();
const shotTouch = await shot('aaaaxy-gate-touch');
const bandT = await ev('window.__aaaaxy.hudBand()');
const pJumpT = await ev(`window.__aaaaxy.btnPoint('jump')`);
const onScreen = (p) => !!p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840;
T('touch ' + JSON.stringify({ t0: { x: t0.x, g: t0.g }, t1: { x: t1.x }, t2: { g: t2.g, flips: t2.flips }, tRight, tFlipP, pJumpT,
  onScreen: [onScreen(tRight), onScreen(tFlipP), onScreen(pJumpT)], band: bandT }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.lives === 3 && s0.level === 1,
  canvasLive: canvasOk === true,
  bandSane: !!band && band.top > 0 && band.top < 0.85 && band.bottom < 0 && band.bottom > -0.85,
  walkedRight: !!sWalk && sWalk.x > before.x + 2.5,
  gemPicked: !!sWalk && sWalk.gems >= 1,
  jumped: !!sAir && sAir.jumps > beforeJump.jumps && sAir.y > 1.5,
  flipped: !!sFlip && sFlip.g === -beforeFlip.g && sFlip.flips > beforeFlip.flips,
  ceilingLanded: !!sCeil && sCeil.y > 8.9 && sCeil.y < 9.4,
  lostLastLife: !!sLose && sLose.over === true && sLose.won === false && sLose.why === 'spikes' && sLose.sheet === true,
  loseTitle: !!sLose && /weirdness wins/i.test(sLose.title || ''),
  restarted: !!sNew && sNew.level === 1 && sNew.lives === 3 && sNew.over === false && sNew.sheet === false,
  doorSealed: !!sSealed && sSealed.cleared === false && sSealed.hints >= 1 && sSealed.over === false,
  levelCleared: !!sClear && sClear.cleared === true && sClear.won === false && sClear.sheet === true && /level clear/i.test(sClear.title || ''),
  nextLevel: !!sNext && sNext.level === 2,
  gameWon: !!sWin && sWin.cleared === true && sWin.won === true && sWin.sheet === true && /reached the end/i.test(sWin.title || ''),
  keyRestart: !!sKey && sKey.lives === 3 && sKey.cleared === false && sKey.sheet === false,
  keyWalked: kx1 > kx0 + 1.2,
  touchWalked: !!t1 && t1.x > t0.x + 0.15,
  touchFlipped: !!t2 && t2.g === -1 && t2.flips >= 1,
  touchPointsOnScreen: [tRight, tFlipP, pJumpT].every(onScreen),
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({
  checks, failed, errors1, errors2,
  s0: s0 && { level: s0.level, lives: s0.lives, total: s0.total },
  sWalk: sWalk && { x: sWalk.x, gems: sWalk.gems },
  sAir: sAir && { y: sAir.y, jumps: sAir.jumps },
  sFlip: sFlip && { g: sFlip.g, flips: sFlip.flips },
  sCeil: sCeil && { y: sCeil.y, grounded: sCeil.grounded },
  sLose: sLose && { over: sLose.over, why: sLose.why, title: sLose.title },
  sNew: sNew && { level: sNew.level, lives: sNew.lives },
  sSealed: sSealed && { cleared: sSealed.cleared, hints: sSealed.hints, x: sSealed.x },
  sClear: sClear && { cleared: sClear.cleared, title: sClear.title },
  sNext: sNext && { level: sNext.level, name: sNext.name },
  sWin: sWin && { cleared: sWin.cleared, won: sWin.won, title: sWin.title },
  sKey: sKey && { level: sKey.level, sheet: sKey.sheet },
  kx0, kx1, t0: { x: t0.x }, t1: { x: t1.x }, t2: { g: t2.g },
  shots: [shotBoot, shotPlay, shotLose, shotTouch].filter(Boolean),
}, null, 0));
console.log(failed.length ? 'GATE FAIL' : 'GATE PASS');
proc.kill('SIGKILL'); server.close();
process.exit(failed.length ? 1 : 0);
