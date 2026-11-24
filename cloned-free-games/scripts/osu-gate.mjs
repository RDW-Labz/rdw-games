#!/usr/bin/env node
// Interaction gate for the osu! Circles port. Real CDP input against the shipped page served from
// the site repo root (the port imports ./kit.js relatively):
//   boot state, the picker round-trip on the played circles, a wall-clock-timed run of real clicks
//   that scores 300s, a full QA map cleared to the win sheet, restart from the sheet, a drained
//   bar reaching the loss sheet, the double-tap guard, an empty tap costing nothing, and a 390x844
//   portrait pass with its own picker check and real tap.
// usage: node osu-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PATH_ = 'games/arcade/osu/';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/osu-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m && !t._done) { t._done = true; clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('FAIL: no page target'); process.exit(1); }
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

const server = await serve();
const port = server.address().port;
const URL_ = `http://127.0.0.1:${port}/${PATH_}`;
T('serving ' + URL_);

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: URL_ });
await sleep(6000);

const hook = () => ev('window.__osu()');
const press = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const errors1 = () => pageCdp.events.filter((e) =>
  (e.method === 'Runtime.exceptionThrown') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')).length;
const poll = async (fn, budgetMs, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const v = await fn();
    if (v) return v;
    await sleep(120);
  }
  T('poll timeout: ' + label);
  return null;
};

// Click the next circle just before its beat. The CDP round trip costs tens of ms (measured, not
// guessed): each press reports the timing error it landed with, and the trigger point is corrected
// by that error, so a real click can score inside the 300 window instead of flaking into 100s.
let lead = 30;
async function playNext(budgetMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const n = await ev('window.__osu.nextNote()');
    if (!n || n.__err) return null;
    if (n.inMs <= lead) {
      await press(n.pt);
      await sleep(30);
      const dt = await ev(`(()=>{const m=window.__osu.map();const e=m[${n.i}];return e?e.dt:null;})()`);
      if (typeof dt === 'number') lead = Math.max(6, Math.min(150, lead + dt));
      return { ...n, dt, lead };
    }
    await sleep(Math.max(4, Math.min(140, n.inMs - lead)));
  }
  return null;
}

// ---- 1) boot
const hookType = await ev('typeof window.__osu');
const s0 = await hook();
const band0 = await ev('window.__osu.band()');
const rules = await ev('window.__osu.rules()');
const shotBoot = await shot('osu-gate-boot');
T('boot ' + JSON.stringify({ hookType, notes: s0.notes, bpm: s0.bpm, hp: s0.hp, over: s0.over, calls: s0.calls, band0 }));

// ---- 2) picker round-trip on a fresh run (the boot run has been ticking since navigation, so its
// opening circles are already resolved and no longer pickable): restart, then in the SAME page tick
// check that every one of the first eight circles resolves back to itself
const fresh = await ev(`(()=>{const s=window.__osu.restart();const bad=[];
  for(let i=0;i<8;i++){const p=window.__osu.aim(i);const g=window.__osu.noteAt(p);if(g!==i)bad.push([i,g,p]);}
  return {runs:s.runs,hp:s.hp,judged:s.judged,over:s.over,bad,n:bad.length};})()`);
const picks = { bad: fresh.bad, n: fresh.n };

// ---- 3) a wall-clock-timed run of real clicks on the boot map: 300s, no misses
const scored = [];
for (let i = 0; i < 4; i++) {
  const n = await playNext(6000);
  if (!n) break;
  const st = await hook();
  scored.push({ i: n.i, inMs: n.inMs, judged: st.judged, hits: st.hits, hp: st.hp, combo: st.combo });
}
const afterPlay = await hook();
const shotPlay = await shot('osu-gate-play');
T('play ' + JSON.stringify({ scored, judged: afterPlay.judged, hits: afterPlay.hits, acc: afterPlay.acc, misses: afterPlay.misses }));

// ---- 4) a full QA map through real clicks: win sheet
const winSetup = await ev('window.__osu.setup({count:3,gap:900,start:1500})');
const winTaps = [];
for (let i = 0; i < 3; i++) {
  const n = await playNext(4000);
  if (!n) break;
  winTaps.push(n.inMs);
  await sleep(60);
}
const winState = await poll(async () => { const s = await hook(); return s.over ? s : null; }, 6000, 'win');
const winSheet = await ev(`(()=>{const o=document.getElementById('over');return {open:o.classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent};})()`);
const shotWin = await shot('osu-gate-win');
T('win ' + JSON.stringify({ winTaps, state: winState && { result: winState.result, judged: winState.judged, hits: winState.hits, acc: winState.acc, maxCombo: winState.maxCombo }, winSheet }));

