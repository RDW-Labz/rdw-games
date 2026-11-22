#!/usr/bin/env node
// Interaction gate for the Queens port: serves the arcade tree, boots headless Chromium, and
// drives REAL input — CDP mouse taps on cells and buttons, plus a portrait touch tap at
// 390x844. Each claim is read from window.__queens(); a canvas that merely exists is not proof.
//
// usage: node queens-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/queens/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
const PROFILE = mkdtempSync('/tmp/qns-gate-');
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

const state = () => ev('window.__queens()');
const pt = async (r, c) => ev(`window.__queens.cellPoint(${r},${c})`);
async function tapCell(r, c) {
  const A = await pt(r, c);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: A.x, y: A.y, button: 'none', pointerType: 'mouse' });
  for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: A.x, y: A.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(150);
}
async function clickEl(id) {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(420);
}
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot
const s0 = await state();
ok((await ev('typeof window.__queens')) === 'function', 'hook is a function', typeof s0);
ok(s0.n === 6 && s0.count === 0 && !s0.over, 'boots empty and playable', s0);
ok(s0.left > 60, 'clock armed on boot', { left: s0.left });
const geom = await ev(`(() => {
  const st = window.__queens(), b = window.__queens.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < st.n; r++) for (let c = 0; c < st.n; c++) {
    const p = window.__queens.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    const nx = 2 * (p.x - cv.left) / cv.width - 1;
    if (ny > b.top || ny < b.bottom || Math.abs(nx) > 0.97) bad.push([r, c, ny.toFixed(2), nx.toFixed(2)]);
  }
  return { cells: st.n * st.n, bad };
})()`);
ok(geom.bad.length === 0, 'every cell is tappable inside the play band', geom);
const shotBoot = await shot('queens-gate-boot');

// ---- 2) a tap places a queen; a second tap on the same cell lifts it
await tapCell(0, 0);
let s1 = await state();
ok(s1.count === 1 && s1.queens[0].join(',') === '0,0', 'a tap places a queen', s1.queens);
ok(s1.taps === 1 && s1.dups === 0, 'one tap counted, no duplicate swallowed', { taps: s1.taps, dups: s1.dups });
await tapCell(0, 0);
let s2 = await state();
ok(s2.count === 0, 'a second tap on the same cell lifts it', s2.queens);

// ---- 3) a conflicting pair is flagged (row, then diagonal)
await tapCell(0, 0);
await tapCell(0, 3);            // same row: the row's queen is replaced, so this must stay at 1
let sRow = await state();
ok(sRow.count === 1 && sRow.queens[0].join(',') === '0,3', 'a row can only hold one queen', sRow.queens);
await tapCell(2, 5);            // diagonal to (0,3): both stay and clash
let sClash = await state();
ok(sClash.count === 2 && sClash.conflicts >= 1, 'a shared diagonal is flagged as a conflict', { q: sClash.queens, cf: sClash.conflicts });
await clickEl('undo');
let sUndo = await state();
ok(sUndo.count === 1, 'undo removes the last queen', sUndo.queens);

// ---- 4) solve with real taps on the stored answer
await clickEl('overBtn'); // no sheet yet; harmless
const sol = (await state()).solution;
let tapsUsed = 0;
let shotMid = null;
for (const [r, c] of sol) {
  await tapCell(r, c);
  tapsUsed++;
  if (tapsUsed === sol.length - 1) shotMid = await shot('queens-gate-mid');
  const st = await state();
  if (st.over) break;
}
const sWin = await state();
const winSheet = await sheet();
T('after solve ' + JSON.stringify({ count: sWin.count, won: sWin.won, conflicts: sWin.conflicts, sheet: winSheet.title, tapsUsed }));
ok(sWin.count === sWin.n && sWin.solvedNow && sWin.won && sWin.over, 'win state reached by real taps', sWin);
ok(sWin.conflicts === 0, 'the winning placement has no conflicts', sWin.conflicts);
ok(winSheet.open && /Solved/.test(winSheet.title), 'win sheet shown', winSheet);
const shotWin = await shot('queens-gate-win');

// ---- 5) restart from the sheet's own button
await clickEl('overBtn');
const sNew = await state();
ok(sNew.count === 0 && !sNew.over && !sNew.won, 'restart clears the board', sNew);

// ---- 6) lose path on the wall clock
await ev('window.__queens.qaTime(400)');
await sleep(1400);
const sLose = await state();
const loseSheet = await sheet();
T('after timeout ' + JSON.stringify({ over: sLose.over, count: sLose.count, title: loseSheet.title }));
ok(sLose.over && /time/i.test(loseSheet.title), 'the clock ends the board', loseSheet);
ok(sLose.count === sLose.n, 'the answer is shown on a loss', sLose.count);

// ---- 7) reveal + 8x8 board + R restart
await clickEl('overBtn');
await clickEl('reveal');
const revSheet = await sheet();
ok(/Revealed/.test(revSheet.title) && (await state()).count === 6, 'reveal fills the board', revSheet);
await clickEl('overBtn');
await ev(`(()=>{const s=document.getElementById('level'); s.value='2'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
await sleep(700);
const sB3 = await state();
ok(sB3.n === 8 && sB3.count === 0, 'board 3 loads (8x8)', sB3);
const geom8 = await ev(`(() => {
  const st = window.__queens(), b = window.__queens.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < st.n; r++) for (let c = 0; c < st.n; c++) {
    const p = window.__queens.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom) bad.push([r, c, ny.toFixed(2)]);
  }
  return { bad };
})()`);
ok(geom8.bad.length === 0, 'the 8x8 board still fits the band', geom8);
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
ok((await state()).count === 0, 'R restarts', await state());

// ---- 8) console errors
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---- 9) portrait: 390x844 touch tap places a queen
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const camP = await ev('window.__queens.camera()');
const geomP = await ev(`(() => {
  const st = window.__queens(), b = window.__queens.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < st.n; r++) for (let c = 0; c < st.n; c++) {
    const p = window.__queens.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom) bad.push([r, c, ny.toFixed(2)]);
  }
  return { bad, n: st.n };
})()`);
ok(geomP.bad.length === 0, 'portrait: every cell inside the play band', geomP);
const tgt = (await state()).solution[1];
const tp = await pt(tgt[0], tgt[1]);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp.x, y: tp.y, radiusX: 9, radiusY: 9, force: 1 }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const sTouch = await state();
const shotPhone = await shot('queens-gate-phone');
T('portrait ' + JSON.stringify({ count: sTouch.count, queens: sTouch.queens, aspect: camP.aspect }));
ok(sTouch.count === 1, 'portrait: a finger tap places a queen', sTouch.queens);
ok(camP.aspect < 1, 'portrait camera reframed', camP);

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotWin, shotPhone],
  boot: { n: s0.n },
  win: { count: sWin.count, tapsUsed, sheet: winSheet.title },
  lose: { title: loseSheet.title, count: sLose.count },
  touch: { count: sTouch.count },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
