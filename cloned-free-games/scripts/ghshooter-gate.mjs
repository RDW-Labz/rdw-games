#!/usr/bin/env node
// Interaction gate for the GitHub Space Shooter port (GitHub Space Shooter card,
// czl9707/gh-space-shooter, MIT): real CDP mouse / keyboard / touch on the shipped page, state-hook
// assertions for steering, the tap shot, a real square cleared, the bomb loss, the graph-landing
// loss, the full clear win, restart, plus a 390x844 portrait pass. A canvas that merely exists is
// not a pass.
//
// usage: node ghshooter-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/gh-space-shooter/index.html';
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
const PROFILE = mkdtempSync('/tmp/ghss-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  // headless treats the page as hidden and throttles timers to 1 Hz, which would slow the port's
  // wall-clock pump to a crawl and make a live game read as frozen
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
  await sleep(200);
};
const st = () => ev('window.__gh()');
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

// ---- 1) boot: the hook is a function, the graph is dealt and sliding on the wall clock
const hookType = await ev('typeof window.__gh');
const s0 = await st();
await sleep(1600);
const s1 = await st();
const shotBoot = await shot('ghss-gate-boot');
T('boot ' + JSON.stringify({ hookType, cells: s0 && s0.cells, drop0: s0 && s0.drop, drop1: s1 && s1.drop, t1: s1 && s1.t, lives: s1 && s1.lives, score: s1 && s1.score }));
T('bootShot ' + shotBoot);

// ---- 2) a real pointer click steers the rocket, and the tap stings
const pL = await ev('window.__gh.colPoint(-1.8)');
const frame = await ev('(()=>{const g=window.__gh.gridPoint;const a=g(0,0),b=g(5,10),c=g(5,0),d=g(0,10);return {tl:a,br:b,bl:c,tr:d};})()');
await click(pL);
const sL = await poll(async () => { const s = await st(); return s && s.shipX < -1.0 ? s : null; }, 5000, 150);
const pR = await ev('window.__gh.colPoint(1.8)');
await click(pR);
const sR = await poll(async () => { const s = await st(); return s && s.shipX > 1.0 ? s : null; }, 5000, 150) || await st();
T('steer ' + JSON.stringify({ pL, sL: { x: sL && sL.shipX, inputs: sL && sL.inputs }, pR, sR: { x: sR && sR.shipX, inputs: sR && sR.inputs, taps: sR && sR.taps, shots: sR && sR.shots } }));

// ---- 3) keyboard A / D nudges the aim (relative to wherever the rocket is)
await ev('window.__gh.setup({ cells: [[0,0,1],[0,10,1]], px: 0 })');
await sleep(200);
await keyTap('KeyA', 'a', 65);
await sleep(150);
const sA = await st();
await keyTap('KeyD', 'd', 68);
await sleep(150);
const sD1 = await st();
await keyTap('KeyD', 'd', 68);
await sleep(150);
const sD = await st();
T('keys ' + JSON.stringify({ aimA: sA && sA.aimX, aimD1: sD1 && sD1.aimX, aimD: sD && sD.aimX, inputs: sD && sD.inputs }));

// ---- 4) a contribution square on the firing line is really shot out of the sky
await ev('window.__gh.setup({ cells: [[5,5,1],[0,0,1]], px: 0 })');
await sleep(200);
const preKill = await st();
const sKill = await poll(async () => { const s = await st(); return s && s.cleared >= 1 ? s : null; }, 6000, 120);
T('kill ' + JSON.stringify({ preCells: preKill && preKill.cells, preShots: preKill && preKill.shots, cleared: sKill && sKill.cleared, cells: sKill && sKill.cells, score: sKill && sKill.score, shots: sKill && sKill.shots }));
const shotMid = await shot('ghss-gate-mid');
T('midShot ' + shotMid);

// ---- 5) loss by bomb: one life left, a commit bomb already on the rocket
await ev('window.__gh.setup({ cells: [[0,0,1],[0,10,1]], lives: 1, px: 0, bombs: [{ x: 0, y: 0.62 }] })');
await sleep(200);
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 5000, 120);
const shotLose = await shot('ghss-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, lives: sLose && sLose.lives, sheet: sLose && sLose.sheet, title: sLose && sLose.title, shot: shotLose }));

// ---- 6) restart from the end sheet, on the sheet's own button
const rBtn = await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ btn: rBtn, over: sNew && sNew.over, lives: sNew && sNew.lives, score: sNew && sNew.score, cells: sNew && sNew.cells, sheet: sNew && sNew.sheet }));

// ---- 7) loss by landing: the graph slides onto the rocket
await ev('window.__gh.setup({ cells: [[5,0,1],[5,10,1]], lives: 3, px: 0, drop: 2.9 })');
await sleep(200);
const sLand = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 6000, 150);
T('landing ' + JSON.stringify({ over: sLand && sLand.over, won: sLand && sLand.won, why: sLand && sLand.why, lowest: sLand && sLand.lowest, title: sLand && sLand.title }));

