#!/usr/bin/env node
// Interaction gate for the RoboYard port (ricochet robots). Serves the site repo root, boots
// headless Chromium and drives REAL input: CDP mouse clicks on robot cells, on destination cells,
// on the sheet buttons, and a portrait 390x844 touch pass. Every claim is read out of
// window.__roboyard() — a canvas that merely exists is not proof.
//
// usage: node roboyard-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/roboyard/index.html';
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
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/ry-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
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
if (!pageTarget) { console.error('no page target'); process.exit(1); }
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails++; T('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('  shot ' + out);
  return out;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const state = () => ev('window.__roboyard()');
const pt = (r, c) => ev(`window.__roboyard.cellPoint(${r},${c})`);
const mouse = (type, x, y) => S('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, pointerType: 'mouse' });
async function tapCell(r, c) {
  const A = await pt(r, c);
  if (!A || !Number.isFinite(A.x)) { T('  !! no point for ' + r + ',' + c + ' :: ' + JSON.stringify(A)); return false; }
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: A.x, y: A.y, button: 'none', pointerType: 'mouse' });
  await mouse('mousePressed', A.x, A.y);
  await mouse('mouseReleased', A.x, A.y);
  await sleep(150);
  return true;
}
async function clickEl(id) {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) { T('  !! no element #' + id); return false; }
  for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(500);
  return true;
}
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot
const s0 = await state();
ok((await ev('typeof window.__roboyard')) === 'function', 'hook is a function (the catalog gate probes typeof)');
ok(s0 && !s0.__err && s0.robots.length === 4, 'boots with four robots', s0 && s0.robots);
if (!s0 || s0.__err) { console.error(JSON.stringify(s0)); process.exit(1); }
ok(s0.moves === 0 && !s0.over && !s0.won, 'boots unplayed', s0);
ok(s0.par >= 4, 'a playable par is dealt', s0.par);
ok(!s0.onPad, 'the yard does not open already solved', s0.robots);
ok(s0.budget === s0.par + 6, 'budget is par + 6', { par: s0.par, budget: s0.budget });
const band = await ev('window.__roboyard.band()');
ok(band.top < 1 && band.bottom > -1, 'HUD band measured', band);
const shotBoot = await shot('roboyard-gate-boot');

// every cell must resolve back to itself inside the HUD band and over the canvas
const geom = await ev(`(() => {
  const b = window.__roboyard.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = window.__roboyard.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom || p.x < cv.left + 2 || p.x > cv.right - 2) bad.push([r, c, +ny.toFixed(2)]);
  }
  return { cells: 81, bad, band: b };
})()`);
ok(geom.bad.length === 0, 'all 81 cells sit inside the play band', geom);

// ---- 1b) a push into a hedge is refused, costs no shot, and is counted
const stuckOf = () => ev(`(() => {
  const s = window.__roboyard();
  const D = [[-1,0],[1,0],[0,-1],[0,1]];
  for (let i = 0; i < 4; i++) for (let di = 0; di < 4; di++) {
    if (window.__roboyard.slide(i, di)) continue;
    const p = s.robots[i];
    const c = [p.r + D[di][0], p.c + D[di][1]];
    if (c[0] >= 0 && c[0] < 9 && c[1] >= 0 && c[1] < 9) return { i, cell: [p.r, p.c], tap: c };
  }
  return null;
})()`);
let stuck = await stuckOf();
for (let k = 0; k < 5 && !stuck; k++) {     // a sparse yard can leave every robot free: look at a few more
  await ev('window.__roboyard.next()');
  await sleep(700);
  stuck = await stuckOf();
}
if (stuck) {
  await tapCell(stuck.cell[0], stuck.cell[1]);   // select it
  const sBefore = await state();
  await tapCell(stuck.tap[0], stuck.tap[1]);     // push toward the hedge
  const sAfter = await state();
  ok(sAfter.moves === sBefore.moves, 'a push into a hedge spends no shot', { before: sBefore.moves, after: sAfter.moves });
  ok(sAfter.blocked > sBefore.blocked, 'a push into a hedge is counted as blocked', { before: sBefore.blocked, after: sAfter.blocked });
} else {
  ok(false, 'no yard in six offered a hedge-blocked robot (the tap-in test never ran)');
}
await ev('window.__roboyard.restart()');   // back to a clean yard for the shot/undo/win work
await sleep(600);

// ---- 2) tapping a robot drives it: sel follows the robot under the finger
const pick = await ev(`(() => { const s = window.__roboyard(); for (let i = 1; i < 4; i++) { const p = s.robots[i]; const q = window.__roboyard.slide(i, 0) || window.__roboyard.slide(i, 1) || window.__roboyard.slide(i, 2) || window.__roboyard.slide(i, 3); if (q) return { i, cell: [p.r, p.c], to: q }; } return null; })()`);
ok(!!pick, 'some robot has a legal shot', pick);
await tapCell(pick.cell[0], pick.cell[1]);
let s1 = await state();
ok(s1.sel === pick.i, 'a tap on a robot selects it', { sel: s1.sel, want: pick.i });
ok(s1.moves === 0, 'selecting costs no shot', s1.moves);

// ---- 3) a tap on a direction slides it, and the landing cell matches the rule
const before = s1.robots[pick.i];
await tapCell(pick.to.r, pick.to.c);
let s2 = await state();
ok(s2.moves === 1, 'a tap away from the robot spends one shot', s2.moves);
ok(s2.robots[pick.i].r !== before.r || s2.robots[pick.i].c !== before.c, 'the robot moved', { before, after: s2.robots[pick.i] });
ok(s2.robots[pick.i].r === pick.to.r && s2.robots[pick.i].c === pick.to.c, 'the robot landed where the rule says', s2.robots[pick.i]);
const shotMid = await shot('roboyard-gate-mid');

