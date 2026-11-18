#!/usr/bin/env node
// Interaction gate for the Fish Rings port (eu.veldsoft.fish.rings card).
// Real CDP clicks on the ⟳/⟲ handles, state-hook assertions for turn / solve / win / lose /
// restart, the double-dispatch guard, and portrait touch. usage: node fishrings-gate.mjs <root>
//
// <root> is a directory that serves the arcade tree (games/arcade/fish-rings-puzzle/…), either the
// site repo itself or the staged publish tree.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/fish-rings-puzzle/index.html';
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
const PROFILE = mkdtempSync('/tmp/fish-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const tapAt = async (x, y) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
const arrow = (r, dir) => ev(`window.__fishrings.arrowPoint(${r},${dir})`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

const problems = [];
const want = (cond, msg) => { if (!cond) problems.push(msg); T((cond ? 'ok   ' : 'FAIL ') + msg); };

// ---- 1) boot
const hookType = await ev('typeof window.__fishrings');
want(hookType === 'function', `hook is a function (${hookType})`);
const s0 = await ev('window.__fishrings()');
want(!!s0 && Array.isArray(s0.state) && s0.state.length === 36, 'boot state is 36 slots');
want(s0 && s0.moves === 0 && s0.over === false, 'boot: 0 moves, not over');
want(s0 && s0.aligned < 3 && s0.solved === false, `boot board is scrambled (aligned ${s0 && s0.aligned}/3)`);
want(s0 && s0.scramble.length === 14, `boot scramble is 14 turns (${s0 && s0.scramble.length})`);
want(s0 && s0.turnsLeft === 72, 'boot turn budget is 72');
const webgl = await ev(`(()=>{const c=document.querySelector('canvas');const g=c&&(c.getContext('webgl2')||c.getContext('webgl'));return {canvas:!!c,w:c&&c.width,h:c&&c.height,gl:!!g};})()`);
want(webgl && webgl.canvas && webgl.gl && webgl.w > 300, `WebGL canvas live (${JSON.stringify(webgl)})`);
const shotBoot = await shot('fishrings-gate-boot');

// ---- 2) one real click on ring A's clockwise handle turns the board
const pA = await arrow(0, 1);
want(!!pA && Number.isFinite(pA.x), `ring A cw handle has a screen point (${JSON.stringify(pA)})`);
const hit = await ev(`window.__fishrings.hitAt(${Math.round(pA.x)},${Math.round(pA.y)})`);
want(hit && hit.kind === 'arrow' && hit.r === 0 && hit.dir === 1, `handle point hit-tests to ring A cw (${JSON.stringify(hit)})`);
await click(pA);
const s1 = await ev('window.__fishrings()');
want(s1.moves === 1, `one click = one turn (moves ${s1.moves})`);
want(s1.turnsLeft === 71, `turn budget drops to 71 (${s1.turnsLeft})`);
want(JSON.stringify(s1.state) !== JSON.stringify(s0.state), 'the board changed state after the turn');
want(s1.lastTurn && s1.lastTurn.r === 0 && s1.lastTurn.dir === 1, 'hook recorded ring A clockwise');
const moved = s1.state.filter((b, i) => b !== s0.state[i]).length;
want(moved >= 12, `at least a whole ring of fish moved (${moved} slots)`);

// ---- 3) the double-dispatch guard: two pointerups at the same point in the same tick
const guarded = await ev(`(()=>{
  const c = document.querySelector('canvas');
  const p = window.__fishrings.arrowPoint(1, 1);
  const before = window.__fishrings();
  for (let k = 0; k < 2; k++) {
    c.dispatchEvent(new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'mouse' }));
  }
  const after = window.__fishrings();
  return { movesBefore: before.moves, movesAfter: after.moves, dups: after.dups, inputs: after.inputs - before.inputs };
})()`);
want(guarded && guarded.movesAfter === guarded.movesBefore + 1, `double pointerup = one turn (moves ${guarded && guarded.movesBefore}→${guarded && guarded.movesAfter})`);
want(guarded && guarded.dups >= 1, `guard counted the duplicate (dups ${guarded && guarded.dups})`);
const shotMid = await shot('fishrings-gate-turn');

// ---- 4) play the actual solution: real clicks on the arrows, reversing a 14-turn scramble
const fresh = await ev(`window.__fishrings.setup('far')`);
await sleep(300);
const answer = fresh.answer;
let played = 0;
for (const [r, d] of answer) {
  const p = await arrow(r, d);
  if (!p) { problems.push(`no handle point for ring ${r} dir ${d}`); break; }
  await click(p);
  played++;
  const st = await ev('window.__fishrings()');
  if (st.over) break;
}
const sWin = await ev('window.__fishrings()');
want(sWin.solved === true, `board solved after playing the reversal (${played} clicks)`);
want(sWin.won === true && sWin.over === true, 'win state latched');
want(sWin.aligned === 3, `all three rings aligned (${sWin.aligned}/3)`);
const sh = await sheet();
want(sh.open && /Aligned/.test(sh.title), `win sheet shows "${sh.title}"`);
const shotWin = await shot('fishrings-gate-win');

// ---- 5) restart clears the board and deals a new scramble
await ev(`document.getElementById('overBtn').click()`);
await sleep(400);
const sRestart = await ev('window.__fishrings()');
want(sRestart.over === false && sRestart.won === false && sRestart.moves === 0, 'restart clears win state');
want(sRestart.turnsLeft === 72, `restart refills the turn budget (${sRestart.turnsLeft})`);
want(sRestart.solved === false, 'restart deals a scrambled board');
want((await sheet()).open === false, 'restart closes the sheet');

// ---- 6) lose: one turn left, spend it
await ev(`window.__fishrings.setup('lastturn')`);
await sleep(300);
const sL0 = await ev('window.__fishrings()');
want(sL0.turnsLeft === 1, `QA position has one turn left (${sL0.turnsLeft})`);
const pLose = await arrow(2, -1);
await click(pLose);
const sLose = await ev('window.__fishrings()');
want(sLose.over === true && sLose.won === false, 'running out of turns ends the game as a loss');
const shLose = await sheet();
want(shLose.open && /turns/.test(shLose.title), `lose sheet shows "${shLose.title}"`);
await shot('fishrings-gate-lose');

// ---- 7) portrait touch: a finger on a handle turns a ring on a phone viewport
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`window.__fishrings.setup('far')`);
await sleep(900);
const sP0 = await ev('window.__fishrings()');
const pT = await arrow(1, 1);
const inView = await ev(`(()=>{const c=document.querySelector('canvas').getBoundingClientRect();return {w:c.width,h:c.height};})()`);
want(pT && pT.x > 0 && pT.x < inView.w && pT.y > 0 && pT.y < inView.h, `portrait handle is on screen (${JSON.stringify(pT)} in ${JSON.stringify(inView)})`);
await tapAt(pT.x, pT.y);
const sP1 = await ev('window.__fishrings()');
want(sP1.moves === sP0.moves + 1, `touch tap turned a ring (moves ${sP0.moves}→${sP1.moves})`);
want(JSON.stringify(sP1.state) !== JSON.stringify(sP0.state), 'touch changed the board state');
const shotPortrait = await shot('fishrings-gate-portrait');

// ---- 8) console must be clean
const errs = pageCdp.events
  .filter((e) => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.entry?.text || e.params.exceptionDetails?.exception?.description || 'exception');
want(errs.length === 0, `console clean (${errs.length} error${errs.length === 1 ? '' : 's'})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

proc.kill();
server.close();
console.log(JSON.stringify({
  gate: 'fishrings',
  url: `http://127.0.0.1:${port}/${FILE}`,
  boot: { moves: s0.moves, aligned: s0.aligned, scramble: s0.scramble.length },
  turn: { moves: s1.moves, changedSlots: moved },
  played, solvedIn: played, aligned: sWin.aligned,
  lose: { turnsLeft: sLose.turnsLeft, over: sLose.over },
  portrait: { moves: sP1.moves, w: inView.w, h: inView.h },
  shots: [shotBoot, shotMid, shotWin, shotPortrait],
  problems,
}, null, 1));
if (problems.length) { console.error(`FAIL ${problems.length} problem(s)`); process.exit(1); }
console.log('PASS fishrings gate');
