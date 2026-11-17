#!/usr/bin/env node
// Interaction gate for the Go To Sleep port (com.kaeruct.gotosleep card):
// real CDP pointer + touch on the pasture, state-hook assertions for count / sleepiness /
// asleep / wide-awake / restart / double-dispatch guard, plus portrait framing.
// usage: node gotosleep-gate.mjs <site-root>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/go-to-sleep/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/zzz-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-30));
const server = await serve();
const port = server.address().port;
T('serving ' + port + ' root ' + ROOT);
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const cdpEvents = () => pageCdp.events;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const URL_ = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url: URL_ });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(150);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `gotosleep-gate-${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot
const s0 = await ev('window.__gotosleep()');
const hookType = await ev('typeof window.__gotosleep');
const shimOk = await ev(`fetch('${URL_}'.replace('go-to-sleep/index.html','go-to-sleep.html')).then(r=>r.text()).then(t=>/location\\.replace/.test(t))`);
const shotBoot = await shot('boot');

// ---- 2) three real clicks walk the count up
const pts = [{ x: 430, y: 470 }, { x: 700, y: 520 }, { x: 880, y: 430 }];
for (const p of pts) await click(p);
await sleep(300);
const s1 = await ev('window.__gotosleep()');

// ---- 3) a tapped-out double dispatch at one point still counts once
// (the catalog gate fires pointerup twice within a few ms of one press; both sent
//  concurrently here so they land inside the port's 70 ms same-point guard)
const dbl = { x: 620, y: 600 };
await S('Input.dispatchMouseEvent', { type: 'mousePressed', ...dbl, button: 'left', clickCount: 1, pointerType: 'mouse' });
await Promise.all([
  S('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dbl, button: 'left', clickCount: 1, pointerType: 'mouse' }),
  S('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dbl, button: 'left', clickCount: 1, pointerType: 'mouse' }),
]);
await sleep(300);
const sDup = await ev('window.__gotosleep()');

// ---- 4) count up to the asleep sheet
let guard = 0;
while (guard++ < 30) {
  const st = await ev('window.__gotosleep()');
  if (st.over) break;
  await click({ x: 300 + ((guard * 137) % 660), y: 380 + ((guard * 71) % 300) });
}
await sleep(300);
const sWin = await ev('window.__gotosleep()');
const winSheet = await sheet();
const shotWin = await shot('asleep');

// ---- 5) restart from the sheet, then the R key
await clickEl('overBtn');
const sNew = await ev('window.__gotosleep()');
await click({ x: 640, y: 500 }); await click({ x: 660, y: 500 });
const sBeforeR = await ev('window.__gotosleep()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(300);
const sR = await ev('window.__gotosleep()');

// ---- 6) wide awake: QA position with almost no sleepiness left
await ev('window.__gotosleep.setup({sleep:1.5})');
await sleep(900);
const sLose = await ev('window.__gotosleep()');
const loseSheet = await sheet();
const shotLose = await shot('awake');

const errors1 = cdpEvents()
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 4).join(' | ');

// ---- 7) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: URL_ });
await sleep(5200);
const p0 = await ev('window.__gotosleep()');
const sp = await ev('window.__gotosleep.sheepPoint()');
const fp = await ev('window.__gotosleep.fencePoint()');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(220);
};
for (const p of [{ x: 195, y: 520 }, { x: 195, y: 560 }, { x: 200, y: 600 }]) await tap(p);
await sleep(300);
const sTouch = await ev('window.__gotosleep()');
const shotTouch = await shot('touch');
const errors2 = cdpEvents()
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const inView = (p) => p && p.x > 4 && p.x < 1276 && p.y > 4 && p.y < 796;
const inViewP = (p) => p && p.x > 6 && p.x < 384 && p.y > 10 && p.y < 834;

const checks = {
  boot: hookType === 'function' && !!s0 && s0.count === 0 && s0.over === false && s0.sleep > 30 && s0.sleep < 76 && s0.sheep === 4,
  shim: shimOk === true,
  clicked: s1.count === 3 && s1.tapped === 3 && s1.sleep > s0.sleep && s1.over === false,
  dedupe: sDup.count === s1.count + 1 && sDup.dups >= 1,
  asleep: sWin.over === true && sWin.result === 'asleep' && sWin.count >= 20 && winSheet.open === true && /asleep/i.test(winSheet.title),
  restarted: sNew.count === 0 && sNew.over === false && sNew.tapped === 0,
  keyRestart: sBeforeR.count === 2 && sR.count === 0 && sR.over === false,
  awake: sLose.over === true && sLose.result === 'awake' && sLose.sleep <= 0 && loseSheet.open === true && /awake/i.test(loseSheet.title),
  touchClicked: sTouch.count === 3 && sTouch.tapped === 3 && p0.count === 0,
  framed: inView(sp) && inView(fp) && inViewP(sp) && inViewP(fp),
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0, s1: { count: s1.count, tapped: s1.tapped, sleep: s1.sleep },
  sDup: { count: sDup.count, dups: sDup.dups },
  sWin: { count: sWin.count, over: sWin.over, result: sWin.result }, winSheet,
  sNew: { count: sNew.count, over: sNew.over }, sBeforeR: { count: sBeforeR.count }, sR: { count: sR.count },
  sLose: { over: sLose.over, result: sLose.result, sleep: sLose.sleep }, loseSheet,
  p0: { count: p0.count }, sTouch: { count: sTouch.count, tapped: sTouch.tapped }, sp, fp,
  shots: [shotBoot, shotWin, shotLose, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