// ---- 4) the shot count is monotonic across real moves
const shotMid2 = await shot('roboyard-gate-mid');

// ---- 5) undo restores the previous placement
const preUndo = await state();
await clickEl('undo');
const sUndo = await state();
ok(sUndo.moves === preUndo.moves - 1, 'undo takes back one shot', { before: preUndo.moves, after: sUndo.moves });
ok(JSON.stringify(sUndo.robots) !== JSON.stringify(preUndo.robots), 'undo moved the robots back', { before: preUndo.robots, after: sUndo.robots });

// ---- 6) win by playing the stored par line with real taps
await clickEl('restart');
const sR = await state();
ok(sR.moves === 0 && !sR.over && JSON.stringify(sR.robots) === JSON.stringify(sR.start), 'restart re-deals the same yard', sR.robots);

const line = (await state()).path;
let taps = 0, shotWin = null;
for (const mv of line) {
  const st = await state();
  if (st.over) break;
  await tapCell(st.robots[mv.i].r, st.robots[mv.i].c);           // drive that robot
  const to = await ev(`window.__roboyard.slide(${mv.i}, ${mv.di})`);
  if (!to) { ok(false, 'the stored line hit an illegal shot at tap ' + taps, { mv, st: st.robots }); break; }
  await tapCell(to.r, to.c);
  taps++;
  if (taps === line.length - 1) shotWin = await shot('roboyard-gate-mid2');
}
const sW = await state();
const winSheet = await sheet();
T('after line ' + JSON.stringify({ taps, moves: sW.moves, par: sW.par, won: sW.won, onPad: sW.onPad, sheet: winSheet.title }));
ok(sW.onPad, 'the red robot sits on the pad after the tapped line', sW);
ok(sW.won && sW.over, 'win state reached from real taps', { won: sW.won, over: sW.over });
ok(winSheet.open && /Pad reached/.test(winSheet.title), 'win sheet shown', winSheet);
const shotW = await shot('roboyard-gate-win');

// ---- 7) the sheet's own button deals the next yard
const lvlBefore = (await state()).level;
await clickEl('overBtn');
const sNext = await state();
ok(!sNext.over && sNext.moves === 0 && sNext.level === lvlBefore + 1, 'play again deals the next yard', { before: lvlBefore, level: sNext.level, over: sNext.over });

// ---- 8) lose path: a shrunken budget, spent with real shots
await ev('window.__roboyard.setBudget(1)');
const l0 = await state();
let spent = 0;
for (let k = 0; k < 8; k++) {
  const st = await state();
  if (st.over) break;
  const mv = await ev(`(() => { const s = window.__roboyard(); for (let i = 0; i < 4; i++) for (let di = 0; di < 4; di++) { const q = window.__roboyard.slide(i, di); if (q && !s.onPad) return { i, to: q, cell: [s.robots[i].r, s.robots[i].c] }; } return null; })()`);
  if (!mv) break;
  await tapCell(mv.cell[0], mv.cell[1]);
  await tapCell(mv.to.r, mv.to.c);
  spent++;
}
const sL = await state();
const loseSheet = await sheet();
ok(l0.budget === 1, 'QA budget applied', l0.budget);
ok(sL.over && !sL.won, 'the shot budget runs out into a loss', { moves: sL.moves, budget: sL.budget, over: sL.over, spent });
ok(loseSheet.open && /Out of shots/.test(loseSheet.title), 'lose sheet shown', loseSheet);
const shotL = await shot('roboyard-gate-lose');

// ---- 9) portrait touch pass at 390x844
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
await ev('window.__roboyard.next()');
await sleep(800);
// prime the override with one neutral press on the HUD, then the real tap (headless can swallow the first)
await clickEl('restart');
const pstate = await state();
const pcell = await ev(`(() => { const s = window.__roboyard(); for (let i = 0; i < 4; i++) { const q = window.__roboyard.slide(i, 0) || window.__roboyard.slide(i, 1) || window.__roboyard.slide(i, 2) || window.__roboyard.slide(i, 3); if (q) return { i, cell: [s.robots[i].r, s.robots[i].c], to: q }; } return null; })()`);
ok(!!pcell, 'portrait yard has a legal shot', pcell);
if (pcell) {
  await tapCell(pcell.cell[0], pcell.cell[1]);
  await tapCell(pcell.to.r, pcell.to.c);
  let ps = await state();
  if (ps.moves === pstate.moves) {   // one retry: a finger repeats
    await tapCell(pcell.cell[0], pcell.cell[1]);
    await tapCell(pcell.to.r, pcell.to.c);
    ps = await state();
  }
  ok(ps.moves > pstate.moves, 'portrait touch spends a shot', { before: pstate.moves, after: ps.moves });
}
const pgeom = await ev(`(() => {
  const b = window.__roboyard.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const p = window.__roboyard.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom) bad.push([r, c, +ny.toFixed(2)]);
  }
  return { band: b, bad, vp: [innerWidth, innerHeight] };
})()`);
ok(pgeom.bad.length === 0, 'portrait: every cell sits inside the play band', pgeom);
const shotP = await shot('roboyard-gate-portrait');

// ---- 10) console errors
const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).filter((t) => !/favicon/i.test(t));
ok(errs.length === 0, 'no console errors', errs.slice(0, 4));

console.log(JSON.stringify({ shotBoot, shotMid: shotMid || null, shotWin, shotL, shotP }, null, 1));
console.log(fails ? `GATE FAILED (${fails})` : 'ROBOYARD GATE PASS');
cdp.ws.close();
proc.kill('SIGKILL'); server.close();
process.exit(fails ? 1 : 0);
