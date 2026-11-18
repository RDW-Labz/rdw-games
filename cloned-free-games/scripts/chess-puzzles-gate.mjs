#!/usr/bin/env node
// Interaction gate for the Chess Puzzles port: real CDP mouse on the 3D board,
// state-hook assertions for select -> wrong move -> mate -> next puzzle, the full
// set solved by clicking, portrait touch, screenshots.
// usage: node chess-puzzles-gate.mjs <dir-with-games/arcade> [port-slug]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const SLUG = process.argv[3] || 'chess-puzzles';
const FILE = `games/arcade/${SLUG}/index.html`;
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
const PROFILE = mkdtempSync('/tmp/chpz-gate-');
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
await sleep(6000);

const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 5).join(' | ');

const click = async (pt, pointerType = 'mouse') => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(pt.x), y: Math.round(pt.y), button: 'none', pointerType });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1, pointerType });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1, pointerType });
};
const clickSquare = async (from, pointerType = 'mouse') => {
  const r = Math.floor(from / 8), c = from % 8;
  const p = await ev(`window.__chesspuzzles.tilePoint(${r},${c})`);
  if (!p || p.__err) return p;
  await click(p, pointerType);
  await sleep(260);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(400);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const hook = () => ev('window.__chesspuzzles()');

const report = { slug: SLUG, steps: {}, problems: [], shots: [] };
const fail = (m) => { report.problems.push(m); T('FAIL ' + m); };

// ---------------------------------------------------------------- 1) boot
let h = await hook();
if (!h || h.__err) { fail('hook missing: ' + JSON.stringify(h)); }
else {
  report.steps.boot = { idx: h.idx, total: h.total, status: h.status, pieces: h.pieces, meshes: h.meshes, mate: h.mate };
  if (h.total !== 7) fail(`expected 7 puzzles, hook says ${h.total}`);
  if (h.pieces !== 9 || h.meshes !== 9) fail(`board should hold 9 pieces, got pieces=${h.pieces} meshes=${h.meshes}`);
  if (h.status !== 'play') fail('boot status ' + h.status);
}
report.shots.push(await shot('chesspuzzles-gate-boot'));
T('boot ' + JSON.stringify(report.steps.boot));

// ---------------------------------------------------------------- 2) wrong move: Kg1-h1 is legal but is not the mate
const before = await hook();
await clickSquare(62);                     // g1 king
await clickSquare(63);                     // h1
await sleep(200);
let wrong = await hook();
report.steps.wrongMove = { misses: wrong.misses, status: wrong.status, ply: wrong.ply, moves: wrong.moves.length, boardSame: wrong.pieces === before.pieces };
if (wrong.misses !== 1) fail('wrong move did not register (misses=' + wrong.misses + ')');
if (wrong.status !== 'wrong') fail('status after wrong move = ' + wrong.status);
if (wrong.ply !== 0 || wrong.moves.length !== 0) fail('a wrong move mutated the puzzle (ply ' + wrong.ply + ')');
report.shots.push(await shot('chesspuzzles-gate-wrong'));
await sleep(1300);                          // let the flash timer clear

// ---------------------------------------------------------------- 3) solve the whole set by clicking
const solvedSeq = [];
for (let p = 0; p < 7; p++) {
  let guard = 0;
  for (;;) {
    h = await hook();
    if (!h || h.__err) { fail('hook lost at puzzle ' + p); break; }
    if (h.status === 'solved' || h.over) break;
    if (h.turn === 'b') { await sleep(320); continue; }   // opponent reply landing
    const e = h.expected;
    if (!e) { await sleep(250); guard++; if (guard > 40) { fail('no expected move on puzzle ' + p); break; } continue; }
    await clickSquare(e[0]);
    await clickSquare(e[1]);
    await sleep(240);
    guard++;
    if (guard > 24) { fail('puzzle ' + p + ' never resolved'); break; }
  }
  h = await hook();
  solvedSeq.push({ idx: h.idx, status: h.status, solved: h.solved, ply: h.ply, over: h.over });
  T(`puzzle ${p}: ${JSON.stringify(solvedSeq[p])}`);
  if (h.status !== 'solved') { fail('puzzle ' + p + ' not solved (status ' + h.status + ', ply ' + h.ply + ')'); break; }
  if (p === 2) report.shots.push(await shot('chesspuzzles-gate-mid'));
  if (p === 6) report.shots.push(await shot('chesspuzzles-gate-final'));
  await clickEl('overBtn');                  // Next puzzle / Start again
  await sleep(400);
}
report.steps.solve = solvedSeq;
if (solvedSeq.length === 7 && solvedSeq[6].solved !== 7) fail('solved counter ended at ' + solvedSeq[6].solved + '/7');

// ---------------------------------------------------------------- 4) restart path (set complete -> start again)
const afterAll = await ev(`(()=>({title:document.getElementById('overTitle').textContent, text:document.getElementById('overText').textContent, open:document.getElementById('over').classList.contains('open')}))()`);
report.steps.setComplete = afterAll;
h = await hook();
report.steps.afterRestart = { idx: h.idx, solved: h.solved, status: h.status, task: await ev(`document.getElementById('task').textContent`) };
if (h.idx !== 0 || h.solved !== 0) fail('restart did not reset the set (idx ' + h.idx + ', solved ' + h.solved + ')');

// ---------------------------------------------------------------- 5) portrait touch: solve puzzle 1 with a finger
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const portrait = await ev(`(()=>{const c=document.querySelector('canvas');const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),iw:innerWidth,ih:innerHeight};})()`);
report.steps.portrait = portrait;
report.shots.push(await shot('chesspuzzles-gate-portrait-board'));
for (let i = 0; i < 6; i++) {
  h = await hook();
  if (h.status === 'solved' || h.over) break;
  const e = h.expected;
  if (!e) { await sleep(300); continue; }
  await clickSquare(e[0], 'touch');
  await clickSquare(e[1], 'touch');
  await sleep(260);
}
h = await hook();
report.steps.touch = { status: h.status, solved: h.solved, ply: h.ply };
report.shots.push(await shot('chesspuzzles-gate-portrait'));
if (h.status !== 'solved') fail('portrait touch did not solve puzzle 1 (status ' + h.status + ')');

await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

report.consoleErrors = errors || null;
if (errors) fail('console errors: ' + errors);
report.ok = report.problems.length === 0;
console.log(JSON.stringify(report, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(report.ok ? 0 : 1);