// ---- 8) win: the last square cleared
await ev('window.__gh.setup({ cells: [[5,5,1]], px: 0 })');
await sleep(200);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 8000, 150);
const shotWin = await shot('ghss-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, sheet: sWin && sWin.sheet, title: sWin && sWin.title, score: sWin && sWin.score, shot: shotWin }));

// ---- 9) R restarts from the win sheet
await keyTap('KeyR', 'r', 82);
await sleep(350);
const sRKey = await st();
T('r-key ' + JSON.stringify({ over: sRKey && sRKey.over, lives: sRKey && sRKey.lives, score: sRKey && sRKey.score, cells: sRKey && sRKey.cells, sheet: sRKey && sRKey.sheet }));

// ---- 10) a live board for the tile art
await ev('window.__gh.setup({ cells: [[1,2,2],[2,4,3],[3,6,1],[4,8,4],[5,3,2],[5,7,1]], px: 0.4, drop: 0.9 })');
await sleep(500);
const sBoard = await st();
const shotBoard = await shot('ghss-gate-board');
T('board ' + JSON.stringify({ cells: sBoard && sBoard.cells, lowest: sBoard && sBoard.lowest, shot: shotBoard }));

const errors1 = consoleErrors();

// ---- 11) portrait touch: 390x844 phone, finger steers and a finger tap clears a square
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
const touchTap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
};
const t0 = await st();
const tpL = await ev('window.__gh.colPoint(-1.6)');
await touchTap(tpL);
const t1 = await poll(async () => { const s = await st(); return s && s.shipX < -1.0 ? s : null; }, 5000, 150) || await st();
const tpR = await ev('window.__gh.colPoint(1.6)');
await touchTap(tpR);
const t2 = await poll(async () => { const s = await st(); return s && s.shipX > 1.0 ? s : null; }, 5000, 150) || await st();
const tpMiss = [tpL, tpR].filter((p) => !p || p.x < 4 || p.x > 386 || p.y < 4 || p.y > 840).length;
await ev('window.__gh.setup({ cells: [[5,5,1],[0,0,1]], px: 0 })');
await sleep(160);
const tpKill = await poll(async () => { const s = await st(); return s && s.cleared >= 1 ? s : null; }, 5000, 120);
const shotTouch = await shot('ghss-gate-touch');
T('touch ' + JSON.stringify({ t0: t0 && t0.shipX, tpL, t1: t1 && t1.shipX, tpR, t2: t2 && t2.shipX, inputs: t2 && t2.inputs, tpMiss, cleared: tpKill && tpKill.cleared, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.lives === 3,
  clockRuns: !!s1 && s1.t > (s0.t || 0) + 0.6 && s1.t < 60,
  graphDealt: !!s1 && s1.cells >= 35 && s1.heat >= s1.cells,
  graphSlides: !!s1 && s1.drop > (s0.drop || 0) + 0.02,
  steerLeft: !!sL && sL.shipX < -1.0 && sL.inputs >= 1,
  steerRight: !!sR && sR.shipX > 1.0 && sR.inputs >= 2,
  tapStings: !!sR && sR.shots >= 1 && sR.taps >= 2,
  aimPointsOnScreen: !!pL && pL.x > 60 && pL.x < 620 && pL.y > 40 && pL.y < 740 &&
    !!pR && pR.x > 660 && pR.x < 1220 && pR.y > 40 && pR.y < 740,
  keysSteer: !!sA && sA.aimX <= -0.8 && !!sD && sD.aimX >= 0.8,
  frameOnScreen: !!frame && [frame.tl, frame.br, frame.bl, frame.tr].every((p) => p && p.x >= 40 && p.x <= 1240 && p.y >= 24 && p.y <= 760),
  squareCleared: !!sKill && sKill.cleared >= 1 && sKill.cells === 1 && sKill.score >= 10 && sKill.shots >= 1,
  bombLoss: !!sLose && sLose.over === true && sLose.won === false && sLose.lives === 0 && sLose.sheet === true && /run over/i.test(sLose.title),
  restarted: !!sNew && sNew.over === false && sNew.lives === 3 && sNew.score === 0 && sNew.sheet === false && sNew.cells >= 35,
  landingLoss: !!sLand && sLand.over === true && sLand.won === false && /graph/i.test(sLand.why || ''),
  won: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'cleared' && sWin.sheet === true && /graph cleared/i.test(sWin.title),
  keyRestart: !!sRKey && sRKey.over === false && sRKey.lives === 3 && sRKey.sheet === false,
  boardLive: !!sBoard && sBoard.cells >= 4 && sBoard.cells <= 6 && sBoard.over === false,
  touchLeft: !!t1 && t1.shipX < -1.0 && t1.inputs >= 1,
  touchRight: !!t2 && t2.shipX > 0.3,
  touchPointsOnScreen: tpMiss === 0,
  touchCleared: !!tpKill && tpKill.cleared >= 1,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, errors1, errors2, s0, s1, sL, sR, sA: { aimX: sA && sA.aimX }, sD: { aimX: sD && sD.aimX }, sKill, sLose, sNew, sLand, sWin, sRKey, sBoard, shots: { boot: shotBoot, mid: shotMid, lose: shotLose, win: shotWin, board: shotBoard, touch: shotTouch } }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(failed.length ? 1 : 0);
