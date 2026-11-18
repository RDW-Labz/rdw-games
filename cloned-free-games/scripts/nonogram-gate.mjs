#!/usr/bin/env node
// Interaction gate for the Nonogram port. Serves a site tree (root must hold games/arcade/nonogram/
// plus the shared kit.js), drives headless Chromium with real CDP mouse/touch input, and asserts the
// port's own state hook: a tap fills a cell, the whole picture solves through real clicks, the win
// sheet appears, restart clears it, five contradictions reach the lose sheet, the board selector
// swaps the picture, and a 390x844 portrait touch still fills a cell with every board corner on screen.
//
// usage: node nonogram-gate.mjs [rootDir]     (default: ~/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/nonogram/';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/ngram-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});

const server = await serve();
const port = server.address().port;
// Browser-level Target.createTarget hangs on this headless build: attach to the existing page target.
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

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);

const fails = [];
const check = (cond, msg) => { if (!cond) { fails.push(msg); console.error('  FAIL ' + msg); } else console.log('  ok ' + msg); };
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
};
const tapCell = async (r, c) => {
  const p = await ev(`window.__nonogram.cellPoint(${r},${c})`);
  if (!p || p.__err) return null;
  await click(p);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(420);
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
const hookType = await ev('typeof window.__nonogram');
const s0 = await ev('window.__nonogram()');
const clues = await ev('window.__nonogram.clues()');
const shotBoot = await shot('nonogram-gate-boot');
T('boot ' + JSON.stringify({ hookType, board: s0.board, rows: s0.rows, cols: s0.cols, filled: s0.filled, total: s0.total }));
check(hookType === 'function', 'hook __nonogram is a function');
check(s0 && s0.board === 1 && s0.rows === 8, 'boots on board 1 at 8x8');
check(s0.filled === 0 && s0.errors === 0 && !s0.over && !s0.won, 'boots empty, no instant win or loss');
check(clues && clues.rows.length === 8 && clues.cols.length === 8, 'clues cover every line');
check(JSON.stringify(clues.rows[2]) === '[8]', 'row 3 clue is the full-width run [8]');

// ---- 2) one real click fills one cell
const p00 = await ev('window.__nonogram.cellPoint(0,2)');
await click(p00);
const s1 = await ev('window.__nonogram()');
check(s1.filled === 1 && s1.inputs === 1, 'a real click fills exactly one cell');
check(s1.values[2] === '1', 'the clicked cell holds the fill');

// ---- 3) solve the picture through real clicks
let taps = 0;
for (let r = 0; r < s0.rows; r++) {
  for (let c = 0; c < s0.cols; c++) {
    const want = await ev(`window.__nonogram.solAt(${r},${c})`);
    if (want !== 1) continue;
    const st = await ev('window.__nonogram()');
    if (st.values[r * s0.cols + c] === '1') continue;   // (0,2) is already filled
    await tapCell(r, c);
    taps++;
  }
}
await sleep(300);
const sWin = await ev('window.__nonogram()');
const winSheet = await sheet();
const shotWin = await shot('nonogram-gate-win');
T('after solve ' + JSON.stringify({ taps, filled: sWin.filled, errors: sWin.errors, won: sWin.won, sheet: winSheet.title }));
check(sWin.won === true && sWin.solved === true, 'every filled cell solves the board (won)');
check(winSheet.open === true && winSheet.title === 'Solved.', 'the win sheet opens');
check(sWin.filled === sWin.total, 'the whole picture is filled');

// ---- 4) restart clears the board
await clickEl('overBtn');
await sleep(500);
const sNew = await ev('window.__nonogram()');
check(sNew.filled === 0 && sNew.errors === 0 && sNew.over === false, 'play again restarts a clean board');

// ---- 5) five contradictions reach the lose sheet (row 8 has clue none — any fill there is provable)
for (let c = 0; c < 5; c++) await tapCell(7, c);
await sleep(400);
const sLose = await ev('window.__nonogram()');
const loseSheet = await sheet();
const shotLose = await shot('nonogram-gate-lose');
T('after contradictions ' + JSON.stringify({ errors: sLose.errors, over: sLose.over, sheet: loseSheet.title }));
check(sLose.errors === 5, 'five provable contradictions are counted');
check(loseSheet.open === true && loseSheet.title === 'Out of attempts.', 'the lose sheet opens');
const revealed = sLose.values === sLose.solution;
check(revealed, 'the lose sheet fills in the picture');

// ---- 6) the board selector swaps the picture
await clickEl('new');
await sleep(300);
await ev(`(()=>{const s=document.getElementById('level');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()`);
await sleep(900);
const s3 = await ev('window.__nonogram()');
const shotBig = await shot('nonogram-gate-board3');
T('board 3 ' + JSON.stringify({ board: s3.board, rows: s3.rows, cols: s3.cols, filled: s3.filled, cam: await ev('window.__nonogram.camera()') }));
check(s3.board === 3 && s3.rows === 12 && s3.cols === 12, 'board 3 is the 12x12 picture');
check(s3.filled === 0 && !s3.over, 'board 3 starts clean');

// ---- 7) portrait touch: a finger fills a cell and the whole board stays on screen
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
await ev(`(()=>{const s=document.getElementById('level');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()`);
await sleep(900);
const sT0 = await ev('window.__nonogram()');
const tgt = await ev('window.__nonogram.solAt(2,3)');
const tp = await ev('window.__nonogram.cellPoint(2,3)');
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp.x, y: tp.y, radiusX: 9, radiusY: 9, force: 1 }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
const sT1 = await ev('window.__nonogram()');
const corners = await ev(`(()=>{const A=window.__nonogram.cellPoint(0,0),B=window.__nonogram.cellPoint(${sT0.rows - 1},${sT0.cols - 1});
  return {A,B,w:innerWidth,h:innerHeight};})()`);
const shotTouch = await shot('nonogram-gate-touch');
T('after touch ' + JSON.stringify({ filled: sT1.filled, errors: sT1.errors, corners }));
check(sT1.filled === 1 && sT1.errors === 0, 'a finger tap fills one cell (no accidental contradiction)');
const inFrame = corners && corners.A && corners.B &&
  corners.A.x > 0 && corners.A.x < corners.w && corners.A.y > 0 && corners.A.y < corners.h &&
  corners.B.x > 0 && corners.B.x < corners.w && corners.B.y > 0 && corners.B.y < corners.h;
check(inFrame, 'both far board corners project inside the 390x844 viewport');

// ---- 8) console errors
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 4);
T('console errors: ' + (errors.length ? errors.join(' | ') : 'none'));
check(errors.length === 0, 'no console errors or exceptions');

console.log(JSON.stringify({ fails, shots: { boot: shotBoot, win: shotWin, lose: shotLose, board3: shotBig, touch: shotTouch } }, null, 1));
console.log(fails.length ? 'NONOGRAM GATE FAIL' : 'NONOGRAM GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
