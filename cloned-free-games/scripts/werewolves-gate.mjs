#!/usr/bin/env node
// Interaction gate for the Werewolves port: real CDP mouse/touch on the seat ring, state-hook
// assertions for the seer read, the night kill, the day vote, a win, a loss, restart and a
// portrait tap. usage: node werewolves-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/werewolves/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const CMD_TIMEOUT = 240000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const fails = [];
function ok(cond, label, extra) {
  if (cond) { console.log('PASS', label); return true; }
  fails.push(label);
  console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra));
  return false;
}

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
  return new Promise((ok2) => s.listen(0, '127.0.0.1', () => ok2(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok2, bad) => { ws.onopen = ok2; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok: o, bad: b } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? b(new Error(msg.error.message)) : o(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((o, b) => {
      this.p.set(id, { ok: o, bad: b });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) b(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/wolf-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); cleanup(); process.exit(1); });

let err = '';
const endpoint = await new Promise((o, b) => {
  const t = setTimeout(() => b(new Error('no devtools: ' + err.slice(-300))), 90000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); o(m[1]); } });
  proc.on('exit', (c) => b(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
T('serving ' + ROOT + ' on ' + port);
const dport = new URL(endpoint).port;
let list = [];
for (let i = 0; i < 40; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json(); } catch { list = []; }
  if (list.find((t) => t.type === 'page')) break;
  await new Promise((r) => setTimeout(r, 500));
}
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('no page target'); cleanup(); process.exit(1); }
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const st = () => ev('window.__werewolves && window.__werewolves()');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickSeat = async (i) => {
  const p = await ev(`window.__werewolves.seatPoint(${i})`);
  if (!p || p.__err) { T('seatPoint failed ' + JSON.stringify(p)); return null; }
  await click(p);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) { T('no element ' + id); return null; }
  await click(b);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const feedText = () => ev(`document.getElementById('feed').textContent`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

// poll for the boot hook rather than sleeping a fixed time (swiftshader boot is slow here)
let booted = false, bootMs = 0;
for (let i = 0; i < 180; i++) {
  const t0 = Date.now();
  const v = await ev('typeof window.__werewolves');
  if (v === 'function') { booted = true; bootMs = Date.now() - t0; break; }
  await sleep(1000);
}
ok(booted, 'the port boots and exposes its hook', { bootMs });
if (!booted) { console.log('console:', JSON.stringify(pageCdp.events.slice(0, 6))); cleanup(); process.exit(1); }
await sleep(1200);

// ---- 1) boot state + framing
const s0 = await st();
ok(s0 && s0.phase === 'night' && s0.night === 1, 'opens on night one', s0 && { phase: s0.phase, night: s0.night });
ok(s0.alive === 9, 'nine seats alive', { alive: s0.alive });
ok(s0.role !== 'wolf', 'the visitor is dealt onto the village side', { role: s0.role });
ok(!s0.over && s0.result === null, 'no verdict at boot');
const pts = await ev('window.__werewolves.seatPoints()');
ok(Array.isArray(pts) && pts.length === 9, 'nine seat points for the picker', { n: pts && pts.length });
const vp = await ev('({w:innerWidth,h:innerHeight})');
const bx = [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))];
ok(bx[0] > 0 && bx[1] > 0 && bx[2] < vp.w && bx[3] < vp.h, 'every seat is inside the viewport', { bx, vp });
ok(Math.abs((bx[0] + bx[2]) / 2 - vp.w / 2) < 0.06 * vp.w, 'the ring is centred horizontally', { bx, vp });
ok((bx[2] - bx[0]) / vp.w > 0.35, 'the ring fills the frame', { cover: (bx[2] - bx[0]) / vp.w });
const shotBoot = await shot('werewolves-gate-boot');
T('boot shot ' + shotBoot);

// ---- 2) seer reads a known wolf through a real click
await ev(`window.__werewolves.setup({roles:['seer','wolf','villager','villager','villager','doctor','villager','villager','villager'],
  phase:'night', night:1})`);
await sleep(300);
const sA = await st();
ok(sA.role === 'seer' && sA.phase === 'night', 'QA fixture deals the visitor as the seer', { role: sA.role });
await clickSeat(1);
const sB = await st();
ok(sB.inputs === 1, 'one accepted tap', { inputs: sB.inputs, taps: sB.taps, blocked: sB.blocked });
ok(sB.seats[1].known === 'wolf', 'the seer read lands on the tapped seat', { known: sB.seats[1].known });
ok(sB.acted === true, 'the night action is spent', { acted: sB.acted });
const feedA = await feedText();
ok(/wolf looks back/i.test(feedA), 'the feed reports the read', feedA.slice(-120));
await clickSeat(2);
const sC = await st();
ok(sC.blocked >= 1 && sC.seats[2].known === 'unknown', 'a second read in the same night is refused', { blocked: sC.blocked });
const shotRead = await shot('werewolves-gate-seer');
T('seer shot ' + shotRead);

// ---- 3) dawn resolves the pack's kill
await clickEl('go');
const sD = await st();
ok(sD.phase === 'dawn', 'the primary button moves night -> dawn', { phase: sD.phase });
ok(sD.alive === 8 || /barred/.test(sD.report), 'the pack either takes a seat or is stopped by a lantern', { alive: sD.alive, report: sD.report });

