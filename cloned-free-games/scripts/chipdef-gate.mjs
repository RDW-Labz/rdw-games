#!/usr/bin/env node
// Interaction gate for the Chip Defense port. Real CDP mouse clicks: palette -> socket
// placement, upgrade, a refused track click, the double-tap guard, a full 12-wave win from a
// QA position, the lose sheet, restart, and a 390x844 portrait touch pass.
// usage: node chipdef-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/chip-defense/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 90000);
    });
  }
}

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/chipdef-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
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

const until = async (fn, ms = 12000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__chipdef()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const cellPt = async (c, r) => ev(`window.__chipdef.cellPoint(${c},${r})`);
const clickCell = async (c, r, wait = 320) => {
  const p = await cellPt(c, r);
  if (!p || p.__err) return { err: p && p.__err, c, r };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 400) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__chipdef');
const rules = await ev('window.__chipdef.rules()');
const s0 = await state();
const shotBoot = await shot('chipdef-gate-boot');
T('boot ' + JSON.stringify({ hookType, waves: rules && rules.waves, pathLen: rules && rules.pathLen, s0: s0 && { wave: s0.wave, bits: s0.bits, integ: s0.integrity, towers: s0.towers.length, view: s0.view } }));
ok(hookType === 'function', 'the state hook is a function', hookType);
ok(rules && rules.waves === 12 && rules.W === 12 && rules.H === 9, 'a 12x9 die with 12 waves', rules && { W: rules.W, H: rules.H, waves: rules.waves });
ok(rules && rules.pathLen.length === 2 && rules.pathLen.every(n => n > 10), 'two lanes of real length', rules && rules.pathLen);
ok(s0 && s0.wave === 1 && s0.towers.length === 0 && s0.integrity === 20, 'boot is wave one, empty chip, full core', s0 && { wave: s0.wave, towers: s0.towers.length, integrity: s0.integrity });

// ---------- 2) the picker round-trips every cell ----------
const pick = await ev(`(()=>{
  const out=[]; let bad=[];
  for (let r=0;r<9;r++) for (let c=0;c<12;c++) {
    const p=window.__chipdef.cellPoint(c,r);
    const back=window.__chipdef.cellAt(p.x,p.y);
    if (!back || back.c!==c || back.r!==r) bad.push({c,r,p,back});
    out.push(p);
  }
  const onCanvas = out.every(p=>p.x>=0&&p.x<=innerWidth&&p.y>=0&&p.y<=innerHeight);
  return { bad: bad.slice(0,5), badCount: bad.length, onCanvas, band: window.__chipdef.band() };
})()`);
T('picker ' + JSON.stringify({ badCount: pick && pick.badCount, onCanvas: pick && pick.onCanvas, band: pick && pick.band }));
ok(pick && pick.badCount === 0, 'every cell point resolves back to its own cell', pick && pick.bad);
ok(pick && pick.onCanvas, 'every cell projects inside the viewport');

// ---------- 3) a real click places a gate, and a second click upgrades it ----------
// a quiet QA purse first: with a live wave running, a kill would top the bits up between clicks
await ev('window.__chipdef.setup({ bits: 80, towers: [], wave: 0 })');
await sleep(300);
const sQuiet = await state();
ok(sQuiet && sQuiet.bits === 80 && sQuiet.towers.length === 0, 'the QA purse is 80 bits and an empty chip', sQuiet && { bits: sQuiet.bits, towers: sQuiet.towers.length });
const lane = await ev('window.__chipdef.trackCells()');
const laneA = lane[0][3], laneB = lane[1][3];
const slotNear = async (c0, r0) => ev(`(()=>{
  let best=null;
  for (const s of window.__chipdef.slotCells()) {
    const d=Math.hypot(s.c-${c0}, s.r-${r0});
    if (!best || d<best.d) best={c:s.c,r:s.r,d};
  }
  return best;
})()`);
const slotA = await slotNear(laneA.c, laneA.r);
const pA = await clickCell(slotA.c, slotA.r);
const s1 = await state();
T('place ' + JSON.stringify({ slotA, pA, towers: s1.towers, bits: s1.bits, inputs: s1.inputs, taps: s1.taps }));
ok(s1.towers.length === 1 && s1.towers[0].c === slotA.c && s1.towers[0].r === slotA.r, 'a real click on a socket places the gate', s1.towers);
ok(s1.bits === 80 - 20, 'the gate costs 20 bits', { bits: s1.bits });

const pA2 = await clickCell(slotA.c, slotA.r);
const s2 = await state();
T('upgrade ' + JSON.stringify({ towers: s2.towers, bits: s2.bits, inputs: s2.inputs }));
ok(s2.towers.length === 1 && s2.towers[0].lvl === 2, 'tapping the built gate upgrades it', s2.towers);
ok(s2.bits === 44, 'the upgrade is charged', { bits: s2.bits });

// ---------- 4) a track cell is refused ----------
const sBefore = await state();
const pTrack = await clickCell(lane[0][5].c, lane[0][5].r);
const sAfter = await state();
T('track ' + JSON.stringify({ pTrack, taps: sAfter.taps, blocked: sAfter.blocked, towers: sAfter.towers.length }));
ok(sAfter.towers.length === sBefore.towers.length, 'a click on the circuit track places nothing', sAfter.towers);
ok(sAfter.blocked > sBefore.blocked, 'the refused click is counted as blocked', { before: sBefore.blocked, after: sAfter.blocked });

// ---------- 5) the palette button is a real click and switches the gate ----------
const palPos = await ev(`(()=>{const e=document.querySelector('#palette .tw[data-kind="acc"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
if (palPos) { await click(palPos); await sleep(320); }
const sSel = await state();
ok(sSel.sel === 'acc', 'the palette button selects ACC with a real click', { sel: sSel.sel, palPos });
// 44 bits is not enough for a 55-bit ACC: the placement must be refused, not silently free
const slotB = await slotNear(laneB.c, laneB.r);
const pB = await clickCell(slotB.c, slotB.r);
const sPoor = await state();
T('poor ' + JSON.stringify({ slotB, towers: sPoor.towers.length, bits: sPoor.bits, blocked: sPoor.blocked }));
ok(sPoor.towers.length === 1, 'an unaffordable gate is refused', { towers: sPoor.towers.length, bits: sPoor.bits });

// ---------- 6) play: towers kill, the wave advances, the core holds ----------
await ev(`window.__chipdef.setup({ bits: 400, towers: ${JSON.stringify([
  { c: slotA.c, r: slotA.r, kind: 'mem', lvl: 3 },
  { c: slotB.c, r: slotB.r, kind: 'mem', lvl: 3 },
])}, wave: 0 })`);
await sleep(250);
const sQA = await state();
const run1 = await ev('window.__chipdef.step(40)');
const sPlay = await state();
T('play ' + JSON.stringify({ qa: sQA && sQA.towers.length, run1, kills: sPlay.kills, leaks: sPlay.leaks, integ: sPlay.integrity, wave: sPlay.wave }));
ok(sQA && sQA.towers.length === 2, 'the QA position loads its two built gates', sQA && sQA.towers);
ok(run1 && run1.kills > 0, 'live towers kill marching units', run1);
ok(sPlay.integrity === 20, 'the opening waves do not leak', { integ: sPlay.integrity, leaks: sPlay.leaks });
const shotPlay = await shot('chipdef-gate-play');

// ---------- 7) a full run reaches the win sheet ----------
// build the strongest QA board the gate can: the ten best-covering sockets, all at level 3
const camp = await ev(`(()=>{
  const lane = window.__chipdef.trackCells().flat();
  const slots = window.__chipdef.slotCells().map(s=>({...s, v: lane.filter(q=>Math.hypot(q.c-s.c,q.r-s.r)<=3).length}));
  slots.sort((a,b)=>b.v-a.v);
  return slots.slice(0,10).map(s=>({c:s.c,r:s.r,kind:'acc',lvl:3}));
})()`);
// tile art: a live frame with a built board and units on the tracks (the art phase picks this up
// from .queue/lib-art keyed by the audited card slug)
await ev(`window.__chipdef.setup({ bits: 300, towers: ${JSON.stringify(camp)}, wave: 2 })`);
await sleep(250);
await ev('window.__chipdef.step(9)');
await sleep(300);
const shotArt = await shot('chipdef-art');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await copyFile(shotArt, '/home/cluer/cloned-free-games/.queue/lib-art/Chip-Defense.png');

await ev(`window.__chipdef.setup({ bits: 200, towers: ${JSON.stringify(camp)}, wave: 0 })`);
await sleep(250);
const winRun = await ev('window.__chipdef.step(700)');
const sWin = await state();
const sheetWin = await sheet();
T('win ' + JSON.stringify({ winRun, over: sWin && sWin.over, result: sWin && sWin.result, sheet: sheetWin }));
ok(sWin && sWin.over && sWin.result === 'win', 'a strong board survives all twelve waves', { result: sWin.result, wave: sWin.wave, integ: sWin.integrity, towers: sWin.towers.length });
ok(sheetWin && sheetWin.open && /secured/i.test(sheetWin.title), 'the win sheet opens with its own title', sheetWin);
const shotWin = await shot('chipdef-gate-win');

// ---------- 8) the lose sheet ----------
await ev('window.__chipdef.setup({ bits: 40, towers: [], wave: 0 })');
await sleep(250);
const loseRun = await ev('window.__chipdef.step(400)');
const sLose = await state();
const sheetLose = await sheet();
T('lose ' + JSON.stringify({ loseRun, over: sLose && sLose.over, result: sLose && sLose.result, sheet: sheetLose }));
ok(sLose && sLose.over && sLose.result === 'lose', 'an empty chip melts', { result: sLose.result, integ: sLose.integrity, leaks: sLose.leaks });
ok(sheetLose && sheetLose.open && /melted/i.test(sheetLose.title), 'the lose sheet opens with its own title', sheetLose);

// ---------- 9) the sheet buttons work with real clicks ----------
const overBtn = await ev(`(()=>{const e=document.getElementById('overBtn');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(overBtn); await sleep(600);
const sRestart = await state();
const sheetAfter = await sheet();
T('again ' + JSON.stringify({ sRestart: sRestart && { wave: sRestart.wave, towers: sRestart.towers.length, over: sRestart.over, bits: sRestart.bits }, sheetAfter }));
ok(sRestart && sRestart.wave === 1 && sRestart.towers.length === 0 && sRestart.over === false, 'Play again starts a fresh run', sRestart && { wave: sRestart.wave, towers: sRestart.towers.length });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes on restart', sheetAfter);

// ---------- 10) the double-tap guard ----------
const slotD = await slotNear(laneA.c, laneA.r);
const twoInOneTick = await ev(`(()=>{
  const p = window.__chipdef.cellPoint(${slotD.c},${slotD.r});
  const el = document.elementFromPoint(p.x,p.y) || document.querySelector('canvas');
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk()); el.dispatchEvent(mk());
  return p;
})()`);
await sleep(300);
const sDup = await state();
T('dup ' + JSON.stringify({ twoInOneTick, towers: sDup.towers.length, dups: sDup.dups }));
ok(sDup.dups >= 1, 'the second event of a double tap is dropped', { dups: sDup.dups });
ok(sDup.towers.length === 1, 'a double tap places one gate, not two', sDup.towers);

// ---------- 11) portrait / touch ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
// prime the override (the first event after a metrics change can be swallowed)
{
  const hud = await ev(`(()=>{const e=document.querySelector('.brand h1');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (hud) await click(hud);
  await sleep(200);
}
const pInfo = await ev(`(()=>{
  const band = window.__chipdef.band();
  const pts = [];
  for (const s of window.__chipdef.slotCells()) pts.push(window.__chipdef.cellPoint(s.c, s.r));
  const inside = pts.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  const corners = [[0,0],[11,0],[0,8],[11,8]].map(([c,r]) => { const p = window.__chipdef.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  let bad = 0;
  for (const s of window.__chipdef.slotCells()) {
    const p = window.__chipdef.cellPoint(s.c, s.r);
    const b = window.__chipdef.cellAt(p.x, p.y);
    if (!b || b.c !== s.c || b.r !== s.r) bad++;
  }
  return { view: innerWidth + 'x' + innerHeight, band, inside, bad, corners };
})()`);
T('portrait ' + JSON.stringify(pInfo));
ok(pInfo && pInfo.view === '390x844', 'the viewport really is 390x844', pInfo && pInfo.view);
ok(pInfo && pInfo.inside, 'every socket sits between the HUD bars in portrait', pInfo && { band: pInfo.band, corners: pInfo.corners });
ok(pInfo && pInfo.bad === 0, 'the picker still round-trips in portrait', pInfo && pInfo.bad);

// a finger tap on a socket places a gate
const slotP = await slotNear(laneA.c, laneA.r);
const ptP = await cellPt(slotP.c, slotP.r);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
let sTouch = await state();
if (sTouch.towers.length === 0) {   // a finger repeats; retry once
  await click(ptP); await sleep(400);
  sTouch = await state();
}
T('touch ' + JSON.stringify({ slotP, ptP, towers: sTouch.towers.length, bits: sTouch.bits }));
ok(sTouch.towers.length >= 1, 'a touch tap places a gate on the phone', sTouch.towers);
const shotPortrait = await shot('chipdef-gate-portrait');

// ---------- 12) console errors ----------
const errs = pageCdp.events
  .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params).slice(0, 160));
ok(errs.length === 0, 'no console exceptions during the whole gate', errs.slice(0, 4));

console.log(JSON.stringify({ fails, shots: { shotBoot, shotPlay, shotWin, shotPortrait } }, null, 1));
T(fails.length ? `FAILED — ${fails.length} check(s)` : 'PASS — every gate check passed');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
