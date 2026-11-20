#!/usr/bin/env node
// Interaction gate for the Quiet Grid port. Serves the arcade tree from the site repo, boots
// headless Chromium, dispatches REAL pointer events on cells and the pad, and asserts via the
// page hook that the board really changes: selection, a placed value, duplicate policing, a full
// solve in each of the three modes, the win sheet, the lose path, reveal, restart, mode switches,
// and a portrait touch pass.
//
// A canvas that merely exists is not proof: every claim below is read out of window.__quietgrid().
//
// usage: node quietgrid-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/quiet-grid-logic-puzzles/index.html';
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
const PROFILE = mkdtempSync('/tmp/qg-gate-');
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const hook = 'window.__quietgrid';
const state = () => ev('window.__quietgrid()');
// Real pointer events at the point the hook reports. One dispatch per event, single target.
const tap = (x, y) => ev(`(()=>{
  const el = document.querySelector('canvas');
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:7, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  el.dispatchEvent(mk('pointerdown'));
  el.dispatchEvent(mk('pointerup'));
  return true;
})()`);
const tapPad = (d) => ev(`(()=>{
  const p = window.__quietgrid.padPoint(${d});
  if (!p) return { missing: ${d} };
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:8, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { el: el.id || el.tagName, x: p.x, y: p.y };
})()`);
const tapCell = async (r, c) => {
  const p = await ev(`window.__quietgrid.cellPoint(${r},${c})`);
  await tap(p.x, p.y);
  await sleep(70);
};
// DOM buttons: the port binds some on pointerdown and some on click, and a JS-dispatched
// pointerdown does NOT synthesise a click. Fire both: pointerdown/up on the element, then a real
// CDP mouse press/release at its centre so click listeners run too.
const clickEl = async (sel) => {
  const css = sel.startsWith('#') || sel.startsWith('[') ? sel : '#' + sel;
  const q = `document.querySelector(${JSON.stringify(css)})`;
  const b = await ev(`(()=>{
    const e = ${q};
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!b) return null;
  await ev(`(()=>{
    const e = ${q};
    const o = {bubbles:true, cancelable:true, composed:true, clientX:${b.x}, clientY:${b.y}, pointerId:9, pointerType:'mouse', isPrimary:true, button:0, buttons:1};
    e.dispatchEvent(new PointerEvent('pointerdown', o));
    e.dispatchEvent(new PointerEvent('pointerup', o));
    return true;
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }
  await sleep(420);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---------------------------------------------------------------- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ hookType: await ev('typeof window.__quietgrid'), mode: s0.mode, board: s0.board, cells: s0.total, filled: s0.filled }));
