#!/usr/bin/env node
// Interaction gate for the OpenSGolf port.
// Serves the deployed site tree, drives headless Chromium with real CDP mouse / key / touch input,
// and asserts through the page's own state hook that a swing moves the ball, that the score moves,
// that a hole is really holed out, that the round reaches its scorecard, and that R restarts it.
// A canvas that merely exists is not proof, and neither is a swing helper called from the outside:
// every assertion below is downstream of a dispatched input event.
//
// usage: node scripts/opensgolf-gate.mjs [site-root]   (default ~/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
// This box thrashes under memory pressure: chromium has taken >100 s to boot and Page.navigate has
// needed >40 s. Never assume a fast machine.
const CMD_TIMEOUT = Number(process.env.GATE_CMD_TIMEOUT || 240000);
const ROOT = resolve(process.argv[2] || join(homedir(), 'kaos/work/site'));
const PATH = '/games/arcade/opensgolf/';
const OUT = join(homedir(), 'cloned-free-games/.queue/playtest');
const CERR = '/tmp/golfgate-chromium.log';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(2); }
const PROFILE = mkdtempSync('/tmp/golf-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools after ' + CMD_TIMEOUT + 'ms: ' + err.slice(-300))), CMD_TIMEOUT);
  proc.stderr.on('data', (d) => { err += d; appendFile(CERR, d).catch(() => {}); const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
  // this box's chromium shim prints no banner; it only writes <profile>/DevToolsActivePort
  const tick = setInterval(async () => {
    try {
      const [p, wsPath] = (await readFile(join(PROFILE, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (!p || !wsPath) return;
      clearInterval(tick); clearTimeout(t);
      ok('ws://127.0.0.1:' + p.trim() + wsPath.trim());
    } catch { /* not up yet */ }
  }, 250);
});
const server = await serve();
const port = server.address().port;
T('serving ' + port + ' root ' + ROOT);

let finished = false;
const bail = (e) => {
  if (finished) return; finished = true;
  console.error('GATE ERROR ' + ((e && e.stack) || e));
  try { proc.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  process.exit(3);
};
process.on('unhandledRejection', bail);
process.on('SIGINT', () => bail(new Error('interrupted')));
process.on('SIGTERM', () => bail(new Error('terminated')));

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

const errors1 = [];
pageCdp.ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === 'Runtime.exceptionThrown') errors1.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception');
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors1.push(msg.params.entry.text);
});

// never trust a fixed settle time on this box: poll for the game hook instead
const booted = async () => {
  const t0 = Date.now();
  for (;;) {
    let up = false;
    try { up = (await ev('typeof window.__golf === "function" && !!window.__golf()')) === true; } catch { up = false; }
    if (up) break;
    if (Date.now() - t0 > CMD_TIMEOUT) throw new Error('page never booted in ' + (Date.now() - t0) + 'ms');
    await sleep(1000);
  }
  T('page booted in ' + (Date.now() - t0) + 'ms');
  await sleep(2000);
};
await S('Page.navigate', { url: `http://127.0.0.1:${port}${PATH}` });
await booted();

const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

const VK = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, KeyR: 82, Escape: 27 };
const keyChar = (code) => (code === 'Space' ? ' ' : code === 'KeyR' ? 'r' : code);
const key = async (code, mods = 0) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyChar(code), windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code], modifiers: mods });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyChar(code), windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code], modifiers: mods });
};

const mouseDrag = async (from, dx, dy, steps = 8) => {
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i++) {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (dx * i) / steps), y: Math.round(from.y + (dy * i) / steps), button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(12);
  }
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(from.x + dx), y: Math.round(from.y + dy), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
};

const touchDrag = async (from, dx, dy, steps = 10) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(from.x + (dx * i) / steps), y: Math.round(from.y + (dy * i) / steps), id: 1 }] });
    await sleep(14);
  }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

const hook = async () => {
  const st = await ev('window.__golf()');
  if (st && st.__err) throw new Error('hook threw: ' + st.__err);
  return st;
};
const waitPhase = async (want, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await hook();
    if (want.includes(st.phase)) return st;
    if (Date.now() - t0 > ms) {
      // dump what the page thinks before dying: a bare timeout tells us nothing
      const extra = await ev('window.__golf()');
      const bp = await ev('window.__golf.ballPoint()');
      await shot('opensgolf-gate-stuck').catch(() => {});
      throw new Error('phase never became ' + want.join('|') + ' after ' + ms + 'ms :: ' +
        JSON.stringify({ last: st.phase, state: extra, ballPoint: bp, errors: errors1.slice(-4) }));
    }
    await sleep(140);
  }
};

