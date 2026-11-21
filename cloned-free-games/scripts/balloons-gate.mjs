#!/usr/bin/env node
// Interaction gate for the Non-Stop Balloons Shooter port (card: com.stoptheballs /
// MetatransApps Android_APK_2DBalloons). Real CDP mouse / keyboard / touch on the shipped page,
// state-hook assertions for the shot, a pop, a heavy balloon's two hits, the leak loss, the
// six-wave win, restart, plus a 390x844 portrait pass. A canvas that merely exists is not a pass.
//
// usage: node balloons-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/balloons-shooter/index.html';
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
const PROFILE = mkdtempSync('/tmp/balloons-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(5200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(400);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(220);
};
const st = () => ev('window.__balloons()');
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

// ---- 1) boot: a function hook, a live clock, a wave on the board
const hookType = await ev('typeof window.__balloons');
const s0 = await st();
await sleep(1700);
const s1 = await st();
const shotBoot = await shot('balloons-gate-boot');
T('boot ' + JSON.stringify({ hookType, t0: s0 && s0.t, t1: s1 && s1.t, lives: s1 && s1.lives, balloons: s1 && s1.balloons, queued: s1 && s1.queued }));
T('bootShot ' + shotBoot);

// ---- 2) a real click on a balloon pops it (static placement so the aim is honest)
await ev('window.__balloons.setup({seed:31, balloons:[{a:-1.5708, d:4.2, sp:0}]})');
await sleep(300);
const pPop = await ev('window.__balloons.balloonPoint(0)');
const prePop = await st();
await click(pPop);
const sPop = await poll(async () => { const s = await st(); return s && s.pops >= 1 ? s : null; }, 4000, 120);
const shotPop = await shot('balloons-gate-pop');
T('pop ' + JSON.stringify({ pPop, preShots: prePop && prePop.shots, pops: sPop && sPop.pops, shots: sPop && sPop.shots, score: sPop && sPop.score, inputs: sPop && sPop.inputs }));

// ---- 3) a click down an empty bearing costs a shot and pops nothing
await ev('window.__balloons.setup({seed:32, balloons:[{a:-1.5708, d:4.2, sp:0}]})');
await sleep(300);
const pEmpty = await ev('window.__balloons.aimPoint(35, 4.4)');
const preEmpty = await st();
await click(pEmpty);
await sleep(700);
const sEmpty = await st();
T('miss ' + JSON.stringify({ pEmpty, shots: sEmpty && sEmpty.shots, pops: sEmpty && sEmpty.pops, arrows: sEmpty && sEmpty.arrows, blocked: sEmpty && sEmpty.blocked }));

// ---- 4) a heavy balloon takes two real hits
await ev('window.__balloons.setup({seed:33, balloons:[{a:-1.5708, d:4.0, sp:0, kind:"heavy"}]})');
await sleep(300);
const pH = await ev('window.__balloons.balloonPoint(0)');
await click(pH);
await sleep(600);
const sH1 = await st();
await sleep(300);
const pH2 = await ev('window.__balloons.balloonPoint(0)');
await click(pH2);
const sH2 = await poll(async () => { const s = await st(); return s && s.pops >= 1 ? s : null; }, 4000, 120);
T('heavy ' + JSON.stringify({ after1: { pops: sH1 && sH1.pops, balloons: sH1 && sH1.balloons, hits: sH1 && sH1.hits }, after2: { pops: sH2 && sH2.pops, score: sH2 && sH2.score, hits: sH2 && sH2.hits } }));

// ---- 5) loss: one life, a balloon already inside the red line
await ev('window.__balloons.setup({seed:34, lives:1, balloons:[{a:0.4, d:1.15, sp:0.9}]})');
await sleep(200);
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 6000, 120);
const shotLose = await shot('balloons-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, lives: sLose && sLose.lives, sheet: sLose && sLose.sheet, title: sLose && sLose.title, shot: shotLose }));

// ---- 6) restart on the sheet's own button
const rBtn = await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ btn: rBtn, over: sNew && sNew.over, lives: sNew && sNew.lives, score: sNew && sNew.score, sheet: sNew && sNew.sheet, wave: sNew && sNew.wave }));

