#!/usr/bin/env node
// Interaction gate for the Slitherlink port. Serves the site repo, boots headless Chromium,
// dispatches REAL pointer events at the points the page reports, and asserts through the page
// hook that the board changed: an edge draws a line, the next tap crosses it out, the next clears
// it, a line that cannot belong to any loop costs an error, every shipped board is solved with
// real taps, the win sheet opens, play again resets, reveal draws the answer, and a 390x844
// touch pass still draws a line.
//
// A canvas that merely exists is not proof: every claim below is read out of window.__slitherlink().
//
// usage: node slitherlink-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/slitherlink/index.html';
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
const PROFILE = mkdtempSync('/tmp/sl-gate-');
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

const state = () => ev('window.__slitherlink()');
// One pointerdown/pointerup per tap, on the canvas only (the port listens there).
const tap = (x, y) => ev(`(()=>{
  const el = document.querySelector('canvas');
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:7, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  el.dispatchEvent(mk('pointerdown'));
  el.dispatchEvent(mk('pointerup'));
  return true;
})()`);
const tapEdge = async (k, y, x) => {
  const p = await ev(`window.__slitherlink.edgePoint(${JSON.stringify(k)},${y},${x})`);
  if (!p) return null;
  await tap(p.x, p.y);
  await sleep(80);
  return p;
};
const clickEl = async (sel) => {
  const css = sel.startsWith('#') || sel.startsWith('[') ? sel : '#' + sel;
  const q = `document.querySelector(${JSON.stringify(css)})`;
  const b = await ev(`(()=>{ const e = ${q}; if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
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
const solution = () => ev('window.__slitherlink.solutionEdges()');

// ---------------------------------------------------------------- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ hookType: await ev('typeof window.__slitherlink'), board: s0.board, rows: s0.rows, cols: s0.cols, lines: s0.lines }));
ok((await ev('typeof window.__slitherlink')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.board === 1 && s0.rows === 4 && s0.cols === 4, 'boots on board 1 (4x4)', s0);
ok(!s0.over && !s0.won && s0.lines === 0 && s0.errors === 0, 'opens playable and empty', s0);
ok((await ev('window.__slitherlink.camera()')).aspect > 1, 'camera framed for the landscape viewport');
const shotBoot = await shot('slitherlink-gate-boot');

const sol1 = await solution();
ok(Array.isArray(sol1) && sol1.length > 6, 'board 1 reports its solution edges', sol1 && sol1.length);

// ---------------------------------------------------------------- 2) an edge cycles line -> cross -> empty
const [k0, y0, x0] = sol1[0];
await tapEdge(k0, y0, x0);
const sLine = await state();
ok(sLine.lines === 1 && sLine.crosses === 0 && sLine.errors === 0, 'tap draws a line on that edge', sLine);
await tapEdge(k0, y0, x0);
const sCross = await state();
ok(sCross.lines === 0 && sCross.crosses === 1 && sCross.errors === 0, 'next tap crosses the edge out', sCross);
await tapEdge(k0, y0, x0);
const sEmpty = await state();
ok(sEmpty.lines === 0 && sEmpty.crosses === 0, 'third tap clears the edge', sEmpty);

// the catalog gate dispatches the same point twice in one beat: the port must absorb it
const dup = await ev(`(()=>{
  const p = window.__slitherlink.edgePoint(${JSON.stringify(k0)},${y0},${x0});
  const el = document.querySelector('canvas');
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:5, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('pointerup'));
  el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('pointerup'));
  return true;
})()`);
const sDup = await state();
ok(sDup.lines === 1 && sDup.dups >= 1, 'a doubled tap counts as one line', { lines: sDup.lines, dups: sDup.dups });
await tapEdge(k0, y0, x0); await tapEdge(k0, y0, x0);   // back to empty
ok((await state()).lines === 0, 'board back to empty before the error test');

// ---------------------------------------------------------------- 3) a line that cannot belong to any loop costs an error
const bad = await ev('window.__slitherlink.badDraws()');
ok(Array.isArray(bad) && bad.length > 0, 'the port reports an edge that would break the loop', bad && bad.length);
if (bad && bad.length) {
  await tapEdge(bad[0][0], bad[0][1], bad[0][2]);
  const sBad = await state();
  ok(sBad.errors === 1, 'drawing it costs one of five errors', sBad.errors);
  await tapEdge(bad[0][0], bad[0][1], bad[0][2]);
  await tapEdge(bad[0][0], bad[0][1], bad[0][2]);
  ok((await state()).lines === 0, 'and it can be cleared again');
}

// ---------------------------------------------------------------- 4) solve board 1 with real taps
let taps = 0;
for (const [k, y, x] of sol1) {
  const before = await state();
  if (before.over) break;
  await tapEdge(k, y, x); taps++;
}
const sWin = await state();
const winSheet = await sheet();
T('solve board 1 ' + JSON.stringify({ lines: sWin.lines, errors: sWin.errors, solved: sWin.solved, won: sWin.won, taps, title: winSheet.title }));
ok(sWin.lines === sol1.length, 'every solution edge is drawn', { lines: sWin.lines, want: sol1.length });
ok(sWin.solved && sWin.loopOk && sWin.clueOk, 'the drawn loop satisfies every clue and closes', sWin);
ok(sWin.won && sWin.over, 'win state reached', { won: sWin.won, over: sWin.over });
ok(winSheet.open && /Loop closed/i.test(winSheet.title), 'win sheet shown', winSheet);
const shotWin = await shot('slitherlink-gate-win');

// ---------------------------------------------------------------- 5) play again resets
await clickEl('overBtn');
const sNew = await state();
ok(!sNew.over && !sNew.won && sNew.lines === 0 && sNew.errors === 0, 'Play again resets the board', sNew);

// ---------------------------------------------------------------- 6) the other two boards solve by real taps
for (const bIdx of [1, 2]) {
  await ev(`(()=>{const s=document.getElementById('level'); s.value='${bIdx}'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
  await sleep(500);
  const bState = await state();
  ok(bState.board === bIdx + 1 && bState.rows === bIdx + 4, `board ${bIdx + 1} loads`, { board: bState.board, rows: bState.rows });
  const sl = await solution();
  for (const [k, y, x] of sl) {
    if ((await state()).over) break;
    await tapEdge(k, y, x);
  }
  const w = await state(), wsh = await sheet();
  T(`board ${bIdx + 1} solve ` + JSON.stringify({ lines: w.lines, want: sl.length, won: w.won, title: wsh.title }));
  ok(w.won && w.over && w.lines === sl.length, `board ${bIdx + 1} solved by real taps`, { lines: w.lines, want: sl.length, won: w.won });
  ok(wsh.open && /Loop closed/i.test(wsh.title), `board ${bIdx + 1} win sheet shown`, wsh);
  if (bIdx === 2) await shot('slitherlink-gate-board3');
  await clickEl('overBtn');
}

// ---------------------------------------------------------------- 7) the lose path: five impossible lines
await ev(`(()=>{const s=document.getElementById('level'); s.value='0'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
await sleep(400);
let guard = 0;
while ((await state()).errors < 5 && guard++ < 12) {
  const b = await ev('window.__slitherlink.badDraws()');
  if (!b || !b.length) break;
  const [k, y, x] = b[0];
  await tapEdge(k, y, x);            // draw it
  const st = await state();
  if (st.over) break;
  await tapEdge(k, y, x);            // cross it
  await tapEdge(k, y, x);            // clear it
}
const sLose = await state();
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ errors: sLose.errors, over: sLose.over, lines: sLose.lines, title: loseSheet.title }));
ok(sLose.over && sLose.errors >= 5, 'five impossible lines end the board', sLose);
ok(/attempts/i.test(loseSheet.title), 'lose sheet shown', loseSheet);
ok(sLose.lines > 0 && sLose.solved, 'the answer is drawn in on a loss', { lines: sLose.lines, solved: sLose.solved });

// ---------------------------------------------------------------- 8) reveal, then R restart
await clickEl('overBtn');
await clickEl('reveal');
const sRev = await state(), revSheet = await sheet();
ok(sRev.over && sRev.solved && /Revealed/i.test(revSheet.title), 'reveal draws the loop and says so', { title: revSheet.title, solved: sRev.solved });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await state();
ok(!sR.over && sR.lines === 0 && sR.errors === 0, 'R restarts the board', sR);

// ---------------------------------------------------------------- 9) geometry: every edge point over the canvas, clear of the HUD
const geom = await ev(`(()=>{
  const c = document.querySelector('canvas').getBoundingClientRect();
  const top = document.querySelector('.top').getBoundingClientRect();
  const btns = document.querySelector('.btns').getBoundingClientRect();
  const sol = window.__slitherlink.solutionEdges();
  const pts = sol.map(([k,y,x]) => window.__slitherlink.edgePoint(k,y,x)).filter(Boolean);
  return { canvas: { t: c.top, b: c.bottom, l: c.left, r: c.right }, topBottom: top.bottom, btnsTop: btns.top,
    pts: pts.map((p) => [Math.round(p.x), Math.round(p.y)]) };
})()`);
ok(geom.pts.length === sol1.length, 'every solution edge reports a screen point', geom.pts.length);
ok(geom.pts.every(([x, y]) => x > geom.canvas.l && x < geom.canvas.r && y > geom.canvas.t && y < geom.canvas.b), 'every edge point is on the canvas');
ok(geom.pts.every(([, y]) => y > geom.topBottom && y < geom.btnsTop), 'every edge point sits between the HUD bars',
  { topBottom: Math.round(geom.topBottom), btnsTop: Math.round(geom.btnsTop), ys: [...new Set(geom.pts.map((p) => p[1]))] });

// ---------------------------------------------------------------- 10) console errors
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---------------------------------------------------------------- 11) portrait touch pass
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const touch = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
};
const psol = await solution();
const pe = psol[Math.floor(psol.length / 2)];
const pPt = await ev(`window.__slitherlink.edgePoint(${JSON.stringify(pe[0])},${pe[1]},${pe[2]})`);
await touch(pPt);
const ps1 = await state();
await shot('slitherlink-gate-phone');
const camP = await ev('window.__slitherlink.camera()');
T('portrait ' + JSON.stringify({ lines: ps1.lines, point: pPt, aspect: camP.aspect, dist: camP.dist }));
ok(ps1.lines === 1, 'portrait: a finger on an edge draws a line', { lines: ps1.lines });
ok(camP.aspect < 1 && camP.dist > 12, 'portrait camera reframed for the tall viewport', camP);

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: [shotBoot, shotWin],
  board1: { edges: sol1.length, taps, won: sWin.won, errors: sWin.errors },
  lose: { errors: sLose.errors, title: loseSheet.title },
  portrait: { lines: ps1.lines, aspect: camP.aspect },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