// ---------------- 1) boot ----------------
const hookType = await ev('typeof window.__golf');
const s0 = await hook();
const holesMeta = await ev('window.__golf.holes()');
const geo = await ev(`(()=>{
  const b = window.__golf.ballPoint(), p = window.__golf.pinPoint();
  const top = document.querySelector('.top').getBoundingClientRect().bottom;
  const bot = document.querySelector('.bottom').getBoundingClientRect().top;
  return { b, p, top, bot, w: innerWidth, h: innerHeight };
})()`);
const shotBoot = await shot('opensgolf-gate-boot');

// ---------------- 2) keyboard aim precision ----------------
const aim0 = (await hook()).aim;
await key('ArrowRight');
const aimR = (await hook()).aim;
await key('ArrowLeft');
const aimBack = (await hook()).aim;
const pow0 = (await hook()).power;
for (let i = 0; i < 5; i++) await key('ArrowUp');
const powUp = (await hook()).power;

// ---------------- 3) a real mouse drag swings the ball ----------------
const c0 = await ev('window.__golf.counters()');
const bp = await ev('window.__golf.ballPoint()');
// a bare tap (no drag) must NOT swing: that would mean the page fires on pointerdown
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp.x, y: bp.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp.x, y: bp.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
await sleep(250);
const sTap = await hook();
const before = sTap;                       // ball still on the tee, one frame before the drag
// now drag back ~120 px: a mid-iron that lands short of the pin, so the ball demonstrably travels
await mouseDrag(bp, 0, 120, 10);
await sleep(300);
const sDrag = await hook();
const c1 = await ev('window.__golf.counters()');
const shotDuring = await shot('opensgolf-gate-swing');
const settled1 = await waitPhase(['aim', 'holed']);
const sSettled = settled1.phase === 'holed' ? settled1 : await hook();

// ---------------- 4) auto-play the round through the keyboard ----------------
async function playHole(label) {
  const trace = [];
  const start = await hook();
  for (let n = 0; n < 12; n++) {
    let st = await hook();
    if (st.phase === 'holed' || st.phase === 'over') return { trace, st };
    if (st.phase !== 'aim') { st = await waitPhase(['aim', 'holed', 'over']); if (st.phase !== 'aim') return { trace, st }; }

    const P = await ev('window.__golf.physics()');
    const dx = st.pin.x - st.ball.x, dz = st.pin.z - st.ball.z;
    const d = Math.hypot(dx, dz);
    const wantDeg = Math.atan2(dx, -dz) * 180 / Math.PI;
    const delta = ((wantDeg - st.aim + 540) % 360) - 180;
    const presses = Math.round(delta / 0.5);
    for (let k = 0; k < Math.abs(presses); k++) await key(presses > 0 ? 'ArrowRight' : 'ArrowLeft');

    const a = P.fric[st.surface] || P.fric.fairway;
    const wantP = Math.max(0, Math.min(1, Math.round(((Math.sqrt(2 * a * Math.max(0.6, d)) - P.base) / P.span) * 100) / 100));
    const dp = Math.round((wantP - (await hook()).power) / 0.01);
    for (let k = 0; k < Math.abs(dp); k++) await key(dp > 0 ? 'ArrowUp' : 'ArrowDown');

    const lined = await hook();
    await key('Space');
    await sleep(220);
    const mid = await hook();
    trace.push({ hole: st.hole, from: [st.ball.x, st.ball.z], surface: st.surface, aim: lined.aim, wantDeg: +wantDeg.toFixed(2), power: lined.power, wantP, strokes: mid.strokes, phase: mid.phase });
    if (mid.phase === 'roll') {
      const done = await waitPhase(['aim', 'holed', 'over'], 60000);
      if (done.phase === 'holed') { await shot('opensgolf-gate-holed'); return { trace, st: done }; }
      if (done.phase === 'over') return { trace, st: done };
    } else if (mid.phase === 'holed') {
      await shot('opensgolf-gate-holed');
      return { trace, st: mid };
    }
  }
  return { trace, st: await hook() };
}

