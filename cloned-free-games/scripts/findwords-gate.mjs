#!/usr/bin/env node
// Interaction gate for the Find Words port (com.sidhant.findwords card).
// Real CDP drags with the mouse, state-hook assertions for find / refuse / win / lose / restart,
// and portrait touch on a phone viewport. usage: node findwords-gate.mjs <root>
//
// <root> is a directory that serves the arcade tree (games/arcade/find-words-word-search-puzzle/…),
// either the site repo itself or the staged publish tree.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/find-words-word-search-puzzle/index.html';
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
const PROFILE = mkdtempSync('/tmp/fw-gate-');
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

// A word is dragged the way a finger does it: press on the first letter, slide across the cells,
// release on the last one.
async function drag(from, to, steps = 5) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  for (let k = 1; k <= steps; k++) {
    const x = from.x + (to.x - from.x) * (k / steps), y = from.y + (to.y - from.y) * (k / steps);
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', pointerType: 'mouse' });
    await sleep(30);
  }
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(220);
}
async function dragWord(p) {
  const a = await ev(`window.__findwords.tilePoint(${p.r0},${p.c0})`);
  const b = await ev(`window.__findwords.tilePoint(${p.r1},${p.c1})`);
  if (!a || !b) return null;
  await drag(a, b);
  return { a, b };
}
async function dragTouch(from, to) {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let k = 1; k <= 4; k++) {
    await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * k / 4, y: from.y + (to.y - from.y) * k / 4 }] });
    await sleep(30);
  }
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
}
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
const hookType = await ev('typeof window.__findwords');
want(hookType === 'function', `hook is a function (${hookType})`);
const s0 = await ev('window.__findwords()');
want(!!s0 && s0.grid.length === 100 && s0.size === 10, 'boot board is a 10x10 grid of letters');
want(s0 && s0.words.length === 8 && s0.placed.length === 8, 'all eight words are on the board');
want(s0 && s0.found.length === 0 && s0.over === false, 'boot: nothing found, not over');
const webgl = await ev(`(()=>{const c=document.querySelector('canvas');const g=c&&(c.getContext('webgl2')||c.getContext('webgl'));return {canvas:!!c,w:c&&c.width,gl:!!g};})()`);
want(webgl && webgl.canvas && webgl.gl && webgl.w > 300, `WebGL canvas live (${JSON.stringify(webgl)})`);
const shotBoot = await shot('findwords-gate-boot');

// ---- 2) a real drag finds a word
const first = s0.placed[0];
await dragWord(first);
const s1 = await ev('window.__findwords()');
want(s1.found.length === 1 && s1.found[0] === first.word, `dragging ${first.word} found it (${JSON.stringify(s1.found)})`);
want(s1.lastPick && s1.lastPick.word === first.word, 'hook recorded the pick');
const chipOn = await ev(`(()=>{const e=[...document.querySelectorAll('.chip')].find(x=>x.dataset.word==='${first.word}');return e?e.classList.contains('found'):null;})()`);
want(chipOn === true, 'the word chip is marked found');
const shotFound = await shot('findwords-gate-found');

// ---- 3) a bent drag finds nothing
const before = s1.found.length;
const bend = await ev(`(()=>{const a=window.__findwords.tilePoint(0,0),b=window.__findwords.tilePoint(3,2);return {a,b};})()`);
await drag(bend.a, bend.b, 4);
const s2 = await ev('window.__findwords()');
want(s2.found.length === before, `bent drag was refused (found ${s2.found.length})`);

// ---- 4) drag the rest of the words, one at a time, and reach the win sheet
let played = 1;
for (const p of s0.placed.slice(1)) {
  await dragWord(p);
  played++;
  const st = await ev('window.__findwords()');
  if (st.over) break;
}
const sWin = await ev('window.__findwords()');
want(sWin.found.length === 8, `all eight words found (${sWin.found.length}/8)`);
want(sWin.won === true && sWin.over === true, 'win state latched');
const sh = await sheet();
want(sh.open && /cleared/i.test(sh.title), `win sheet shows "${sh.title}"`);
const shotWin = await shot('findwords-gate-win');

// ---- 5) restart re-deals and clears
await ev(`document.getElementById('overBtn').click()`);
await sleep(600);
const sRestart = await ev('window.__findwords()');
want(sRestart.over === false && sRestart.won === false && sRestart.found.length === 0, 'restart clears the board');
want(sRestart.placed.length === 8 && sRestart.grid.length === 100, 'restart deals a full board');
want((await sheet()).open === false, 'restart closes the sheet');

// ---- 6) lose: the clock runs out
await ev(`window.__findwords.setup('lastsecond')`);
let sLose = null;
for (let k = 0; k < 24; k++) {
  await sleep(400);
  sLose = await ev('window.__findwords()');
  if (sLose.over) break;
}
want(sLose && sLose.over === true && sLose.won === false, 'running out of time ends the game as a loss');
const shLose = await sheet();
want(shLose.open && /time/i.test(shLose.title), `lose sheet shows "${shLose.title}"`);
await shot('findwords-gate-lose');

// ---- 7) portrait touch: a finger drag finds a word on a phone viewport
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`window.__findwords.setup('fresh')`);
await sleep(1000);
const sP0 = await ev('window.__findwords()');
const tw = sP0.placed[1];
const pa = await ev(`window.__findwords.tilePoint(${tw.r0},${tw.c0})`);
const pb = await ev(`window.__findwords.tilePoint(${tw.r1},${tw.c1})`);
const vis = await ev(`(()=>{const c=document.querySelector('canvas').getBoundingClientRect();return {w:c.width,h:c.height};})()`);
want(pa && pa.x > 0 && pa.x < vis.w && pa.y > 0 && pa.y < vis.h, `portrait word is on screen (${JSON.stringify(pa)} in ${JSON.stringify(vis)})`);
await dragTouch(pa, pb);
const sP1 = await ev('window.__findwords()');
want(sP1.found.length === 1 && sP1.found[0] === tw.word, `touch drag found ${tw.word} (${JSON.stringify(sP1.found)})`);
const shotPortrait = await shot('findwords-gate-portrait');

// ---- 8) console must be clean
const errs = pageCdp.events
  .filter((e) => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.entry?.text || e.params.exceptionDetails?.exception?.description || 'exception');
want(errs.length === 0, `console clean (${errs.length} error${errs.length === 1 ? '' : 's'})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

proc.kill();
server.close();
console.log(JSON.stringify({
  gate: 'findwords',
  url: `http://127.0.0.1:${port}/${FILE}`,
  boot: { grid: s0.grid.length, words: s0.words.length, placed: s0.placed.length },
  found: { first: first.word, total: sWin.found.length, played },
  refuse: { bentDrag: s2.found.length - before },
  lose: { timeLeft: sLose && sLose.timeLeft, over: sLose && sLose.over },
  portrait: { word: tw.word, found: sP1.found.length, w: vis.w, h: vis.h },
  shots: [shotBoot, shotFound, shotWin, shotPortrait],
  problems,
}, null, 1));
if (problems.length) { console.error(`FAIL ${problems.length} problem(s)`); process.exit(1); }
console.log('PASS findwords gate');
