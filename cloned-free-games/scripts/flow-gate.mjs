#!/usr/bin/env node
// Interaction gate for the Flow port: real CDP drags / touch drags on the 3D board,
// state-hook assertions for pipe length, pair connection, full-board win, move-budget loss,
// level switch and restart, plus screenshots.
// usage: node flow-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/flow.html';
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/gflow-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const state = () => ev('window.__flow()');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const errorsOf = (from = 0) => cdp.events.slice(from).filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const ptOf = async (r, c) => ev(`window.__flow.tilePoint(${r},${c})`);
const click = async (p) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (b) await click(b);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// Drag a mouse through a list of cells: press on the first, move through the rest, release.
const dragCells = async (cells) => {
  const first = await ptOf(cells[0][0], cells[0][1]);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  for (const [r, c] of cells.slice(1)) {
    const p = await ptOf(r, c);
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', pointerType: 'mouse' });
    await sleep(35);
  }
  const last = await ptOf(cells[cells.length - 1][0], cells[cells.length - 1][1]);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(220);
};
const touchDrag = async (cells) => {
  const first = await ptOf(cells[0][0], cells[0][1]);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(60);
  for (const [r, c] of cells.slice(1)) {
    const p = await ptOf(r, c);
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
    await sleep(40);
  }
  const last = await ptOf(cells[cells.length - 1][0], cells[cells.length - 1][1]);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
  return last;
};

// ---- 1) boot
const s0 = await state();
const sol0 = await ev('window.__flow.solution()');
const shotBoot = await shot('flow-gate-boot');

// the stored solution must be a real full-cover layout: disjoint contiguous 4-neighbour paths
const coverCheck = (() => {
  const n = s0.n, seen = new Set();
  for (const path of sol0) {
    for (let i = 0; i < path.length; i++) {
      const [r, c] = path[i];
      const k = r * n + c;
      if (r < 0 || r >= n || c < 0 || c >= n) return 'out of bounds';
      if (seen.has(k)) return 'overlap at ' + k;
      seen.add(k);
      if (i) {
        const [pr, pc] = path[i - 1];
        if (Math.abs(pr - r) + Math.abs(pc - c) !== 1) return 'gap in path';
      }
    }
  }
  return seen.size === n * n ? 'ok' : `covers ${seen.size}/${n * n}`;
})();

// ---- 2) one real drag connects the first pair
await dragCells(sol0[0]);
const s1 = await state();
const shotOne = await shot('flow-gate-one-pair');

// ---- 3) finish the board -> win sheet
for (const path of sol0.slice(1)) await dragCells(path);
await sleep(400);
const sWin = await state();
const winSheet = await sheet();
const shotWin = await shot('flow-gate-win');

// ---- 4) next puzzle via the sheet button
await clickEl('nextBtn');
await sleep(600);
const sNext = await state();
const sol1 = await ev('window.__flow.solution()');

// ---- 5) lose: spend the whole move budget, then one more cell
await ev('window.__flow.setMoves(window.__flow().budget)');
const oneStep = [sol1[0][0], sol1[0][1]];
await dragCells(oneStep);
await sleep(400);
const sLose = await state();
const loseSheet = await sheet();
const shotLose = await shot('flow-gate-lose');

// ---- 6) restart from the sheet
await clickEl('overBtn');
await sleep(500);
const sRestart = await state();

// ---- 7) keyboard: F advances the puzzle
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70 });
await sleep(600);
const sKeyF = await state();

// ---- 8) touch: portrait phone, finger drag through the first pair
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const t0 = await state();
const tsol = await ev('window.__flow.solution()');
const corner = {};
for (const [k, r, c] of [['tl', 0, 0], ['br', t0.n - 1, t0.n - 1]])
  corner[k] = await ptOf(r, c);
await touchDrag(tsol[0]);
const sTouch = await state();
const shotTouch = await shot('flow-gate-touch');
const errors = errorsOf();

const checks = {
  boot: !!s0 && s0.n === 5 && s0.pairs.length === 3 && s0.connected === 0 && s0.filled === 0 && s0.over === false && s0.moves === 0,
  levelsCoverAll: coverCheck === 'ok',
  dragConnects: s1.pairs[0].connected === true && s1.pairs[0].len === sol0[0].length && s1.moves === sol0[0].length - 1,
  dragLeftOthers: s1.connected === 1,
  won: sWin.won === true && sWin.over === true && sWin.filled === sWin.cells && sWin.connected === sWin.pairs.length && winSheet.open === true && /flowed/i.test(winSheet.title),
  nextPuzzle: sNext.n === 6 && sNext.over === false && sNext.filled === 0 && sNext.pairs.length === 3,
  lost: sLose.over === true && sLose.won === false && loseSheet.open === true && /out of moves/i.test(loseSheet.title),
  restarted: sRestart.over === false && sRestart.filled === 0 && sRestart.moves === 0 && sRestart.connected === 0,
  keyAdvances: sKeyF.level === 2 && sKeyF.n === 7 && sKeyF.pairs.length === 5,
  touchDragConnects: sTouch.pairs[0].connected === true && sTouch.pairs[0].len === tsol[0].length,
  touchOnScreen: Object.values(corner).every((p) => p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, coverCheck,
  s0: { n: s0.n, pairs: s0.pairs.length, budget: s0.budget },
  s1: { connected: s1.connected, moves: s1.moves, pair0: s1.pairs[0] },
  win: { won: sWin.won, filled: sWin.filled, cells: sWin.cells, moves: sWin.moves, sheet: winSheet },
  next: { n: sNext.n, pairs: sNext.pairs.length },
  lose: { over: sLose.over, moves: sLose.moves, budget: sLose.budget, sheet: loseSheet },
  restart: { filled: sRestart.filled, moves: sRestart.moves },
  keyF: { level: sKeyF.level, n: sKeyF.n, pairs: sKeyF.pairs.length },
  touch: { n: t0.n, pair0: sTouch.pairs[0], corner },
  shots: [shotBoot, shotOne, shotWin, shotLose, shotTouch],
}, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
