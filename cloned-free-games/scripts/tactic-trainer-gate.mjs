#!/usr/bin/env node
// Interaction gate for the Tactic Trainer port (the Tactic Master card, com.tacticmaster).
// Real CDP pointer clicks on the board squares and the HUD buttons; every assertion reads the
// page's own state hook, so "a canvas exists" is never proof. Covers: the pointer map, a wrong
// move charged, a solved mate, the double-dispatch guard, a whole session played through real
// clicks to the summary sheet, restart, portrait touch, and a clean console.
// usage: node tactic-trainer-gate.mjs [root]
//   root = a directory serving the arcade tree (the site repo itself, or the staged publish tree)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/tactic-trainer/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/tactic-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: PROFILE } });

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
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(220);
};
const tapAt = async (x, y) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,stats:document.getElementById('overStats').textContent,text:document.getElementById('overText').textContent}))()`);
const hook = () => ev('window.__tactic()');
const pt = (r, c) => ev(`window.__tactic.tilePoint(${r},${c})`);
const square = (sq) => pt(8 - Number(sq[1]), sq.charCodeAt(0) - 97);   // 'e2' -> (r,c)
// Play one move by two real clicks on the squares that hold it.
const playMove = async (text) => {
  const a = await square(text.slice(0, 2));
  const b = await square(text.slice(2, 4));
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return { __err: 'no square point for ' + text, a, b };
  await click(a); await click(b);
  return true;
};

const problems = [];
const want = (cond, msg) => { if (!cond) problems.push(msg); T((cond ? 'ok   ' : 'FAIL ') + msg); };

// ---- 1) boot
const hookType = await ev('typeof window.__tactic');
want(hookType === 'function', `hook is a function (${hookType}) —— the catalog gate probes this exact shape`);
const s0 = await hook();
want(!!s0 && s0.puzzle === 0 && s0.slot === 0, `boot lands on puzzle 0 of the session (${s0 && s0.puzzle}/${s0 && s0.slot})`);
want(s0 && s0.over === false && s0.ply === 0, 'boot: not over, no move played');
want(s0 && s0.rating === 1500 && s0.streak === 0, `boot rating 1500, streak 0 (${s0 && s0.rating}/${s0 && s0.streak})`);
want(s0 && s0.task === 'Mate in 1' && s0.mate === 1, `boot task reads "${s0 && s0.task}"`);
want(s0 && s0.expect && /^[a-h][1-8][a-h][1-8]$/.test(s0.expect.text), `hook names the answer (${s0 && s0.expect && s0.expect.text})`);
want(s0 && s0.sessions === 6, `session is 6 puzzles (${s0 && s0.sessions})`);
const webgl = await ev(`(()=>{const c=document.querySelector('canvas');const g=c&&(c.getContext('webgl2')||c.getContext('webgl'));return {canvas:!!c,w:c&&c.width,h:c&&c.height,gl:!!g};})()`);
want(webgl && webgl.canvas && webgl.gl && webgl.w > 300, `WebGL canvas live (${JSON.stringify(webgl)})`);
// the pointer map: the square point must pick back the square it came from
const pMap = await ev(`(()=>{
  const out = [];
  for (const [r,c] of [[0,0],[3,4],[7,7],[1,6]]) {
    const p = window.__tactic.tilePoint(r,c);
    out.push({ r, c, got: window.__tactic.pickAt(p.x, p.y) });
  }
  return out;
})()`);
want(Array.isArray(pMap) && pMap.every((x) => x.got === x.r * 8 + x.c), `every tilePoint resolves back to its own square (${JSON.stringify(pMap)})`);
const shotBoot = await shot('tactic-trainer-gate-boot');

// ---- 2) a wrong move is charged and the board is left alone
await ev(`window.__tactic.setup(2,false)`);
await sleep(250);
const sw0 = await hook();
const wrong = await ev(`(()=>{const l=window.__tactic.legal();const a=window.__tactic.answer();return l.find(m=>m.text!==a.text)||null;})()`);
want(!!wrong, `found a legal decoy move (${wrong && wrong.text})`);
if (wrong) {
  await playMove(wrong.text);
  const sw1 = await hook();
  want(sw1.misses === sw0.misses + 1, `a decoy move is charged as a miss (${sw0.misses}→${sw1.misses})`);
  want(sw1.rating === sw0.rating - 9, `the miss costs 9 rating (${sw0.rating}→${sw1.rating})`);
  want(sw1.ply === 0 && sw1.lastBad >= 0, `the board is unchanged after a wrong move (ply ${sw1.ply}, lastBad ${sw1.lastBad})`);
  want(sw1.solved === 0, `a wrong move does not count as a solve (${sw1.solved})`);
}

// ---- 3) solve the puzzle through two real clicks on the squares
await ev(`window.__tactic.setup(2,false)`);
await sleep(250);
const sA0 = await hook();
await playMove(sA0.expect.text);
await sleep(300);
const sA1 = await hook();
want(sA1.status === 'solved' && sA1.ply >= (sA1.mate === 1 ? 1 : 1), `the answer solves it (status ${sA1.status}, ply ${sA1.ply})`);
want(sA1.solved === sA0.solved + 1, `solved counter climbs (${sA0.solved}→${sA1.solved})`);
want(sA1.rating > sA0.rating, `solving pays rating (${sA0.rating}→${sA1.rating})`);
want(sA1.streak === sA0.streak + 1, `streak increments (${sA1.streak})`);
want(sA1.shown && sA1.shown.rating === String(sA1.rating), `the HUD readout tracks the state (${sA1.shown && sA1.shown.rating})`);
const shotMid = await shot('tactic-trainer-gate-solved');

// ---- 4) the double-dispatch guard: two pointerups at one point in one page tick
const guarded = await ev(`(()=>{
  window.__tactic.setup(2,false);
  const a = window.__tactic.answer();
  const sq = (s) => window.__tactic.tilePoint(8-Number(s[1]), s.charCodeAt(0)-97);
  const p = sq(a.text.slice(0,2));
  const q = sq(a.text.slice(2,4));
  const fire = (x,y) => window.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerType:'mouse'}));
  const before = window.__tactic();
  fire(p.x, p.y);                 // select the piece
  // the destination, twice, back to back inside one page tick
  fire(q.x, q.y);
  fire(q.x, q.y);
  const after = window.__tactic();
  return { solvedBefore: before.solved, solvedAfter: after.solved, dups: after.dups, inputs: after.inputs - before.inputs };
})()`);
want(guarded && guarded.solvedAfter === guarded.solvedBefore + 1, `one gesture solves once, not twice (solved ${guarded && guarded.solvedBefore}→${guarded && guarded.solvedAfter})`);
want(guarded && guarded.dups >= 1, `the guard counted the duplicate pointerup (dups ${guarded && guarded.dups})`);

// ---- 5) play the whole session through real clicks, two-movers included
await ev(`window.__tactic.restart()`);
await sleep(300);
let played = 0, guardRounds = 0;
let st = await hook();
while (!st.over && guardRounds < 40) {
  guardRounds++;
  if (st.status === 'solved' || st.status === 'revealed') { await sleep(1300); st = await hook(); continue; }
  const a = st.expect;
  if (!a) { await sleep(400); st = await hook(); continue; }
  await playMove(a.text);
  played++;
  await sleep(500);
  st = await hook();
}
want(st.over === true, `the session reaches its summary after ${played} clicked moves (over ${st.over}, slot ${st.slot})`);
want(st.solved === 6, `all six puzzles were solved by real clicks (${st.solved}/6)`);
want(st.rating > st.startRating, `the rating climbed over the session (${st.startRating}→${st.rating})`);
const sh = await sheet();
want(sh.open && /Session/.test(sh.title), `summary sheet opens ("${sh.title}")`);
want(/rated|→/.test(sh.stats) || /rating/.test(sh.stats), `summary sheet carries the rating math (${sh.stats.replace(/\s+/g, ' ').slice(0, 80)})`);
const shotWin = await shot('tactic-trainer-gate-session');

// ---- 6) Play again restarts a clean session
await ev(`document.getElementById('overBtn').click()`);
await sleep(500);
const sR = await hook();
want(sR.over === false && sR.puzzle === 0 && sR.ply === 0, `Play again deals a fresh session (puzzle ${sR.puzzle}, over ${sR.over})`);
want(sR.solved === 0 && sR.streak === 0 && sR.misses === 0, `restart clears the session counters (solved ${sR.solved}, misses ${sR.misses})`);
want((await sheet()).open === false, 'restart closes the sheet');

// ---- 7) portrait touch: a finger on two squares solves a puzzle on a phone viewport
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(500);
await ev(`window.__tactic.setup(0,false)`);
await sleep(900);
const sp0 = await hook();
const pFrom = await square(sp0.expect.text.slice(0, 2));
const pTo = await square(sp0.expect.text.slice(2, 4));
const view = await ev(`(()=>{const c=document.querySelector('canvas').getBoundingClientRect();const t=document.querySelector('.top').getBoundingClientRect();const b=document.querySelector('.bottom').getBoundingClientRect();return {w:c.width,h:c.height,top:t.bottom,bot:b.top};})()`);
const onScreen = (p) => p && p.x > 0 && p.y > 0 && p.x < view.w && p.y < view.h;
want(onScreen(pFrom) && onScreen(pTo), `both squares are on screen in portrait (${JSON.stringify(pFrom)} / ${JSON.stringify(pTo)})`);
want(pFrom && pFrom.y > view.top && pFrom.y < view.bot, `the board sits between the HUD bars (y ${pFrom && pFrom.y} in ${Math.round(view.top)}…${Math.round(view.bot)})`);
await tapAt(pFrom.x, pFrom.y);
await tapAt(pTo.x, pTo.y);
await sleep(400);
const sp1 = await hook();
want(sp1.solved === sp0.solved + 1, `touch tap solves the puzzle (solved ${sp0.solved}→${sp1.solved})`);
const shotPortrait = await shot('tactic-trainer-gate-portrait');

// ---- 8) console must be clean
const errs = pageCdp.events
  .filter((e) => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.entry?.text || e.params.exceptionDetails?.exception?.description || 'exception');
want(errs.length === 0, `console clean (${errs.length} error${errs.length === 1 ? '' : 's'})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

proc.kill();
server.close();
console.log(JSON.stringify({
  gate: 'tactic-trainer',
  url: `http://127.0.0.1:${port}/${FILE}`,
  boot: { puzzle: s0.puzzle, rating: s0.rating, task: s0.task },
  wrong: { misses: 1, ratingAfter: sw0 ? sw0.rating - 9 : null },
  solved: { solved: sA1.solved, rating: sA1.rating, streak: sA1.streak },
  guard: guarded,
  session: { played, solved: st.solved, rating: st.rating, sheet: sh.title },
  portrait: { solved: sp1.solved, w: view.w, h: view.h },
  shots: [shotBoot, shotMid, shotWin, shotPortrait],
  problems,
}, null, 1));
if (problems.length) { console.error(`FAIL ${problems.length} problem(s)`); process.exit(1); }
console.log('PASS tactic-trainer gate');
