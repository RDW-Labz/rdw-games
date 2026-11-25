#!/usr/bin/env node
// Interaction gate for the Burger Party port (quarantined com.agateau.burgerparty card):
// real CDP mouse clicks on the ingredient stations, state-hook assertions for stack /
// serve / win / lose / restart / double-tap guard, plus portrait touch.
// usage: node burger-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/burger-party/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/burger-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 180000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
process.on('unhandledRejection', (e) => { proc.kill('SIGKILL'); throw e; });
process.on('SIGTERM', () => proc.kill('SIGKILL'));
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
const hook = () => ev('window.__burger()');

async function waitFor(expr, ms = 90000, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    if (v) { T('ready after ' + (Date.now() - t0) + 'ms'); return v; }
    await sleep(step);
  }
  throw new Error('timeout waiting for ' + expr);
}

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await waitFor("typeof window.__burger === 'function'");

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickStation = async (kind) => {
  const p = await ev(`window.__burger.stationPoint(${JSON.stringify(kind)})`);
  if (!p || p.__err) return { p, err: p && p.__err };
  await click({ x: Math.round(p.x), y: Math.round(p.y) });
  await sleep(220);
  return p;
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
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot
const s0 = await hook();
const hookType = await ev('typeof window.__burger');
const ing = await ev('window.__burger.ingredients()');
const pts = {};
for (const k of ing) pts[k] = await ev(`window.__burger.stationPoint(${JSON.stringify(k)})`);
const shotBoot = await shot('burger-gate-boot');
const chips0 = await ev(`(()=>[...document.querySelectorAll('#chips .chip')].map(e=>e.textContent.trim()))()`);
T('boot ' + JSON.stringify({ order: s0.order, level: s0.level, target: s0.target, chips: chips0 }));

// ---- 2) the ticket's first filling, one real click on the station
const first = s0.order[0];
const pFirst = await clickStation(first);
const s1 = await hook();
const chipDone1 = await ev(`document.querySelectorAll('#chips .chip.done').length`);
T('after first ' + JSON.stringify({ stack: s1.stack, inputs: s1.inputs, chipDone1 }));

// ---- 3) a wrong filling scraps the burger (real click on a different station)
const wrong = ing.find((k) => k !== s0.order[0] && k !== s0.order[1]) || ing.find((k) => k !== s0.order[1]);
const pWrong = await clickStation(wrong);
const s2 = await hook();
T('after wrong ' + JSON.stringify({ stack: s2.stack, mistakes: s2.mistakes }));

// ---- 4) build the whole ticket with real clicks and serve it
for (const kind of s0.order) await clickStation(kind);
const s3 = await hook();
const shotBuilt = await shot('burger-gate-built');
const servePt = await ev('window.__burger.servePoint()');
await click({ x: Math.round(servePt.x), y: Math.round(servePt.y) });
await sleep(600);
const s4 = await hook();
const shotMid = await shot('burger-gate-served');
T('after serve ' + JSON.stringify({ served: s4.served, coins: s4.coins, stack: s4.stack, order: s4.order }));

// ---- 5) double-tap guard: two pointerups in one page tick at the same point
const dupOrder = s4.order;
const tapTarget = dupOrder[0];
const dupRes = await ev(`(()=>{const p=window.__burger.stationPoint(${JSON.stringify(tapTarget)});
  const fire=()=>document.body.dispatchEvent(new PointerEvent('pointerup',{clientX:p.x,clientY:p.y,bubbles:true,pointerType:'mouse'}));
  const before=window.__burger(); fire(); fire(); const after=window.__burger();
  return {before:before.stack.length, after:after.stack.length, dups:after.dups, inputs:after.inputs-before.inputs};})()`);
await sleep(150);
const s5 = await hook();
T('double tap ' + JSON.stringify(dupRes));

// ---- 6) win: one order short of the target, served through the real button
await ev(`window.__burger.setup({served: window.__burger().target - 1, order:['patty','cheese']})`);
await sleep(250);
await clickStation('patty');
await clickStation('cheese');
const s6a = await hook();
await clickEl('serve');
await sleep(500);
const s6 = await hook();
const winSheet = await sheet();
const shotWin = await shot('burger-gate-win');
T('win ' + JSON.stringify({ over: s6.over, result: s6.result, served: s6.served, target: s6.target, winSheet }));

// ---- 7) restart from the win sheet
await clickEl('overBtn');
await sleep(500);
const s7 = await hook();
const sheetAfter = await sheet();

// ---- 8) lose: two walkouts already on the board, patience short on the wire
await ev(`window.__burger.setup({walkouts: 2, patienceMs: 900})`);
await sleep(2400);
const s8 = await hook();
const loseSheet = await sheet();
const shotLose = await shot('burger-gate-lose');
T('lose ' + JSON.stringify({ over: s8.over, result: s8.result, walkouts: s8.walkouts, loseSheet }));

// ---- 9) back to the first truck from the lose sheet
await clickEl('backBtn');
await sleep(400);
const s9 = await hook();
const levelLabel = await ev(`document.getElementById('served').textContent`);

// ---- 10) console errors on the desktop pass
const grabErrors = (limit = 4) => pageCdp.events
  .filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, limit).join(' | ');
