#!/usr/bin/env node
// Click-and-play gate for the Li-Ri port: real swipes (CDP mouse + CDP touch), state-hook
// assertions for roll-off, wagon pickup, fence crash, restart and a rigged win, plus a
// portrait-phone framing pass and the tile-art shot. Screenshots land in .queue/playtest/.
// usage: node li-ri-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/li-ri/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const CMD_TIMEOUT = 240000;
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/liri-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
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
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (m) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`page exception in \`${expr.slice(0, 120)}\`: ${String(d).slice(0, 400)}`);
  }
  return r.result?.value;
};
const hook = () => ev('window.__liri ? window.__liri.state() : null');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');

async function shot(name) {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  const out = join(OUT, `li-ri-${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
}
async function poll(fn, want, budgetMs = 30000, label = 'poll') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await fn();
    if (want(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)?.slice(0, 300)}`);
}
async function swipe(x0, y0, x1, y1) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0), y: Math.round(y0), button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(70);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x1), y: Math.round(y1), button: 'left', pointerType: 'mouse' });
  await sleep(60);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
}
async function clickAt(x, y) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(350);
}
async function centre(sel) {
  return ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
}
async function boot() {
  await S('Page.bringToFront').catch(() => {});
  await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await poll(() => ev('!!window.__liri && typeof window.__liri.state === "function" && window.__liri.state().frames > 0'), Boolean, 120000, 'boot hook');
}
const consoleErrors = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => t && !/GPU stall due to ReadPixels/.test(t))
  .slice(0, 5).join(' | ');

const cellsAll = () => ev(`(()=>{const p=[];for(let r=0;r<15;r++)for(let c=0;c<17;c++)p.push(window.__liri.tilePoint(r,c));return p;})()`);

/* ---------------------------------------------------------------- desktop */
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await boot();
const bootState = await hook();
await sleep(500);
const bootCells = await cellsAll();
const bandD = await ev('window.__liri.band()');
const camD = await ev('window.__liri.cam()');
const bootShot = await shot('boot');

function framing(pts, vw, vh, band, label) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const inside = bbox.x0 > 4 && bbox.y0 > 4 && bbox.x1 < vw - 4 && bbox.y1 < vh - 4;
  const inBand = bbox.y0 >= band.topPx - 6 && bbox.y1 <= band.botPx + 6;
  const centred = Math.abs((bbox.x0 + bbox.x1) / 2 - vw / 2) < 0.06 * vw &&
    Math.abs((bbox.y0 + bbox.y1) / 2 - (band.topPx + band.botPx) / 2) < 0.10 * vh;
  return { label, bbox, inside, inBand, centred, wFrac: (bbox.x1 - bbox.x0) / vw, hFrac: (bbox.y1 - bbox.y0) / vh };
}
const frameD = framing(bootCells, 1280, 800, bandD, 'desktop');
mark(`desktop boot ok frames=${bootState.frames} framed=${frameD.inside}/${frameD.inBand}/${frameD.centred} wFrac=${frameD.wFrac.toFixed(2)}`);

// 1) the top-bar New run button: a real click on an idle board keeps it idle and clean
const newBtn = await centre('#new');
await clickAt(newBtn.x, newBtn.y);
const cleared = await poll(hook, (h) => !h.running && !h.over && h.collected === 0 && h.freeCount === 7, 8000, 'new-run reset');

// 2) a real mouse swipe to the right rolls the engine off the platform
await swipe(640, 430, 800, 428);
const rolled = await poll(hook, (h) => h && h.running, 8000, 'engine rolls on swipe');
const dirAfterSwipe = rolled.dir;

// 3) it keeps rolling and hooks the wagon parked straight ahead
const picked = await poll(hook, (h) => h.collected >= 1, 25000, 'wagon hooked by rolling');
const pickupShot = await shot('pickup');
mark(`pickup collected=${picked.collected} len=${picked.len} free=${picked.freeCount}`);

// 4) rigged approach to the north fence: a real swipe north must turn it and the fence must end the run
await ev(`window.__liri.setup({ body: [[4,8]], dir: 'right', wagons: [[3,3],[11,3],[3,13],[11,13],[1,8],[13,8]], collected: 1, score: 10 })`);
await sleep(300);
const riggedCrash = await hook();
await swipe(640, 430, 638, 300);
const turned = await poll(hook, (h) => h.dir === 'up', 8000, 'swipe turns north');
const crashed = await poll(hook, (h) => h.over, 25000, 'fence crash');
await sleep(600);
const overOpen = await ev(`document.getElementById('over').classList.contains('open')`);
const overTitle = await ev(`document.getElementById('overTitle').textContent`);
const overText = await ev(`document.getElementById('overText').textContent`);
const loseShot = await shot('lose');
mark(`crashed why=${crashed.why} steps=${crashed.steps} sheet=${overOpen} title=${overTitle}`);