// ---- 5) restart from the sheet's own button (under the overlay, so it must be the sheet's button)
const overBtn = await ev(`(()=>{const r=document.getElementById('overBtn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const runsBefore = (await hook()).runs;
await press(overBtn);
await sleep(400);
const restarted = await hook();
T('restart ' + JSON.stringify({ runsBefore, runs: restarted.runs, over: restarted.over, judged: restarted.judged, hp: restarted.hp, sheet: restarted.sheet }));

// ---- 6) a drained bar: a 12 HP run left untouched reaches the loss sheet
const loseSetup = await ev('window.__osu.setup({count:3,gap:420,start:700,hp:12})');
const loseState = await poll(async () => { const s = await hook(); return s.over ? s : null; }, 9000, 'lose');
const loseSheet = await ev(`(()=>{const o=document.getElementById('over');return {open:o.classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent};})()`);
const shotLose = await shot('osu-gate-lose');
T('lose ' + JSON.stringify({ state: loseState && { result: loseState.result, why: loseState.why, hp: loseState.hp, judged: loseState.judged, misses: loseState.misses }, loseSheet }));

// ---- 7) double-tap guard: two pointerups at the same pixel inside ONE page tick
const dupSetup = await ev('window.__osu.setup({count:2,gap:1400,start:2600})');
const dup = await ev(`(()=>{const s=window.__osu();const p=window.__osu.nextNote().pt;
  const c=document.querySelector('body > canvas');
  const before=window.__osu().dups;
  const mk=()=>new PointerEvent('pointerup',{clientX:p.x,clientY:p.y,bubbles:true,pointerId:5,pointerType:'touch'});
  c.dispatchEvent(mk()); c.dispatchEvent(mk());
  const after=window.__osu();
  return {before,dups:after.dups,taps:after.taps,judged:after.judged};})()`);

// ---- 8) an empty tap costs nothing: press a corner of the field with no circle near it
const emptySetup = await ev('window.__osu.setup({count:2,gap:1200,start:2600})');
const emptyTap = await ev(`(()=>{const f=window.__osu.field();const s0=window.__osu();
  const pt=window.__osu.notePoint(0);
  const c=document.querySelector('body > canvas');const r=c.getBoundingClientRect();
  // a point 60 px in from the canvas corner, which is off the corner circle
  const x=Math.round(r.left+60), y=Math.round(r.top+Math.round(r.height*0.5));
  const s=window.__osu();
  return {before:{taps:s0.taps,judged:s0.judged,hp:s0.hp},probe:{x,y},noteAt:window.__osu.noteAt({x,y})};})()`);
await press({ x: emptyTap.probe.x, y: emptyTap.probe.y });
await sleep(250);
const emptyAfter = await hook();
T('empty ' + JSON.stringify({ probe: emptyTap.probe, noteAt: emptyTap.noteAt, before: emptyTap.before, after: { taps: emptyAfter.taps, empty: emptyAfter.empty, judged: emptyAfter.judged } }));

// ---- 9) portrait pass: the field reframes into the HUD band, the picker still round-trips and a
// real tap still scores
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
const tSetup = await ev('window.__osu.setup({count:2,gap:1200,start:1600})');
const tBand = await ev('window.__osu.band()');
const tField = await ev('window.__osu.field()');
const tPicks = await ev(`(()=>{const bad=[];for(let i=0;i<2;i++){const p=window.__osu.aim(i);const g=window.__osu.noteAt(p);if(g!==i)bad.push([i,g,p]);}return bad.length;})()`);
const tTap = await playNext(5000);
const tState = await hook();
const shotTouch = await shot('osu-gate-touch');
T('touch ' + JSON.stringify({ band: tBand, field: tField, bad: tPicks, tap: tTap && { inMs: tTap.inMs }, state: { judged: tState.judged, hits: tState.hits, view: tState.view } }));

const errors = errors1();
const checks = {
  hookLive: hookType === 'function',
  boot: s0 && s0.notes >= 40 && s0.hp > 0 && s0.hp <= 100 && s0.over === false && s0.calls > 0,
  freshRun: fresh && fresh.runs === s0.runs + 1 && fresh.judged === 0 && fresh.hp === 100 && fresh.over === false,
  draws: s0 && s0.calls > 0,
  framed: band0 && band0.inBand,
  windows: rules && rules.WIN.p300 === 45 && rules.WIN.p100 === 90 && rules.WIN.p50 === 140,
  picker: picks && picks.n === 0,
  played: afterPlay && afterPlay.judged >= 3 && afterPlay.hits[300] >= 1 && afterPlay.misses === 0 && afterPlay.hp > 90,
  won: winState && winState.over === true && winState.result === 'win' && winState.judged === 3
    && winState.hits[0] === 0 && winState.maxCombo === 3 && winSheet && winSheet.open && /Cleared/i.test(winSheet.title),
  restarted: restarted && restarted.runs === runsBefore + 1 && restarted.over === false
    && restarted.judged === 0 && restarted.hp === 100 && restarted.sheet === false,
  lost: loseState && loseState.over === true && loseState.result === 'lose' && loseState.why === 'drained'
    && loseState.hp <= 0 && loseSheet && loseSheet.open && /Drained/i.test(loseSheet.title),
  doubleTapGuarded: dup && dup.dups >= 1 && dup.judged === 0,
  emptyTapFree: emptyAfter && emptyAfter.empty >= 1 && emptyAfter.judged === emptyTap.before.judged,
  touchPicks: tPicks === 0,
  touchScored: tState && tState.judged >= 1 && tState.view === '390x844',
  touchFramed: tBand && tBand.inBand,
  noErrors: errors === 0,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  checks, errors,
  boot: s0 && { seed: s0.seed, bpm: s0.bpm, notes: s0.notes, field: s0.field, camDist: s0.camDist, calls: s0.calls, band: band0 },
  picks, scored, play: afterPlay && { judged: afterPlay.judged, hits: afterPlay.hits, acc: afterPlay.acc, misses: afterPlay.misses },
  win: winState && { result: winState.result, hits: winState.hits, acc: winState.acc, maxCombo: winState.maxCombo, sheet: winSheet },
  restart: { runsBefore, runs: restarted.runs, judged: restarted.judged },
  lose: { state: loseState && { result: loseState.result, why: loseState.why, hp: loseState.hp }, sheet: loseSheet },
  dup, empty: { probe: emptyTap.probe, noteAt: emptyTap.noteAt, after: { taps: emptyAfter.taps, empty: emptyAfter.empty } },
  touch: { band: tBand, bad: tPicks, judged: tState.judged, hits: tState.hits, view: tState.view },
  shots: [shotBoot, shotPlay, shotWin, shotLose, shotTouch],
}, null, 0));
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL');
server.close();
process.exit(pass ? 0 : 1);
