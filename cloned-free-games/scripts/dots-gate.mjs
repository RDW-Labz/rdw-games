#!/usr/bin/env node
// Interaction gate for the Dots and Boxes port. Serves the arcade tree, boots headless
// Chromium, dispatches REAL pointer events at the screen point the page hook reports for a
// named edge, and asserts through window.__dots() that the board actually changed: an edge is
// drawn and the CPU replies, a fourth side captures its box and keeps the turn, the picker
// resolves the intended edge for several edges, a terminal win and a terminal loss both open
// the sheet, Play again restarts, and a 390x844 portrait pass still plays.
//
// A canvas that merely exists is not proof: every claim below is read out of window.__dots().
//
// usage: node dots-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = process.argv[3] || 'games/arcade/dots-n-boxes/index.html';
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
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok, bad } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? bad(new Error(msg.error.message)) : ok(msg.result); }
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
const PROFILE = mkdtempSync('/tmp/dots-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
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

const logs = [];
cdp.ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push(msg.params.entry.text);
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
});

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

// real pointer events, dispatched once per distinct target, at the hook's screen point
const tapAt = (x, y) => ev(`(()=>{
  const targets = new Set([document.elementFromPoint(${x}, ${y}) || document.body, document.body]);
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:7, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  for (const el of targets) { el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('pointerup')); }
  return [...targets].map(e => e.tagName).join(',');
})()`);