ok((await ev('typeof window.__quietgrid')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.mode === 'takuzu' && s0.rows === 6 && s0.total === 36, 'boots on Takuzu board 1 (6x6)', s0);
ok(!s0.over && !s0.won, 'opens playable, not solved, not lost', s0);
const cam0 = await ev('window.__quietgrid.camera()');
ok(cam0.aspect > 1, 'camera framed for the landscape viewport', cam0);
const shotBoot = await shot('quietgrid-gate-boot');

// the pad reports its own points
const pad0 = await ev('window.__quietgrid.padPoint(1)');
ok(pad0 && pad0.x > 0 && pad0.y > 0, 'padPoint resolves the digit key', pad0);

// ---------------------------------------------------------------- 2) select + place a correct value
const info = await ev('window.__quietgrid.cellInfo()');
const openCells = info.filter((x) => !x.given);
const [r0, c0] = [openCells[0].r, openCells[0].c];
await tapCell(r0, c0);
const sSel = await state();
ok(sSel.sel && sSel.sel[0] === r0 && sSel.sel[1] === c0, 'tap selects that cell', sSel.sel);
const d0 = await ev(`window.__quietgrid.solAt(${r0},${c0})`);
await tapPad(d0);
const sPut = await state();
ok(sPut.filled === s0.filled + 1 && sPut.mistakes === 0, 'pad tap places the value without an error', { filled: sPut.filled, mistakes: sPut.mistakes });
await tapPad(-1);
const sClr = await state();
ok(sClr.filled === s0.filled, 'Clear empties it again', sClr.filled);

// ---------------------------------------------------------------- 3) policing: a definitive violation costs an attempt
// Ask the port (read-only probe) which (cell, value) would be a certain violation, then perform
// exactly that tap and assert the board flags it and the error budget moves.
let badTap = null;
const padVals = s0.pad;
for (const cell of openCells) {
  for (const v of padVals) {
    if (await ev(`window.__quietgrid.probeBad(${cell.r},${cell.c},${v})`)) { badTap = { r: cell.r, c: cell.c, v }; break; }
  }
  if (badTap) break;
}
ok(!!badTap, 'a definitively wrong entry exists to test with', badTap);
if (badTap) {
  await tapCell(badTap.r, badTap.c);
  await tapPad(badTap.v);
}
const sBad = await state();
ok(sBad.bad >= 1, 'a fourth 1 / triple in a line is flagged', { bad: sBad.bad });
ok(sBad.mistakes >= 1, 'it costs one of five attempts', sBad.mistakes);
await tapPad(-1);
const sAfter = await state();
ok(sAfter.bad === 0, 'clearing drops the flag', { bad: sAfter.bad });

// ---------------------------------------------------------------- 4) solve Takuzu with real taps
let taps = 0;
for (const cell of openCells) {
  const sol = await ev(`window.__quietgrid.solAt(${cell.r},${cell.c})`);
  await tapCell(cell.r, cell.c); taps++;
  await tapPad(sol); taps++;
  if ((await state()).over) break;
}
const sWin = await state();
const winSheet = await sheet();
T('takuzu solve ' + JSON.stringify({ filled: sWin.filled, total: sWin.total, solved: sWin.solved, won: sWin.won, taps, title: winSheet.title }));
ok(sWin.filled === sWin.total, 'Takuzu board fully filled by real taps', { filled: sWin.filled });
ok(sWin.solved && sWin.won && sWin.over, 'Takuzu win state reached', sWin);
ok(winSheet.open && /Solved|cleared/i.test(winSheet.title), 'win sheet shown', winSheet);
const shotWin = await shot('quietgrid-gate-win');

// ---------------------------------------------------------------- 5) restart from the sheet
await clickEl('overBtn');
const sNew = await state();
ok(sNew.filled === s0.filled && !sNew.over && !sNew.won, 'Play again resets the board', { filled: sNew.filled, boot: s0.filled });

// ---------------------------------------------------------------- 6) mode switch -> Mini Sudoku, solve it
await clickEl('[data-mode="sudoku"]');
const sSud = await state();
ok(sSud.mode === 'sudoku' && sSud.total === 36, 'mode button switches to Mini Sudoku', { mode: sSud.mode, total: sSud.total });
const infoS = await ev('window.__quietgrid.cellInfo()');
const openS = infoS.filter((x) => !x.given);
for (const cell of openS) {
  const sol = await ev(`window.__quietgrid.solAt(${cell.r},${cell.c})`);
  await tapCell(cell.r, cell.c);
  await tapPad(sol);
  if ((await state()).over) break;
}
const sSudWin = await state();
const sudSheet = await sheet();
T('sudoku solve ' + JSON.stringify({ filled: sSudWin.filled, total: sSudWin.total, won: sSudWin.won, title: sudSheet.title }));
ok(sSudWin.won && sSudWin.solved && sSudWin.over, 'Mini Sudoku solved by real taps', sSudWin);
ok(sudSheet.open && /Solved/i.test(sudSheet.title), 'sudoku win sheet shown', sudSheet);
const shotSud = await shot('quietgrid-gate-sudoku');

// ---------------------------------------------------------------- 7) mode switch -> Star Battle, solve it
await clickEl('[data-mode="starbattle"]');
const sStar = await state();
ok(sStar.mode === 'starbattle' && sStar.total === 25, 'mode button switches to Star Battle', { mode: sStar.mode, total: sStar.total });
const stars = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if ((await ev(`window.__quietgrid.solAt(${r},${c})`)) === 1) stars.push([r, c]);
ok(stars.length === 5, 'the board stores five stars', stars);
for (const [r, c] of stars) {
  await tapCell(r, c);
  await tapPad(1);
  if ((await state()).over) break;
}
const sStarWin = await state();
const starSheet = await sheet();
T('star battle solve ' + JSON.stringify({ stars: sStarWin.stars, won: sStarWin.won, title: starSheet.title }));
ok(sStarWin.stars === 5 && sStarWin.won && sStarWin.over, 'Star Battle solved by placing five stars', sStarWin);
const shotStar = await shot('quietgrid-gate-star');

// ---------------------------------------------------------------- 8) lose path: five stars in one row
await clickEl('overBtn');
outer:
for (let r = 0; r < 5; r++) {
  for (let c = 0; c < 5; c++) {
    const st = await state();
    if (st.over) break outer;
    await tapCell(r, c);
    await tapPad(1);
  }
}
const sLose = await state();
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ stars: sLose.stars, mistakes: sLose.mistakes, over: sLose.over, title: loseSheet.title }));
ok(sLose.over && sLose.mistakes >= 5, 'five impossible stars end the board', sLose);
ok(/attempts/i.test(loseSheet.title), 'lose sheet shown', loseSheet);
ok(sLose.filled === sLose.total, 'the answer is revealed on a loss', { filled: sLose.filled, total: sLose.total });