// ---- 7) win: the last wave's last balloon, shot for real
await ev('window.__balloons.setup({seed:35, wave:5, lives:4, score:500, balloons:[{a:-1.5708, d:4.0, sp:0}]})');
await sleep(300);
const pW = await ev('window.__balloons.balloonPoint(0)');
await click(pW);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 9000, 150);
const shotWin = await shot('balloons-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, wave: sWin && sWin.wave, sheet: sWin && sWin.sheet, title: sWin && sWin.title, score: sWin && sWin.score, shot: shotWin }));

// ---- 8) R restarts from the win sheet
await keyTap('KeyR', 'r', 82);
await sleep(400);
const sRKey = await st();
T('r-key ' + JSON.stringify({ over: sRKey && sRKey.over, lives: sRKey && sRKey.lives, score: sRKey && sRKey.score, sheet: sRKey && sRKey.sheet, wave: sRKey && sRKey.wave }));

// ---- 9) a live board for the tile art
await ev('window.__balloons.setup({seed:41, wave:3, score:260, balloons:[{a:-1.9,d:3.4,sp:0.5},{a:-1.1,d:4.6,sp:0.5,kind:"swift"},{a:0.5,d:5.0,sp:0.5,kind:"heavy"},{a:2.2,d:4.2,sp:0.5}]})');
await sleep(700);
const sBoard = await st();
const shotBoard = await shot('balloons-gate-board');
T('board ' + JSON.stringify({ balloons: sBoard && sBoard.balloons, kinds: sBoard && sBoard.kinds, score: sBoard && sBoard.score, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 10) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
const touchTap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
};
await ev('window.__balloons.setup({seed:36, balloons:[{a:-1.5708, d:4.2, sp:0},{a:0.4, d:5.0, sp:0}]})');
await sleep(300);
const t0 = await st();
const tp = await ev('window.__balloons.balloonPoint(0)');
const tp2 = await ev('window.__balloons.balloonPoint(1)');
await touchTap(tp);
const t1 = await poll(async () => { const s = await st(); return s && s.pops >= 1 ? s : null; }, 4000, 120);
await touchTap(tp2);
const t2 = await poll(async () => { const s = await st(); return s && s.pops >= 2 ? s : null; }, 4000, 120);
const tpMiss = [tp, tp2].filter((p) => !p || p.x < 4 || p.x > 386 || p.y < 4 || p.y > 840).length;
const shotTouch = await shot('balloons-gate-touch');
T('touch ' + JSON.stringify({ t0Pops: t0 && t0.pops, tp, t1: t1 && t1.pops, tp2, t2: t2 && t2.pops, tpMiss, shots: t2 && t2.shots, inputs: t2 && t2.inputs, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.lives === 5 && s0.wave === 1,
  clockRuns: !!s1 && s1.t > (s0.t || 0) + 0.8 && s1.t < 60,
  waveLive: !!s1 && (s1.balloons > 0 || s1.queued > 0),
  popsOnClick: !!sPop && sPop.pops >= 1 && sPop.score >= 10 && sPop.arrows === 0,
  popPointOnScreen: !!pPop && pPop.x > 60 && pPop.x < 1220 && pPop.y > 40 && pPop.y < 760,
  missCostsShot: !!sEmpty && sEmpty.shots === (preEmpty.shots + 1) && sEmpty.pops === 0,
  heavyNeedsTwo: !!sH1 && sH1.pops === 0 && sH1.balloons === 1 && !!sH2 && sH2.pops === 1 && sH2.score === 20,
  lost: !!sLose && sLose.over === true && sLose.won === false && sLose.lives === 0 && sLose.sheet === true && /overrun/i.test(sLose.title),
  restarted: !!sNew && sNew.over === false && sNew.lives === 5 && sNew.score === 0 && sNew.sheet === false && sNew.wave === 1,
  won: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'clear' && sWin.sheet === true && /arena held/i.test(sWin.title),
  keyRestart: !!sRKey && sRKey.over === false && sRKey.lives === 5 && sRKey.sheet === false && sRKey.score === 0,
  boardLive: !!sBoard && sBoard.balloons === 4 && sBoard.over === false,
  touchPop: !!t1 && t1.pops >= 1,
  touchPop2: !!t2 && t2.pops >= 2,
  touchPointsOnScreen: tpMiss === 0,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, s0, s1, sPop: { pops: sPop && sPop.pops, shots: sPop && sPop.shots, score: sPop && sPop.score }, sEmpty: { shots: sEmpty && sEmpty.shots, pops: sEmpty && sEmpty.pops, blocked: sEmpty && sEmpty.blocked }, sH1: { pops: sH1 && sH1.pops, balloons: sH1 && sH1.balloons }, sH2: { pops: sH2 && sH2.pops, score: sH2 && sH2.score }, sLose, sNew, sWin, sRKey, sBoard: { balloons: sBoard && sBoard.balloons, kinds: sBoard && sBoard.kinds }, t1: t1 && t1.pops, t2: t2 && t2.pops, shots: { boot: shotBoot, pop: shotPop, lose: shotLose, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(failed.length ? 1 : 0);