const state = () => ev('window.__dots()');
const edgePoint = (id) => ev(`window.__dots.edgePoint(${JSON.stringify(id)})`);
const tapEdge = async (id, settle = 0) => {
  const p = await edgePoint(id);
  if (!p || p.x === null) return { p, __err: 'no point for ' + id };
  if (p.x < 0 || p.y < 0 || p.x > 1280 || p.y > 900) return { p, __err: 'point off screen' };
  await tapAt(p.x, p.y);
  if (settle) await sleep(settle);
  return p;
};
// a real mouse click on a DOM control (JS pointer events do not synthesise 'click')
const clickControl = async (sel) => {
  const r = await ev(`(()=>{ const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const b = el.getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()`);
  if (!r) return null;
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(320);
  return r;
};
const poll = async (fn, ms = 12000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

let s = await state();
if (s && s.__err) { console.error('hook error', s); process.exit(1); }
ok(s && typeof s.dim === 'number', 'page hook __dots() is live', s);
ok(s.dim === 5 && s.free === 60, 'fresh 5x5 board with 60 free edges', s && { dim: s.dim, free: s.free });
ok(s.scores[0] === 0 && s.scores[1] === 0 && !s.over, 'board starts empty and playable');
await shot('dots-boot');

// --- 1. a real tap draws an edge, and the CPU answers ---
{
  const p = await tapEdge('h0-0', 150);
  ok(p && p.x !== null, 'edgePoint(h0-0) resolved', p);
  let a = await state();
  ok(a.inputs === 1, 'the tap was accepted as input', { inputs: a.inputs, taps: a.taps, blocked: a.blocked });
  ok(a.moves === 1 && a.free === 59, 'the edge is drawn (60 -> 59 free)', { moves: a.moves, free: a.free });
  ok(a.lastDrawn === 'h0-0', 'the picker resolved the intended edge', a.lastDrawn);
  ok(a.turn === 1, 'the turn passed to the CPU after a plain edge', a.turn);
  const replied = await poll(async () => { const b = await state(); return b.moves >= 2 ? b : null; }, 15000);
  ok(!!replied, 'the CPU replied on its own', replied && { moves: replied.moves, free: replied.free });
  if (replied) ok(replied.turn === 0 || replied.scores[1] > 0, 'the turn came back to the player', { turn: replied.turn, scores: replied.scores });
}

// --- 2. the picker maps screen points to the intended edge for a spread of edges (2P mode) ---
await ev('window.__dots.mode("two")');
await sleep(400);
{
  const probes = ['v2-3', 'h4-1', 'v0-0', 'h5-2', 'v3-5', 'h1-4'];
  for (const id of probes) {
    const before = await state();
    await tapEdge(id, 250);
    const after = await state();
    ok(after.lastDrawn === id && after.moves === before.moves + 1, `tap on ${id} drew exactly that edge`, { lastDrawn: after.lastDrawn, before: before.moves, after: after.moves });
  }
}

// --- 3. a fourth side captures its box and the player keeps the turn (QA position) ---
{
  await ev('window.__dots.mode("cpu")');
  await sleep(300);
  const qa = await ev('window.__dots.setup({dim:3, drawn:["h0-0","h1-0","v0-0"], turn:0})');
  ok(qa && qa.scores[0] === 0 && qa.scores[1] === 0, 'QA position loaded (3 sides on one box)', qa && { free: qa.free, scores: qa.scores });
  const p = await tapEdge('v0-1', 500);
  const a = await state();
  ok(a.scores[0] === 1 && a.owners[0][0] === 0, 'the fourth side captured the box for the player', { scores: a.scores, owners: a.owners });
  ok(a.turn === 0, 'a capture kept the turn with the player (no CPU reply)', { turn: a.turn, moves: a.moves });
  ok(p && !a.__err, 'capture tap resolved');
  await shot('dots-capture');
}

// --- 4. terminal WIN opens the sheet, and Play again restarts ---
{
  const qa = await ev('window.__dots.setup({dim:2, drawn:["h0-0","h1-0","v0-0","v0-1","h0-1","h1-1","v0-2","h2-0","h2-1","v1-0","v1-2"], boxes:[[0,0,0],[0,1,0],[1,0,1]], turn:0})');
  ok(qa && qa.free === 1, 'win QA position has exactly one edge left', qa && { free: qa.free, scores: qa.scores });
  await tapEdge('v1-1', 500);
  const a = await state();
  ok(a.over === true, 'the final edge ended the game', { over: a.over });
  ok(a.result === 0, 'the player is the winner', { result: a.result, scores: a.scores });
  ok(a.sheet === true, 'the end sheet is open', { sheet: a.sheet });
  ok(/You win/.test(a.title || ''), 'the sheet says the player won', a.title);
  ok(a.scores[0] + a.scores[1] === 4, 'every box on the 2x2 board is owned', a.scores);
  await shot('dots-win');
  await clickControl('#overBtn');
  const b = await state();
  ok(b.over === false && b.moves === 0 && b.scores[0] === 0 && b.scores[1] === 0, 'Play again restarted a clean board', { over: b.over, moves: b.moves, scores: b.scores });
  ok(b.sheet === false, 'the sheet closed on restart');
}

// --- 5. terminal LOSS opens the sheet with the CPU winning ---
{
  const qa = await ev('window.__dots.setup({dim:2, drawn:["h0-0","h1-0","v0-0","v0-1","h0-1","h1-1","v0-2","h2-0","h2-1","v1-0","v1-2"], boxes:[[0,0,1],[0,1,1],[1,0,1]], turn:0})');
  ok(qa && qa.free === 1, 'loss QA position has one edge left', qa && { free: qa.free, scores: qa.scores });
  await tapEdge('v1-1', 500);
  const a = await state();
  ok(a.over === true && a.result === 1, 'the CPU won the terminal position', { over: a.over, result: a.result, scores: a.scores });
  ok(/CPU wins/.test(a.title || ''), 'the sheet says the CPU won', a.title);
  ok(a.sheet === true, 'the loss sheet is open');
  await shot('dots-lose');
  await clickControl('#overBack');
  const b = await state();
  ok(b.sheet === false, 'Back up closes the sheet');
}

// --- 6. discarding: tapping a drawn edge is blocked, not counted as input ---
{
  const qa = await ev('window.__dots.setup({dim:3, drawn:["h0-0"], turn:0})');
  const before = await state();
  await tapEdge('h0-0', 300);
  const after = await state();
  ok(after.moves === before.moves && after.inputs === before.inputs, 're-tapping a drawn edge changed nothing', { before: before.moves, after: after.moves });
  ok(after.blocked > before.blocked, 'the blocked tap was counted as blocked', { blocked: after.blocked });
}

// --- 7. portrait touch pass at 390x844 ---
{
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  const qa = await ev('window.__dots.setup({dim:5, turn:0})');
  ok(qa && qa.free === 60, 'portrait: fresh board loaded', qa && { free: qa.free });
  const p = await ev('window.__dots.edgePoint("h2-2")');
  ok(p && p.x > 0 && p.x < 390 && p.y > 0 && p.y < 844, 'portrait: the edge point is on screen', p);
  await tapAt(p.x, p.y);
  await sleep(400);
  const a = await state();
  ok(a.moves === 1 && a.lastDrawn === 'h2-2', 'portrait: a finger tap draws the edge', { moves: a.moves, lastDrawn: a.lastDrawn });
  const snap = await ev('({kids: window.__dots.children(), st: window.__dots()})');
  const kids = snap.kids, st = snap.st;
  const want = 25 + 60 + 36;
  T('  portrait children: ' + (kids || []).length + ' (expected ' + want + '), p1 edges in state: ' + st.p1Edges);
  ok((kids || []).length === want, `board holds exactly its ${want} meshes (boxes+edges+dots), nothing stale`, (kids || []).length);
  const red = (kids || []).filter((k) => k.hex === 'ff7a6b').length;
  ok(red === st.p1Edges, 'the red meshes on screen are exactly the CPU\'s drawn edges', { red, p1: st.p1Edges });
  const offGrid = (kids || []).filter((k) => Math.max(Math.abs(k.p[0]), Math.abs(k.p[2])) > 3.0);
  ok(offGrid.length === 0, 'no mesh sits off the board', offGrid.slice(0, 2));
  await shot('dots-portrait');
}

// --- 8. no page errors ---
ok(logs.length === 0, 'no console errors or exceptions', logs.slice(0, 4));

T(fails ? `FAILED ${fails}` : 'PASS — dots and boxes plays, captures, ends and restarts');
process.exit(fails ? 1 : 0);
