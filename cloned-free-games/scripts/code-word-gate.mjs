#!/usr/bin/env node
// Interaction gate for the Code Word port. Serves the arcade tree, boots headless Chromium and
// dispatches REAL pointer events on the on-screen keyboard, asserting through
// window.__codeword2() that the board really changes: letters land in the row, a short or
// unknown word is refused, a correct guess reaches the win sheet, six misses reach the lose
// sheet with the word revealed, restart works, and a portrait touch pass still types.
//
// usage: node code-word-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/code-word/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 120000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/cw2-gate-');
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
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = (await ev('window.__codeword2Ready === true')) === true; }
ok(ready, 'page boots and exposes the hook');
if (!ready) { T('body: ' + JSON.stringify(await ev('document.body.innerText.slice(0,200)'))); process.exit(1); }

const state = () => ev('window.__codeword2()');
const tapKey = (label) => ev(`(()=>{
  const p = window.__codeword2.keyPoint('${label}');
  if (!p) return {err:'no key ${label}'};
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:8, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { el: el.tagName + ':' + (el.dataset ? el.dataset.key : ''), x: p.x, y: p.y };
})()`);
const typeWord = async (word) => { for (const ch of word) { await tapKey(ch.toUpperCase()); await sleep(45); } };
const enter = async () => { await tapKey('ENTER'); await sleep(220); };
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(300);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('on'),title:document.getElementById('o-title').textContent,sub:document.getElementById('o-sub').textContent,word:document.getElementById('o-word').textContent}))()`);
const hint = () => ev(`document.getElementById('hint').textContent`);

// ---- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ row: s0.row, keys: s0.keys, words: s0.wordCount, sheet: s0.sheet }));
ok((await ev('typeof window.__codeword2')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.row === 0 && s0.guesses.length === 0 && !s0.over, 'boots on a fresh row', { row: s0.row });
ok(s0.keys === 28, 'keyboard has 26 letters + Enter + Del', s0.keys);
ok(s0.wordCount > 800, 'word list loaded', s0.wordCount);
const bb0 = await ev('window.__codeword2.boardBox()');
const band0 = await ev('window.__codeword2.band()');
T('layout ' + JSON.stringify({ bb0, band0 }));
ok(bb0 && bb0.h > 300 && bb0.y >= band0.top - 16 && bb0.y + bb0.h <= band0.bottom + 16, 'board sits inside the HUD band', { bb0, band0 });
await shot('code-word-gate-boot');

// ---- 2) tapping keys fills the live row
await typeWord('cran');
const sTyped = await state();
ok(sTyped.typed === 'cran', 'key taps fill the row', sTyped.typed);
ok(sTyped.row === 0, 'nothing is submitted yet', sTyped.row);

// ---- 3) a short word is refused
await enter();
const sShort = await state();
ok(sShort.row === 0 && /not enough letters/i.test(await hint()), 'short word is refused', await hint());

// ---- 4) an unknown word is refused
await tapKey('DEL'); await tapKey('DEL'); await tapKey('DEL'); await tapKey('DEL');
await typeWord('zzzzz');
const sZ = await state();
await enter();
const sBad = await state();
ok(sBad.row === 0 && /not in the word list/i.test(await hint()), 'unknown word is refused', { row: sBad.row, hint: await hint() });
for (let i = 0; i < 5; i++) await tapKey('DEL');

// ---- 5) a real guess is scored, then the right word wins
await ev(`window.__codeword2.setup({ word: 'crane' })`);
const sFresh = await state();
ok(sFresh.row === 0 && sFresh.secret === 'crane', 'setup pins the word for the test', sFresh.secret);
await typeWord('slate');
await enter();
const sGuess = await state();
T('guess ' + JSON.stringify({ row: sGuess.row, guesses: sGuess.guesses, feedback: sGuess.feedback }));
ok(sGuess.row === 1 && sGuess.guesses[0] === 'slate', 'Enter submits the word', sGuess.guesses);
ok(JSON.stringify(sGuess.feedback[0]) === JSON.stringify(['x', 'x', 'g', 'x', 'g']), 'feedback is scored per letter', sGuess.feedback[0]);
const keyColour = await ev(`(()=>{const b=[...document.querySelectorAll('#keys button')].find(x=>x.dataset.key==='A');return b.className;})()`);
ok(/g/.test(keyColour), 'keys take the best colour a letter earned', keyColour);
await shot('code-word-gate-mid');
await typeWord('crane');
await enter();
const sWin = await state();
const ws = await sheet();
await shot('code-word-gate-win');
T('win ' + JSON.stringify({ over: sWin.over, row: sWin.row, sheet: ws.open, title: ws.title }));
ok(sWin.over === 'win' && ws.open, 'correct word opens the win sheet', { over: sWin.over, sheet: ws.open });
ok(/cracked it/i.test(ws.title), 'win sheet titles it', ws.title);

// ---- 6) restart from the sheet
await clickEl('o-again');
const sAgain = await state();
ok(sAgain.row === 0 && !sAgain.over && !(await sheet()).open, 'restart clears the board', { row: sAgain.row });

// ---- 7) six misses lose and the word is revealed
const words = ['slate', 'plumb', 'vocal', 'nudge', 'ferry', 'crisp', 'thumb', 'glide'];
const usable = [];
for (const w of words) if (await ev(`window.__codeword2.has('${w}')`)) usable.push(w);
T('lose words ' + JSON.stringify(usable));
await ev(`window.__codeword2.setup({ word: 'xxxxx' })`);
let submitted = 0;
for (const w of usable.slice(0, 6)) { await typeWord(w); await enter(); submitted++; const st = await state(); if (st.over) break; }
const sLose = await state();
const ls = await sheet();
await shot('code-word-gate-lose');
T('lose ' + JSON.stringify({ submitted, over: sLose.over, sheet: ls.open, title: ls.title, word: ls.word }));
ok(sLose.over === 'lose' && ls.open, 'six misses open the lose sheet', { over: sLose.over, row: sLose.row, submitted });
ok(/out of guesses/i.test(ls.title) && ls.word === 'XXXXX', 'lose sheet reveals the word', { title: ls.title, word: ls.word });
ok(sLose.row === 6, 'all six rows were used', sLose.row);

// ---- 8) portrait phone pass
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.reload', { ignoreCache: true });
ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = (await ev('window.__codeword2Ready === true')) === true; }
ok(ready, 'portrait reload boots');
const bbP = await ev('window.__codeword2.boardBox()');
const bandP = await ev('window.__codeword2.band()');
T('portrait ' + JSON.stringify({ bbP, bandP }));
ok(bbP && bbP.w <= 390 && bbP.y >= bandP.top - 14 && bbP.y + bbP.h <= bandP.bottom + 14, 'board fits the portrait band', { bbP, bandP });
await ev(`window.__codeword2.setup({ word: 'crane' })`);
await typeWord('sla');
const sP = await state();
ok(sP.typed === 'sla', 'portrait key taps type', sP.typed);
await shot('code-word-gate-portrait');

// ---- 9) console stayed clean
const bad = cdp.events.filter((e) => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  || e.method === 'Runtime.exceptionThrown');
ok(bad.length === 0, 'no console errors or uncaught exceptions', bad.map((b) => b.params?.entry?.text || b.params?.exceptionDetails?.text).slice(0, 3));

T(`\n${fails ? fails + ' FAILURE(S)' : 'ALL GATE CHECKS PASSED'}`);
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
