#!/usr/bin/env node
// Interaction gate for the Kakuro port. Serves the arcade tree, boots headless Chromium,
// dispatches REAL pointerdown events on the cells and the number pad, and asserts via the
// page hook that the board actually changes (selection, digits, wrong-entry policing, a full
// solve, the win sheet, the lose path, reveal, restart) plus a portrait touch pass.
//
// A canvas that merely exists is not proof: every claim below is read out of window.__kakuro().
//
// usage: node kakuro-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/kakuro/index.html';
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
const PROFILE = mkdtempSync('/tmp/kak-gate-');
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
const S = (m, p) => pageTarget && cdp.send(m, p);
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
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

const state = () => ev('window.__kakuro()');
// Real pointer events, dispatched in the page at the point the hook reports.
const tap = (x, y) => ev(`(()=>{
  const el = document.querySelector('canvas');
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:7, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  el.dispatchEvent(mk('pointerdown'));
  el.dispatchEvent(mk('pointerup'));
  return true;
})()`);
const tapPad = (d) => ev(`(()=>{
  const p = window.__kakuro.padPoint(${d});
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:8, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { el: el.id || el.tagName, x: p.x, y: p.y };
})()`);
const tapCell = async (r, c) => {
  const p = await ev(`window.__kakuro.cellPoint(${r},${c})`);
  await tap(p.x, p.y);
  await sleep(90);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(350);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ hook: typeof (await ev('typeof window.__kakuro')), cells: s0.total, filled: s0.filled, board: s0.board }));
ok((await ev('typeof window.__kakuro')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.total >= 16 && s0.filled === 0 && !s0.over, 'boots empty and playable', s0);
const cam0 = await ev('window.__kakuro.camera()');
ok(cam0.aspect > 1, 'camera framed', cam0);
const shotBoot = await shot('kakuro-gate-boot');

// ---- 2) select a cell, enter a digit, clear it
const cellsList = await ev('window.__kakuro.cells()');
const [r0, c0] = cellsList[0];
await tapCell(r0, c0);
const sSel = await state();
ok(sSel.sel && sSel.sel[0] === r0 && sSel.sel[1] === c0, 'tap selects that cell', sSel.sel);

const d0 = await ev(`window.__kakuro.solAt(${r0},${c0})`);
await tapPad(d0);
const sDig = await state();
ok(sDig.filled === 1, 'pad tap fills the selected cell', { filled: sDig.filled, vals: sDig.values });
await tapPad(0);
const sClr = await state();
ok(sClr.filled === 0, 'clear empties it', sClr.filled);

// ---- 3) an impossible entry is policed (a run whose sum overshoots its clue)
const runsList = await ev('window.__kakuro.runs()');
const pair = runsList.filter((x) => x.cells.length === 2 && x.clue != null).sort((a, b) => a.clue - b.clue)[0];
const A = pair.cells[0], Bc = pair.cells[1];
T('policing run ' + JSON.stringify({ dir: pair.dir, clue: pair.clue, A, B: Bc }));
await tapCell(A[0], A[1]);
await tapPad(9);
const sBad = await state();
ok(sBad.bad >= 1, 'an overshooting entry is flagged', { bad: sBad.bad, clue: pair.clue });
ok(sBad.mistakes >= 1, 'it costs an attempt', sBad.mistakes);
await tapPad(0);
const sAfter = await state();
ok(sAfter.bad === 0, 'clearing drops the flag', { bad: sAfter.bad, filled: sAfter.filled });

// ---- 4) solve the whole board with real taps on cells + pad
let taps = 0;
for (const [r, c] of cellsList) {
  const d = await ev(`window.__kakuro.solAt(${r},${c})`);
  await tapCell(r, c); taps++;
  await tapPad(d); taps++;
  const st = await state();
  if (st.over) break;
}
const sWin = await state();
const winSheet = await sheet();
T('after solve ' + JSON.stringify({ filled: sWin.filled, total: sWin.total, solved: sWin.solved, won: sWin.won, taps, sheet: winSheet.title }));
ok(sWin.filled === sWin.total, 'board fully filled by real taps', { filled: sWin.filled, total: sWin.total });
ok(sWin.solved && sWin.won && sWin.over, 'win state reached', sWin);
ok(winSheet.open && /Solved/.test(winSheet.title), 'win sheet shown', winSheet);
const shotWin = await shot('kakuro-gate-win');

// ---- 5) restart from the sheet
await clickEl('overBtn');
const sNew = await state();
ok(sNew.filled === 0 && !sNew.over && !sNew.won, 'restart clears the board', sNew);

// ---- 6) lose path: five impossible entries in the tightest 2-cell run
await tapCell(A[0], A[1]);
await tapPad(9);
for (let v = 1; v <= 7; v++) {
  const st = await state();
  if (st.over) break;
  await tapCell(Bc[0], Bc[1]);
  await tapPad(v);
}
const sLose = await state();
const loseSheet = await sheet();
T('after lose ' + JSON.stringify({ mistakes: sLose.mistakes, over: sLose.over, title: loseSheet.title, filled: sLose.filled }));
ok(sLose.over && sLose.mistakes >= 5, 'five errors end the board', sLose);
ok(/attempts|answer/i.test(loseSheet.title), 'lose sheet shown', loseSheet);
ok(sLose.filled === sLose.total, 'the answer is revealed on a loss', { filled: sLose.filled, total: sLose.total });

// ---- 7) reveal, then R restart
await clickEl('overBtn');
await clickEl('reveal');
const sRev = await state();
const revSheet = await sheet();
ok(sRev.filled === sRev.total && /Revealed/.test(revSheet.title), 'reveal fills the board and says so', { title: revSheet.title });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await state();
ok(sR.filled === 0 && !sR.over, 'R restarts', sR);

// ---- 8) board switching
await clickEl('overBtn');
await ev(`(()=>{const s=document.getElementById('level'); s.value='2'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
await sleep(500);
const sB3 = await state();
ok(sB3.board === 3 && sB3.total === 24 && sB3.filled === 0, 'board 3 loads (7x7, 24 cells)', sB3);

// ---- 9) console errors before the portrait pass
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---- 10) portrait touch: tap a cell, tap the pad, the board must move
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const touch = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(160);
};
const pc = await ev('window.__kakuro.cells()');
const p0 = await ev(`window.__kakuro.cellPoint(${pc[3][0]},${pc[3][1]})`);
await touch(p0);
const ps1 = await state();
const pp = await ev('window.__kakuro.padPoint(7)');
await touch(pp);
const ps2 = await state();
const shotPhone = await shot('kakuro-gate-phone');
const camP = await ev('window.__kakuro.camera()');
T('portrait ' + JSON.stringify({ sel: ps1.sel, filled: ps2.filled, aspect: camP.aspect }));
ok(ps1.sel && ps1.sel[0] === pc[3][0], 'portrait: finger selects a cell', ps1.sel);
ok(ps2.filled === 1, 'portrait: pad tap fills it', { filled: ps2.filled });
ok(camP.aspect < 1, 'portrait camera reframed', camP);

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotWin, shotPhone],
  boot: { board: s0.board, cells: s0.total },
  win: { filled: sWin.filled, total: sWin.total, taps },
  lose: { mistakes: sLose.mistakes, title: loseSheet.title },
  portrait: { filled: ps2.filled, aspect: camP.aspect },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
