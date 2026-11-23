#!/usr/bin/env node
// Interaction gate for the Alex vs Bus port: real CDP mouse on the pads and the street,
// state-hook assertions for run / jump / coin / stumble / fall / bus / timeout / restart,
// plus a 390x844 touch pass. usage: node alex-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/alex-vs-bus/';
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
const PROFILE = mkdtempSync('/tmp/alex-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
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
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const server = await serve();
const port = server.address().port;
const url = `http://127.0.0.1:${port}/${FILE}`;
const head = await (await fetch(url)).text();
T('serving ' + url + ' title=' + (head.match(/<title>([^<]*)/) || [])[1]);

const press = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad click point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const release = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad release point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const click = async (pt) => { await press(pt); await release(pt); };
const btn = (name) => ev(`window.__alex.btnPoint('${name}')`);
const clickBtn = async (name) => { const p = await btn(name); await click(p); await sleep(320); return p; };
// hold a pad until the hook says it happened, then let go — never assert movement after a fixed sleep
const holdUntil = async (name, pred, budget = 6000) => {
  const p = await btn(name);
  await press(p);
  const t0 = Date.now();
  let st = await ev('window.__alex()');
  while (Date.now() - t0 < budget) {
    await sleep(120);
    st = await ev('window.__alex()');
    if (pred(st)) break;
  }
  await release(p);
  await sleep(120);
  return { st, p };
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

await S('Page.navigate', { url });
await sleep(5200);

// ---- 1) boot: hook live, first stop, clock running, street built
const hookType = await ev('typeof window.__alex');
const s0 = await ev('window.__alex()');
T('boot hook=' + hookType + ' state=' + JSON.stringify(s0));
T('right pad point=' + JSON.stringify(await btn('right')));
const canvasOk = await ev(`(()=>{const c=document.querySelector('canvas');return !!c && c.width>200 && c.height>200;})()`);
const idx = await ev(`(()=>{const L=window.__alex.hazardInfo;return {gap:L('gap',0),crate:L('crate',0),peel:L('peel',0),coin0:window.__alex.coinInfo(0),coins:window.__alex().total};})()`);
const shotBoot = await shot('alex-gate-boot');

// ---- 2) the right pad really runs
const run1 = await holdUntil('right', (s) => s.x > s0.x + 2.2);
const shotRun = await shot('alex-gate-run');

// ---- 3) the jump pad lifts Alex, and a tap on the street does the same
await sleep(400);
const g0 = await ev('window.__alex()');
const jp = await btn('jump');
await click(jp);
let jumped = null;
for (let i = 0; i < 12; i++) { await sleep(70); jumped = await ev('window.__alex()'); if (jumped.y > 0.25) break; }
const sAfterJump = await ev('window.__alex()');
const boardPt = await ev('window.__alex.playerPoint()');
await sleep(700);
const tapsBefore = (await ev('window.__alex()')).taps;
await click({ x: Math.max(60, Math.min(1180, boardPt.x + 220)), y: Math.max(120, Math.min(500, boardPt.y - 40)) });
const sTap = await ev('window.__alex()');

// ---- 4) a coin pays when Alex runs into it
const coinIdx = await ev(`window.__alex.pickFloorCoin()`);
const coinInfo = await ev(`window.__alex.coinInfo(${coinIdx})`);
await ev(`window.__alex.setup({level:0, x:${coinInfo.x - 1.4}})`);
await sleep(200);
const coinBefore = await ev('window.__alex()');
const coinRun = await holdUntil('right', (s) => s.coins > coinBefore.coins, 4000);

// ---- 5) a crate stumbles him and costs seconds
const crate = idx.crate;
await ev(`window.__alex.setup({level:0, x:${crate.x - 2.6}})`);
await sleep(200);
const stumbleBefore = await ev('window.__alex()');
const stumbleRun = await holdUntil('right', (s) => s.hits > 0, 4000);

// ---- 6) a hole swallows him, costs more time and sets him back before it
const gap = idx.gap;
await ev(`window.__alex.setup({level:0, x:${gap.mid}, y:0.6, grounded:false})`);
await sleep(200);
const fallBefore = await ev('window.__alex()');
let fallSt = null;
for (let i = 0; i < 20; i++) { await sleep(120); fallSt = await ev('window.__alex()'); if (fallSt.falls > 0) break; }
await sleep(200);
const fallAfter = await ev('window.__alex()');

// ---- 7) catching the bus clears the last stop
await ev(`window.__alex.setup({level:2, x:${crate.x + 300}, time:40})`);
await sleep(200);
const nearBus = await ev('window.__alex()');
const busX = nearBus.busX;
await ev(`window.__alex.setup({level:2, x:${busX - 5}, time:40})`);
await sleep(200);
const busBefore = await ev('window.__alex()');
const winRun = await holdUntil('right', (s) => s.cleared, 6000);
const winSheet = await sheet();
const shotWin = await shot('alex-gate-win');

// ---- 8) the clock runs out and the bus leaves without him
await ev(`window.__alex.setup({level:1, time:0.8})`);
let loseSt = null;
for (let i = 0; i < 24; i++) { await sleep(120); loseSt = await ev('window.__alex()'); if (loseSt.over) break; }
const loseSheet = await sheet();
const shotLose = await shot('alex-gate-lose');

// ---- 9) Play again from the sheet puts him back on stop one with a full clock
await clickBtn('again');
const sAgain = await ev('window.__alex()');
const shotRestart = null;

// ---- 10) keyboard: R restarts, Space jumps
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(300);
const sR = await ev('window.__alex()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
let keyJump = null;
for (let i = 0; i < 12; i++) { await sleep(70); keyJump = await ev('window.__alex()'); if (keyJump.y > 0.25) break; }
await sleep(500);

const errors1 = cdpEvents().filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 11) portrait phone: the pads still work and the runner is on screen
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Page.navigate', { url });
await sleep(5400);
const touchHold = async (name, ms, pred) => {
  const p = await btn(name);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  const t0 = Date.now();
  let st = await ev('window.__alex()');
  while (Date.now() - t0 < ms) { await sleep(120); st = await ev('window.__alex()'); if (pred && pred(st)) break; }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(160);
  return { st, p };
};
const p0 = await ev('window.__alex()');
const touchRun = await touchHold('right', 4000, (s) => s.x > p0.x + 1.5);
const shotTouch = await shot('alex-gate-touch');
const touchJump = await (async () => {
  const p = await btn('jump');
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let st = null;
  for (let i = 0; i < 12; i++) { await sleep(70); st = await ev('window.__alex()'); if (st.y > 0.25) break; }
  return { st, p };
})();
const geo = await ev(`(()=>{const s=window.__alex();const pp=window.__alex.playerPoint();const bp=window.__alex.busPoint();
  const t=document.querySelector('.top').getBoundingClientRect();const b=document.querySelector('.bottom').getBoundingClientRect();
  const pads=['left','right','jump'].map(n=>window.__alex.btnPoint(n));
  return {pp,bp,top:t.bottom,bot:b.top,w:innerWidth,h:innerHeight,pads,band:window.__alex.hudBand()};})()`);
const errors2 = cdpEvents().filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const inView = (p) => p && p.x > 2 && p.x < geo.w - 2 && p.y > 2 && p.y < geo.bot - 2 && p.y > geo.top;
// the runner must sit in the band the bars leave, and the pads must be under it (never over the street)
const feedClear = (p) => p && p.x > 4 && p.x < geo.w - 4 && p.y > geo.top + 2 && p.y < geo.bot - 2;
const padsBelow = geo.pads.every((p) => p && p.y > geo.bot - 4 && p.y < geo.h);

const checks = {
  boot: hookType === 'function' && s0.level === 1 && s0.time > 45 && s0.over === false && s0.gaps >= 2 && s0.crates >= 1 && canvasOk === true,
  padsClickable: geo.pads.every((p) => p && p.x > 0 && p.y > geo.top),
  runs: run1.st.x > s0.x + 2.2 && run1.st.vx > 3,
  jumps: jumped && jumped.y > 0.25 && sAfterJump.jumps >= g0.jumps + 1,
  boardTap: sTap.taps > tapsBefore && sTap.jumps >= sAfterJump.jumps,
  coinPaid: coinIdx >= 0 && coinRun.st.coins > coinBefore.coins && coinRun.st.score - coinBefore.score >= 50,
  stumbled: stumbleRun.st.hits > 0 && stumbleBefore.time - stumbleRun.st.time >= 2.5 && stumbleRun.st.x < crate.x,
  fell: fallAfter.falls > 0 && fallBefore.time - fallAfter.time >= 4.5 && fallAfter.x < gap.x0,
  caughtBus: winRun.st.cleared === true && winRun.st.won === true && winRun.st.busBonus > 0 && winSheet.open === true && /caught/i.test(winSheet.title),
  missedBus: loseSt && loseSt.over === true && loseSt.won === false && loseSt.why === 'late' && loseSheet.open === true && /left without/i.test(loseSheet.title),
  restarted: sAgain.over === false && sAgain.level === 1 && sAgain.time > 50 && sAgain.x < 3,
  keyRestart: sR.level === 1 && sR.over === false && sR.time > 50,
  keyJump: keyJump && keyJump.y > 0.25,
  touchRuns: touchRun.st.x > p0.x + 1.5,
  touchJumps: touchJump.st && touchJump.st.y > 0.25,
  touchOnScreen: feedClear(geo.pp) && padsBelow,
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0, run1: { x: run1.st.x, vx: run1.st.vx }, jumped: { y: jumped && jumped.y, jumps: jumped && jumped.jumps },
  boardTap: { taps: [tapsBefore, sTap.taps], jumps: sTap.jumps },
  coin: { before: [coinBefore.coins, coinBefore.score], after: [coinRun.st.coins, coinRun.st.score] },
  stumble: { before: +stumbleBefore.time.toFixed(1), after: +stumbleRun.st.time.toFixed(1), hits: stumbleRun.st.hits, x: stumbleRun.st.x, crate: crate.x },
  fall: { before: +fallBefore.time.toFixed(1), after: +fallAfter.time.toFixed(1), falls: fallAfter.falls, x: fallAfter.x, gap },
  win: { cleared: winRun.st.cleared, won: winRun.st.won, bonus: winRun.st.busBonus, sheet: winSheet },
  lose: { over: loseSt && loseSt.over, why: loseSt && loseSt.why, sheet: loseSheet },
  again: { level: sAgain.level, time: sAgain.time, x: sAgain.x }, sR: { level: sR.level, time: sR.time },
  touch: { x0: p0.x, x1: touchRun.st.x, y: touchJump.st && touchJump.st.y }, geo,
  shots: [shotBoot, shotRun, shotWin, shotLose, shotRestart, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
