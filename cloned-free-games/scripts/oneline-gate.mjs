#!/usr/bin/env node
// Interaction gate for the One Line port: real in-frame pointer events on the board, state read
// from the page's own hook. Proves wrong-start refusal, a full winning stroke laid by real drags,
// restart, back-up, a walled-in (stuck) position and a portrait touch drag.
// usage: node oneline-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = '/games/arcade/one-line-puzzle/';
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
const PROFILE = mkdtempSync('/tmp/oneline-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400) };
  return r.result?.value;
};
await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const URL0 = `http://127.0.0.1:${port}${PAGE}`;
await S('Page.navigate', { url: URL0 });
await sleep(4500);

async function waitHook(ms = 12000) {
  for (let i = 0; i < ms / 400; i++) {
    if (await ev('typeof window.__oneline === "function"')) return true;
    await sleep(400);
  }
  return false;
}
const hookOk = await waitHook();
T('hook ' + (hookOk ? 'live' : 'MISSING'));
const st = () => ev('window.__oneline && window.__oneline()');
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  mkdirSync(OUT, { recursive: true });
  const f = `${OUT}/${name}`;
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
};

// in-frame gestures: pointer events built inside the page (CDP Input never reaches the game)
const mk = (type) => `pointerType:${JSON.stringify(type)}`;
async function drag(cells, type = 'mouse') {
  return ev(`(() => {
    const w = window, cv = w.document.querySelector('canvas');
    const cells = ${JSON.stringify(cells)};
    const pt = (r, c) => w.__oneline.tilePoint(r, c);
    const mkE = (t, x, y, b) => new w.PointerEvent(t, { pointerId: 1, pointerType: '${type}', isPrimary: true,
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: b });
    const a = pt(cells[0][0], cells[0][1]);
    cv.dispatchEvent(mkE('pointerdown', a.x, a.y, 1));
    for (let i = 1; i < cells.length; i++) {
      const p = pt(cells[i][0], cells[i][1]);
      cv.dispatchEvent(mkE('pointermove', p.x, p.y, 1));
    }
    const z = pt(cells[cells.length - 1][0], cells[cells.length - 1][1]);
    cv.dispatchEvent(mkE('pointerup', z.x, z.y, 0));
    return w.__oneline();
  })()`);
}
async function tap(r, c, type = 'mouse') {
  return ev(`(() => {
    const w = window, cv = w.document.querySelector('canvas');
    const p = w.__oneline.tilePoint(${r}, ${c});
    const mkE = (t, x, y, b) => new w.PointerEvent(t, { pointerId: 2, pointerType: '${type}', isPrimary: true,
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: b });
    cv.dispatchEvent(mkE('pointerdown', p.x, p.y, 1));
    cv.dispatchEvent(mkE('pointerup', p.x, p.y, 0));
    return w.__oneline();
  })()`);
}
async function clickSel(sel) {
  const box = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!box) return null;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await S('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  }
  await sleep(700);
  return box;
}

const checks = {};
const boot = await st();
checks.bootHook = !!(boot && boot.filled === 0 && boot.over === false && boot.level === 0 && boot.cells === 25);
const shotBoot = await shot('oneline-boot.png');

// 1. a wrong start cell (holds 3, not 1) must be refused
const wrong = await tap(0, 0);
checks.refusesWrongStart = !!(wrong && wrong.filled === 0 && wrong.blocked >= 1 && wrong.over === false);

// 2. lay the stored winning stroke with real down/move.../up events
const sol = await ev('window.__oneline.solution()');
const wonState = await drag(sol);
await sleep(600);
checks.winByRealDrag = !!(wonState && wonState.won === true && wonState.over === true && wonState.filled === 25 && wonState.done === true);
checks.winSheet = await ev('document.getElementById("over").classList.contains("open") && document.getElementById("overTitle").textContent');
const shotWin = await shot('oneline-win.png');

// 3. the win sheet's Play again button clears the board
await clickSel('#overBtn');
const afterRestart = await st();
checks.restartWorks = !!(afterRestart && afterRestart.filled === 0 && afterRestart.over === false && afterRestart.won === false);

// 4. a partial drag then Back must retract one cell
const part = await drag(sol.slice(0, 8));
const backBox = await clickSel('#back');
const afterBack = await st();
checks.dragLaysLine = !!(part && part.filled === 8 && part.over === false);
checks.backUndoes = !!(afterBack && afterBack.filled === 7);

// 5. walled-in position -> stuck sheet (QA position, then real Back click recovers)
const stuckState = await ev('window.__oneline.setup([[4,1],[3,1],[3,0],[4,0]]) && window.__oneline()');
await sleep(300);
checks.stuckState = !!(stuckState && stuckState.stuck === true && stuckState.over === true && stuckState.filled === 4);
checks.stuckSheet = await ev('document.getElementById("over").classList.contains("open") && document.getElementById("overTitle").textContent');
const shotStuck = await shot('oneline-stuck.png');
await clickSel('#overBack');
const afterStuckBack = await st();
checks.stuckBackRecovers = !!(afterStuckBack && afterStuckBack.over === false && afterStuckBack.stuck === false && afterStuckBack.filled === 3);

// 6. level switch rebuilds (7x7 hard)
const lvl = await ev('window.__oneline.level(4) && window.__oneline()');
checks.levelSwitch = !!(lvl && lvl.n === 7 && lvl.m === 7 && lvl.cells === 49 && lvl.filled === 0);

// 7. portrait touch: a finger drag must lay cells on a 390x844 viewport
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: URL0 });
await sleep(4000);
await waitHook();
const pSol = await ev('window.__oneline.solution()');
const touchState = await drag(pSol.slice(0, 12), 'touch');
checks.portraitTouch = !!(touchState && touchState.filled >= 10 && touchState.over === false);
const inFrame = await ev('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()');
const shotPortrait = await shot('oneline-portrait.png');

const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => (e.params.exceptionDetails?.exception?.description || '').slice(0, 200)).slice(0, 4);
checks.noErrors = errors.length === 0;

const ok = Object.values(checks).every((v) => v === true || (typeof v === 'string' && v.length > 0));
console.log(JSON.stringify({ checks, boot, afterRestart, part, afterBack, stuckState, touchState, inFrame, errors,
  shots: { boot: shotBoot, win: shotWin, stuck: shotStuck, portrait: shotPortrait } }, null, 1));
console.log(ok ? 'ONELINE GATE PASS' : 'ONELINE GATE FAIL');
cdp.ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(ok ? 0 : 1);