// ---------------------------------------------------------------- 9) reveal, then R restart
await clickEl('overBtn');
await clickEl('reveal');
const sRev = await state();
const revSheet = await sheet();
ok(sRev.over && /Revealed/i.test(revSheet.title), 'reveal fills the board and says so', { title: revSheet.title });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await state();
ok(!sR.over && sR.mistakes === 0, 'R restarts the board', { over: sR.over, mistakes: sR.mistakes });

// ---------------------------------------------------------------- 10) board 2 of the current mode
await ev(`(()=>{const s=document.getElementById('level'); s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
await sleep(500);
const sB2 = await state();
ok(sB2.board === 2 && !sB2.over, 'board 2 loads', { board: sB2.board });

// every cell must resolve to a point over the canvas, clear of the HUD bars
const geom = await ev(`(()=>{
  const c = document.querySelector('canvas').getBoundingClientRect();
  const pad = document.getElementById('pad').getBoundingClientRect();
  const top = document.querySelector('.top').getBoundingClientRect();
  const out = [];
  for (let r = 0; r < 5; r++) for (let cc = 0; cc < 5; cc++) out.push(window.__quietgrid.cellPoint(r, cc));
  return { canvas: { t: c.top, b: c.bottom, l: c.left, r: c.right }, padTop: pad.top, topBottom: top.bottom,
    pts: out.filter((p) => p).map((p) => [Math.round(p.x), Math.round(p.y)]) };
})()`);
ok(geom.pts.length === 25, 'every cell reports a screen point', geom.pts.length);
ok(geom.pts.every(([, y]) => y > geom.topBottom && y < geom.padTop), 'every cell point sits between the HUD bars',
  { topBottom: Math.round(geom.topBottom), padTop: Math.round(geom.padTop), ys: [...new Set(geom.pts.map((p) => p[1]))] });

// ---------------------------------------------------------------- 11) console errors
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---------------------------------------------------------------- 12) portrait touch pass
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const touch = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(180);
};
const pInfo = await ev('window.__quietgrid.cellInfo()');
const pOpen = pInfo.filter((x) => !x.given)[3];
const pPoint = await ev(`window.__quietgrid.cellPoint(${pOpen.r},${pOpen.c})`);
await touch(pPoint);
const ps1 = await state();
const pd = await ev(`window.__quietgrid.solAt(${pOpen.r},${pOpen.c})`);
const pPad = await ev(`window.__quietgrid.padPoint(${pd})`);
await touch(pPad);
const ps2 = await state();
const shotPhone = await shot('quietgrid-gate-phone');
const camP = await ev('window.__quietgrid.camera()');
T('portrait ' + JSON.stringify({ sel: ps1.sel, filled: ps2.filled, aspect: camP.aspect }));
ok(ps1.sel && ps1.sel[0] === pOpen.r && ps1.sel[1] === pOpen.c, 'portrait: finger selects a cell', ps1.sel);
ok(ps2.filled > ps1.filled, 'portrait: pad tap places the value', { before: ps1.filled, after: ps2.filled });
ok(camP.aspect < 1 && camP.dist > cam0.dist, 'portrait camera reframed for the tall viewport', camP);

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotWin, shotSud, shotStar, shotPhone],
  takuzu: { filled: sWin.filled, total: sWin.total, taps },
  sudoku: { filled: sSudWin.filled, won: sSudWin.won },
  starbattle: { stars: sStarWin.stars, won: sStarWin.won },
  lose: { mistakes: sLose.mistakes, title: loseSheet.title },
  portrait: { filled: ps2.filled, aspect: camP.aspect },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
