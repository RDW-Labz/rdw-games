#!/usr/bin/env node
// Interaction gate for the Shikaku port. Serves the arcade tree, boots headless Chromium, and
// drives REAL input: CDP mouse drags from corner to corner of each rectangle, a tap on a "1"
// clue, sheet buttons through Input.dispatchMouseEvent, and a portrait touch drag at 390x844.
// Every claim is read out of window.__shikaku() — a canvas that merely exists is not proof.
//
// usage: node shikaku-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/shikaku/index.html';
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
const PROFILE = mkdtempSync('/tmp/shk-gate-');
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

const state = () => ev('window.__shikaku()');
const pt = async (r, c) => ev(`window.__shikaku.cellPoint(${r},${c})`);
const mouse = (type, x, y) => S('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, pointerType: 'mouse' });
// a real drag: press on the first corner, glide across, release on the opposite corner
async function drag(a, b) {
  const A = await pt(a[0], a[1]), B = await pt(b[0], b[1]);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: A.x, y: A.y, button: 'none', pointerType: 'mouse' });
  await mouse('mousePressed', A.x, A.y);
  for (let k = 1; k <= 4; k++) {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(A.x + (B.x - A.x) * k / 4), y: Math.round(A.y + (B.y - A.y) * k / 4), button: 'left', pointerType: 'mouse' });
    await sleep(15);
  }
  await mouse('mouseReleased', B.x, B.y);
  await sleep(110);
}
async function tapCell(r, c) {
  const A = await pt(r, c);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: A.x, y: A.y, button: 'none', pointerType: 'mouse' });
  await mouse('mousePressed', A.x, A.y);
  await mouse('mouseReleased', A.x, A.y);
  await sleep(140);
}
async function clickEl(id) {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
}
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot
const s0 = await state();
ok((await ev('typeof window.__shikaku')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.n === 5 && s0.covered === 0 && s0.placed === 0 && !s0.over, 'boots empty and playable', s0);
ok(s0.left > 60, 'clock is armed on boot', { left: s0.left });
const band = await ev('window.__shikaku.band()');
ok(band.top < 1 && band.bottom > -1, 'HUD band measured', band);
const shotBoot = await shot('shikaku-gate-boot');

// every clue must be tappable inside the band and over the canvas (not behind a bar)
const geom = await ev(`(() => {
  const st = window.__shikaku();
  const b = window.__shikaku.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  let bad = [];
  for (const [r, c, v] of st.clues) {
    const p = window.__shikaku.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom || p.x < cv.left + 2 || p.x > cv.right - 2 || p.y < cv.top + 2 || p.y > cv.bottom - 2) bad.push([r, c, v, ny.toFixed(2)]);
  }
  return { clues: st.clues.length, bad };
})()`);
ok(geom.bad.length === 0, 'every clue sits inside the play band', geom);

// ---- 2) a tap on a non-clue cell selects it (pending) and changes nothing yet
const firstRect = s0.solution[0];
const nonClue = await ev(`(() => {
  const st = window.__shikaku();
  const L = st.n;
  for (let r = 0; r < L; r++) for (let c = 0; c < L; c++) {
    if (!st.clues.some(([rr, cc]) => rr === r && cc === c)) return [r, c];
  }
  return null;
})()`);
await tapCell(nonClue[0], nonClue[1]);
const sPend = await state();
ok(sPend.pending && sPend.pending[0] === nonClue[0] && sPend.pending[1] === nonClue[1], 'tap selects a first corner', sPend.pending);
ok(sPend.covered === 0, 'selection alone covers nothing', sPend.covered);

// ---- 3) a wrong box is refused and counted
const wrongBox = await ev(`(() => {
  const st = window.__shikaku();
  const [r0, c0, r1, c1] = st.solution[0];
  return [r0, c0, r1, c1];
})()`);
await drag([wrongBox[0], wrongBox[1]], [Math.min(4, wrongBox[2] + 1), wrongBox[3]]);
let sWrong = await state();
if (sWrong.placed === 0 && sWrong.wrong === 0) {
  // the grown box may have landed on a legal area by luck; force a clearly illegal 1x1 on a non-clue cell
  await drag(nonClue, nonClue);
  sWrong = await state();
}
ok(sWrong.placed === 0, 'an illegal box places nothing', sWrong);
ok(sWrong.wrong >= 1, 'an illegal box costs a wrong-box count', sWrong.wrong);

// ---- 4) a legal box by drag: claim a real solution rectangle
const legal = (await state()).solution.filter((p) => (p[2] - p[0] + 1) * (p[3] - p[1] + 1) > 1)[0];
const before = (await state()).covered;
await drag([legal[0], legal[1]], [legal[2], legal[3]]);
const sLegal = await state();
ok(sLegal.placed === 1, 'a legal drag places a rectangle', sLegal);
ok(sLegal.covered === before + (legal[2] - legal[0] + 1) * (legal[3] - legal[1] + 1), 'the covered count grew by the box area', sLegal);

// ---- 5) undo drops it again
await clickEl('undo');
const sUndo = await state();
ok(sUndo.placed === 0 && sUndo.covered === 0, 'undo removes the box', sUndo);

// ---- 6) a tap on a "1" clue claims it in one gesture (the one-point click path)
const oneCell = await ev(`(() => { const st = window.__shikaku(); const c = st.clues.find((x) => x[2] === 1); return c ? [c[0], c[1]] : null; })()`);
await tapCell(oneCell[0], oneCell[1]);
const sOne = await state();
ok(sOne.placed === 1 && sOne.covered === 1, 'a tap on a 1 clue claims that cell', sOne);
await clickEl('undo');

// ---- 7) solve the whole board with real drags/taps from the stored division
const sol = (await state()).solution;
let moves = 0;
let shotMid = null;
for (const [r0, c0, r1, c1] of sol) {
  if (r0 === r1 && c0 === c1) await tapCell(r0, c0); else await drag([r0, c0], [r1, c1]);
  moves++;
  if (moves === sol.length - 1) shotMid = await shot('shikaku-gate-mid');
  const st = await state();
  if (st.over) break;
}
const sWin = await state();
const winSheet = await sheet();
T('after solve ' + JSON.stringify({ placed: sWin.placed, covered: sWin.covered, won: sWin.won, sheet: winSheet.title, moves }));
ok(sWin.covered === sWin.total, 'board fully covered by real drags', sWin);
ok(sWin.solvedNow && sWin.won && sWin.over, 'win state reached', sWin);
ok(winSheet.open && /Solved/.test(winSheet.title), 'win sheet shown', winSheet);
const shotWin = await shot('shikaku-gate-win');

// ---- 8) restart from the sheet's own button
await clickEl('overBtn');
const sNew = await state();
ok(sNew.covered === 0 && !sNew.over && !sNew.won, 'restart clears the board', sNew);

// ---- 9) lose path: the wall-clock budget runs out (setTimeout, not rAF)
await ev('window.__shikaku.qaTime(400)');
await sleep(1400);
const sLose = await state();
const loseSheet = await sheet();
T('after timeout ' + JSON.stringify({ over: sLose.over, title: loseSheet.title, covered: sLose.covered }));
ok(sLose.over, 'the clock ends the board', sLose);
ok(/time/i.test(loseSheet.title), 'timeout sheet shown', loseSheet);
ok(sLose.covered === sLose.total, 'the division is shown on a loss', sLose);

// ---- 10) reveal + board switch (8x8), then R restart
await clickEl('overBtn');
await clickEl('reveal');
const revSheet = await sheet();
ok(/Revealed/.test(revSheet.title) && (await state()).covered === 25, 'reveal fills the board', revSheet);
await clickEl('overBtn');
await ev(`(()=>{const s=document.getElementById('level'); s.value='3'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
await sleep(600);
const sB4 = await state();
ok(sB4.n === 8 && sB4.covered === 0 && sB4.total === 64, 'board 4 loads (8x8)', sB4);
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
ok((await state()).covered === 0, 'R restarts', await state());

// ---- 11) console errors before the portrait pass
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---- 12) portrait: 390x844, real touch drag on a solution rectangle
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const camP = await ev('window.__shikaku.camera()');
const bandP = await ev('window.__shikaku.band()');
const geomP = await ev(`(() => {
  const st = window.__shikaku();
  const b = window.__shikaku.band();
  const cv = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (const [r, c, v] of st.clues) {
    const p = window.__shikaku.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top || ny < b.bottom) bad.push([r, c, v, ny.toFixed(2)]);
  }
  return { bad, n: st.n };
})()`);
ok(geomP.bad.length === 0, 'portrait: every clue inside the play band', geomP);
const pRect = (await state()).solution.filter((p) => p[2] > p[0] || p[3] > p[1])[0];
const pa = await pt(pRect[0], pRect[1]), pb = await pt(pRect[2], pRect[3]);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pa.x, y: pa.y, radiusX: 9, radiusY: 9, force: 1 }] });
for (let k = 1; k <= 3; k++) {
  await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(pa.x + (pb.x - pa.x) * k / 3), y: Math.round(pa.y + (pb.y - pa.y) * k / 3), radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(20);
}
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const sTouch = await state();
const shotPhone = await shot('shikaku-gate-phone');
T('portrait ' + JSON.stringify({ placed: sTouch.placed, covered: sTouch.covered, aspect: camP.aspect }));
ok(sTouch.placed >= 1, 'portrait: a finger drag places a rectangle', sTouch);
ok(camP.aspect < 1, 'portrait camera reframed', camP);

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotWin, shotPhone],
  boot: { n: s0.n, total: s0.total },
  win: { covered: sWin.covered, total: sWin.total, moves, sheet: winSheet.title },
  lose: { title: loseSheet.title, covered: sLose.covered },
  touch: { placed: sTouch.placed, covered: sTouch.covered },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