const errors1 = grabErrors();

// ---- 11) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await waitFor("typeof window.__burger === 'function'");
const sT0 = await hook();
const tp = await ev(`window.__burger.stationPoint(${JSON.stringify(sT0.order[0])})`);
const tPoints = {};
for (const k of ing) tPoints[k] = await ev(`window.__burger.stationPoint(${JSON.stringify(k)})`);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
};
await tap({ x: Math.round(tp.x), y: Math.round(tp.y) });
const sT1 = await hook();
const shotTouch = await shot('burger-gate-touch');
// the portrait sheet, from the same board
await ev(`window.__burger.setup({served: window.__burger().target - 1, order:['tomato']})`);
await sleep(200);
const tp2 = await ev(`window.__burger.stationPoint('tomato')`);
await tap({ x: Math.round(tp2.x), y: Math.round(tp2.y) });
const serveT = await ev(`(()=>{const r=document.getElementById('serve').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await tap(serveT);
await sleep(500);
const sT2 = await hook();
const touchSheet = await sheet();
const shotTouchWin = await shot('burger-gate-touch-win');
const errors2 = grabErrors(3);

const onScreen = (p, w, h) => p && p.x > 6 && p.x < w - 6 && p.y > 6 && p.y < h - 6;
const checks = {
  boot: hookType === 'function' && s0 && s0.level === 0 && s0.target > 0 && s0.served === 0 && s0.walkouts === 0 && Array.isArray(s0.order) && s0.order.length === 2 && s0.over === false,
  stationsFramed: Object.values(pts).every((p) => onScreen(p, 1280, 800)),
  firstStacks: s1.stack.length === 1 && s1.stack[0] === first && s1.inputs === s0.inputs + 1,
  ticketChips: Array.isArray(chips0) && chips0.length === s0.order.length && chips0.every((c, i) => c.toLowerCase().includes(s0.order[i])) && chipDone1 === 1,
  wrongScraps: s2.mistakes === 1 && s2.stack.length === 0 && s2.served === 0 && (pWrong.x !== pFirst.x || pWrong.y !== pFirst.y),
  ticketBuilt: s3.stack.join(',') === s0.order.join(','),
  served: s4.served === 1 && s4.coins > 0 && s4.stack.length === 0 && s4.order.join(',') !== s0.order.join(','),
  dupGuard: dupRes.dups >= 1 && Math.abs(s5.stack.length - dupRes.after) <= 1 && s5.stack.length <= 1,
  won: s6.over === true && s6.result === 'win' && s6.served === s6.target && winSheet.open === true && /cleared/i.test(winSheet.title),
  restarted: s7.served === 0 && s7.over === false && s7.stack.length === 0 && s7.coins === 0 && sheetAfter.open === false,
  lost: s8.over === true && s8.result === 'lose' && s8.walkouts === 3 && loseSheet.open === true && /rush/i.test(loseSheet.title),
  backToTruck: s9.level === 0 && s9.over === false && s9.walkouts === 0 && /\/6$/.test(levelLabel),
  portraitStacks: sT1.stack.length >= 1 && sT1.stack[0] === sT0.order[0],
  portraitFramed: Object.values(tPoints).every((p) => onScreen(p, 390, 844)),
  portraitWon: sT2.over === true && sT2.result === 'win' && touchSheet.open === true,
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0: { order: s0.order, target: s0.target, inputs: s0.inputs },
  s1: { stack: s1.stack, inputs: s1.inputs }, pFirst, pWrong,
  s2: { stack: s2.stack, mistakes: s2.mistakes }, s3: { stack: s3.stack },
  s4: { served: s4.served, coins: s4.coins, order: s4.order }, dupRes, s5: { stack: s5.stack, dups: s5.dups },
  s6: { over: s6.over, result: s6.result, served: s6.served, target: s6.target }, winSheet,
  s7: { served: s7.served, over: s7.over, coins: s7.coins }, sheetAfter,
  s8: { over: s8.over, result: s8.result, walkouts: s8.walkouts }, loseSheet,
  s9: { level: s9.level, walkouts: s9.walkouts }, levelLabel,
  sT0: { order: sT0.order }, sT1: { stack: sT1.stack }, tPoints, sT2: { over: sT2.over, result: sT2.result }, touchSheet,
  shots: [shotBoot, shotMid, shotWin, shotLose, shotTouch, shotTouchWin],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