// 4) the end sheet's own button restarts through a real click
const btn = await centre('#overBtn');
await clickAt(btn.x, btn.y);
const restarted = await poll(hook, (h) => !h.over && !h.running && h.collected === 0, 8000, 'restart from sheet');

// 5) rigged win: six wagons on, the seventh three cells ahead
await ev(`window.__liri.setup({ body: [[10,2]], dir: 'right', wagons: [[10,5]], collected: 6, score: 60 })`);
await sleep(300);
const rigged = await hook();
await swipe(640, 430, 800, 428);
const win = await poll(hook, (h) => h.won === true, 20000, 'rigged win');
await sleep(600);
const winShot = await shot('win');
mark(`win won=${win.won} collected=${win.collected} score=${win.score}`);

// 6) art plate: a short train in the yard with wagons still standing
await ev(`window.__liri.setup({ body: [[7,2],[7,1],[8,1]], dir: 'right', wagons: [[7,6],[3,3],[11,8],[3,13],[11,13],[13,8]], collected: 1, score: 10 })`);
await sleep(900);
const artShot = await shot('art');

/* ---------------------------------------------------------------- portrait */
mark('portrait leg start');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await boot();
await sleep(500);
await ev('window.__liri.reset()');
await sleep(300);
const phoneCells = await cellsAll();
const bandP = await ev('window.__liri.band()');
const frameP = framing(phoneCells, 390, 844, bandP, 'phone');
const phoneShot = await shot('phone');
mark(`phone framed=${frameP.inside}/${frameP.inBand}/${frameP.centred} wFrac=${frameP.wFrac.toFixed(2)} hFrac=${frameP.hFrac.toFixed(2)}`);

// a real touch swipe north, with the id + dwell the CDP touch path needs
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 560, id: 1 }] });
await sleep(90);
await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 430, id: 1 }] });
await sleep(70);
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const touchMoved = await poll(hook, (h) => h && (h.dir === 'up' || h.lastUp), 8000, 'phone touch swipe');
const touchShot = await shot('phone-touch');

const diag = await ev('window.__liri.diag()');
const bandP2 = await ev('window.__liri.band()');

const checks = {
  bootHook: !!bootState && bootState.frames > 0,
  bootIdleSafe: bootState && bootState.running === false && bootState.over === false && bootState.collected === 0,
  bootYard: bootState && bootState.total === 7 && bootState.freeCount === 7 && bootState.len === 1 &&
    bootState.head[0] === 7 && bootState.head[1] === 2 && bootState.dir === 'right',
  desktopFramed: frameD.inside && frameD.inBand && frameD.centred && frameD.wFrac > 0.55,
  swipeRolls: rolled.running === true && dirAfterSwipe === 'right' && rolled.lastUp && rolled.lastUp.moved > 24,
  wagonHooked: picked.collected >= 1 && picked.score >= 10 && picked.len >= 2 && picked.freeCount === 6,
  newRunClears: cleared.collected === 0 && cleared.freeCount === 7 && cleared.len === 1 && !cleared.running,
  riggedYard: riggedCrash.len === 1 && riggedCrash.freeCount === 6 && riggedCrash.head[0] === 4,
  swipeTurns: turned.dir === 'up',
  fenceEnds: crashed.over === true && crashed.won === false && crashed.why === 'wall',
  sheetShows: overOpen === true && /Derailed/.test(overTitle),
  restart: restarted.over === false && restarted.collected === 0 && restarted.len === 1 && restarted.freeCount === 7,
  riggedSetup: rigged.collected === 6 && rigged.freeCount === 1 && rigged.len === 1,
  winReachable: win.won === true && win.over === true && win.collected === 7 && win.score >= 70,
  phoneFramed: frameP.inside && frameP.inBand && frameP.centred && frameP.wFrac > 0.62,
  phoneTouch: touchMoved.dir === 'up' && touchMoved.running === true,
  noGlErrors: diag && diag.glErr === 0 && diag.frames > 0,
  noErrors: !consoleErrors(),
  bandSane: bandP.topPx > 40 && bandP2.botPx > 600,
};

console.log(JSON.stringify({
  checks,
  errors: consoleErrors(),
  boot: { running: bootState?.running, total: bootState?.total, free: bootState?.freeCount, cam: camD, band: bandD },
  frameD, frameP,
  rolled: { dir: rolled.dir, lastUp: rolled.lastUp },
  picked: { collected: picked.collected, score: picked.score, len: picked.len, free: picked.freeCount },
  cleared: { collected: cleared.collected, free: cleared.freeCount, running: cleared.running },
  crashed: { why: crashed.why, over: crashed.over, steps: crashed.steps, head: crashed.head },
  overTitle, overText, restarted: { over: restarted.over, len: restarted.len, free: restarted.freeCount },
  win: { won: win.won, collected: win.collected, score: win.score, steps: win.steps },
  phone: { dir: touchMoved.dir, running: touchMoved.running, lastUp: touchMoved.lastUp, band: bandP },
  diag,
  shots: { bootShot, pickupShot, loseShot, winShot, artShot, phoneShot, touchShot },
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