// ---- 4) the table gathers and a real vote hangs a seat
await clickEl('go');
const sE = await st();
ok(sE.phase === 'day' && sE.day === 1, 'dawn -> day', { phase: sE.phase, day: sE.day });
const victim = sE.seats.find((x) => x.alive && x.i !== 0).i;
await clickSeat(victim);
const sF = await st();
ok(sF.phase === 'dusk' || sF.over, 'a seat tap casts the day vote', { phase: sF.phase });
ok(Array.isArray(sF.tally) && sF.tally.length === 9, 'the tally is recorded', sF.tally);
ok(sF.inputs >= 2, 'the vote counts as a second accepted tap', { inputs: sF.inputs });
const shotVote = await shot('werewolves-gate-vote');
T('vote shot ' + shotVote);

// ---- 5) dusk -> the next night
if (!sF.over) {
  await clickEl('go');
  const sG = await st();
  ok(sG.phase === 'night' && sG.night === 2, 'dusk -> night two', { phase: sG.phase, night: sG.night });
}

// ---- 6) win: the last wolf hangs
await ev(`window.__werewolves.setup({roles:['villager','wolf','villager','villager','villager','villager','villager','villager','villager'],
  alive:[true,true,true,false,false,false,false,false,false], phase:'dawn', night:2, bias:1})`);
await sleep(250);
await clickEl('go');
const sH = await st();
ok(sH.phase === 'day', 'the win fixture gathers the table', { phase: sH.phase });
await clickSeat(1);
const sI = await st();
ok(sI.over && sI.result === 'win', 'hanging the last wolf wins the run', { over: sI.over, result: sI.result, why: sI.why, tally: sI.tally });
const winSheet = await sheet();
ok(winSheet.open && /survives/i.test(winSheet.title), 'the win sheet opens in place', winSheet);
const shotWin = await shot('werewolves-gate-win');
T('win shot ' + shotWin);

// ---- 7) restart from the sheet
await clickEl('overBtn');
const sJ = await st();
ok(!sJ.over && sJ.phase === 'night' && sJ.night === 1 && sJ.alive === 9, 'the sheet restarts a fresh table', { phase: sJ.phase, alive: sJ.alive });
const closed = await sheet();
ok(!closed.open, 'the sheet closes on restart');

// ---- 8) lose: an innocent hangs at parity
await ev(`window.__werewolves.setup({roles:['villager','doctor','wolf','wolf','villager','villager','villager','villager','villager'],
  alive:[true,true,true,true,true,false,false,false,false], phase:'dawn', night:2, bias:1})`);
await sleep(250);
await clickEl('go');
await clickSeat(1);
const sK = await st();
ok(sK.over && sK.result === 'lose', 'a mislynch that leaves the pack at parity loses', { over: sK.over, result: sK.result, why: sK.why });
const loseSheet = await sheet();
ok(loseSheet.open && /falls/i.test(loseSheet.title), 'the loss sheet opens in place', loseSheet);
const shotLose = await shot('werewolves-gate-lose');
T('lose shot ' + shotLose);

// ---- 9) portrait: the ring still frames and a finger tap still reads
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
let pBooted = false;
for (let i = 0; i < 180; i++) {
  const v = await ev('typeof window.__werewolves');
  if (v === 'function') { pBooted = true; break; }
  await sleep(1000);
}
ok(pBooted, 'the port boots in portrait');
await sleep(1200);
await ev(`window.__werewolves.setup({roles:['seer','wolf','villager','villager','villager','villager','villager','doctor','villager'], phase:'night', night:1})`);
await sleep(300);
const pp = await ev('window.__werewolves.seatPoints()');
const vp2 = await ev('({w:innerWidth,h:innerHeight})');
const bx2 = [Math.min(...pp.map((p) => p.x)), Math.min(...pp.map((p) => p.y)), Math.max(...pp.map((p) => p.x)), Math.max(...pp.map((p) => p.y))];
ok(bx2[0] > 0 && bx2[2] < vp2.w, 'portrait: the ring fits the width', { bx: bx2, vp: vp2 });
ok(Math.abs((bx2[0] + bx2[2]) / 2 - vp2.w / 2) < 0.07 * vp2.w, 'portrait: the ring is centred', { bx: bx2, vp: vp2 });
ok(bx2[1] > 40 && bx2[3] < vp2.h - 40, 'portrait: the ring clears the HUD bars', { bx: bx2, vp: vp2 });
const target = pp[1];
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, radiusX: 9, radiusY: 9, force: 1, id: 1 }] });
await sleep(90);
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(420);
let sT = await st();
if (!sT.inputs) {   // headless can swallow the first event after a metrics override: a finger repeats
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, radiusX: 9, radiusY: 9, force: 1, id: 2 }] });
  await sleep(90);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
  sT = await st();
}
ok(sT.inputs >= 1 && sT.seats[1].known === 'wolf', 'portrait: a finger tap reads a seat', { inputs: sT.inputs, known: sT.seats[1].known, taps: sT.taps });
const shotPortrait = await shot('werewolves-gate-portrait');
T('portrait shot ' + shotPortrait);

// ---- 10) console errors
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((x) => x && !/favicon/i.test(x));
ok(errors.length === 0, 'no console errors', errors.slice(0, 3));

console.log('\n' + (fails.length ? 'FAILED: ' + fails.join(' | ') : 'ALL GATE CHECKS PASSED'));
cleanup();
server.close();
process.exit(fails.length ? 1 : 0);