const hole1 = await playHole('hole 1');
const afterH1 = await waitPhase(['aim', 'over'], 20000);   // 1.5 s banner, then hole 2
const hole2 = await playHole('hole 2');
const afterH2 = await waitPhase(['aim', 'over'], 20000);
const hole3 = await playHole('hole 3');
const afterH3 = await waitPhase(['over', 'aim'], 20000);
await sleep(1200);
const sOver = await hook();
const sheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent,rows:document.querySelectorAll('#card tr').length}))()`);
const shotOver = await shot('opensgolf-gate-scorecard');

// ---------------- 5) R restarts the round ----------------
await key('KeyR');
await sleep(500);
const sNew = await hook();
const sheetClosed = await ev(`document.getElementById('over').classList.contains('open')`);

// ---------------- 6) portrait touch: a finger drag must swing too ----------------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(700);
const pGeo = await ev(`(()=>{
  const b = window.__golf.ballPoint(), p = window.__golf.pinPoint();
  const top = document.querySelector('.top').getBoundingClientRect().bottom;
  const bot = document.querySelector('.bottom').getBoundingClientRect().top;
  return { b, p, top, bot, w: innerWidth, h: innerHeight };
})()`);
const pShot0 = await shot('opensgolf-gate-portrait');
const pc0 = await ev('window.__golf.counters()');
const pb = await ev('window.__golf.ballPoint()');
const preTouch = await hook();
await touchDrag(pb, 0, 200, 12);
await sleep(400);
const sTouch = await hook();
const pc1 = await ev('window.__golf.counters()');
const pShot1 = await shot('opensgolf-gate-touch');
const touchSettled = await waitPhase(['aim', 'holed'], 60000);
await S('Emulation.setTouchEmulationEnabled', { enabled: false });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const errors2 = errors1.slice();

const inFrame = (pt, g) => !!pt && pt.x > 2 && pt.x < g.w - 2 && pt.y > g.top && pt.y < g.bot && pt.z > -1 && pt.z < 1;
const movedBy = (a, b) => Math.hypot(a.ball.x - b.ball.x, a.ball.z - b.ball.z);

const checks = {
  boot: hookType === 'function' && !!s0 && s0.holes === 3 && s0.hole === 1 && s0.par === 3 &&
    s0.strokes === 0 && s0.phase === 'aim' && s0.over === false && s0.dist > 40,
  course: !!holesMeta && holesMeta.length === 3 && holesMeta.map((h) => h.par).join('') === '345' &&
    holesMeta.every((h) => h.len > 30),
  cameraFit: inFrame(geo.b && geo.b, geo) && inFrame(geo.p && geo.p, geo),
  keyAim: Math.abs(aimR - aim0 - 0.5) < 0.06 && Math.abs(aimBack - aim0) < 0.06,
  keyPower: powUp > pow0 + 0.03 && powUp <= 1,
  tapAloneDoesNotSwing: sTap.strokes === 0 && sTap.phase === 'aim' && Math.abs(movedBy(sTap, s0)) < 0.01,
  dragSwingStarts: sDrag.strokes === 1 && sDrag.phase === 'roll' && c1.down === c0.down + 2 && c1.up === c0.up + 2 && c1.swings === c0.swings + 1,
  dragMovesBall: movedBy(sSettled, before) > 8 && sSettled.dist < before.dist - 5,
  hole1Holed: hole1.trace.length >= 1 && hole1.trace.length <= 10 && hole1.st.pickedUp === false &&
    (hole1.st.phase === 'holed' || hole1.st.phase === 'over') && hole1.st.cards[0].done === true,
  hole2Played: !!afterH1 && (afterH1.hole === 2 || afterH1.phase === 'over') &&
    hole2.st.cards[1].done === true && hole2.st.pickedUp === false && hole2.trace.length <= 10,
  hole3Played: !!afterH2 && hole3.st.cards[2].done === true && hole3.st.pickedUp === false && hole3.trace.length <= 10,
  roundCompletes: sOver.phase === 'over' && sOver.over === true && sheet.open === true &&
    /par|complete/i.test(sheet.title) && sheet.rows === 5 && sOver.cards.every((c) => c.done),
  scoringAddsUp: sOver.total === sOver.cards.reduce((n, c) => n + c.strokes, 0) &&
    sOver.toPar === sOver.total - sOver.cards.reduce((n, c) => n + c.par, 0) && sOver.cash > 0,
  restartWorks: sNew.phase === 'aim' && sNew.hole === 1 && sNew.strokes === 0 && sNew.total === 0 &&
    sNew.over === false && sheetClosed === false,
  portraitFit: inFrame(pGeo && pGeo.b, pGeo) && inFrame(pGeo && pGeo.p, pGeo),
  touchSwings: sTouch.strokes === 1 && sTouch.phase === 'roll' && pc1.down > pc0.down && pc1.up > pc0.up &&
    pc1.swings === pc0.swings + 1 && movedBy(touchSettled, preTouch) > 5,
  noErrors: errors2.length === 0,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0, holesMeta, geo,
  aim0, aimR, aimBack, pow0, powUp, c0, c1,
  sTap: { strokes: sTap.strokes, phase: sTap.phase, ball: sTap.ball },
  sDrag: { strokes: sDrag.strokes, phase: sDrag.phase, ball: sDrag.ball },
  sSettled: { strokes: sSettled.strokes, phase: sSettled.phase, ball: sSettled.ball, dist: sSettled.dist },
  hole1: hole1.trace, hole2: hole2.trace, hole3: hole3.trace,
  sOver: { hole: sOver.hole, phase: sOver.phase, total: sOver.total, toPar: sOver.toPar, cash: sOver.cash, cards: sOver.cards },
  sheet,
  sNew: { hole: sNew.hole, strokes: sNew.strokes, phase: sNew.phase, over: sNew.over },
  pGeo, pc0, pc1, sTouch: { strokes: sTouch.strokes, phase: sTouch.phase, ball: sTouch.ball },
  shots: [shotBoot, shotDuring, shotOver, pShot0, pShot1],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
finished = true;
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
