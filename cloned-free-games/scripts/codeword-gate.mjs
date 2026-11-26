#!/usr/bin/env node
// Interaction gate for the Code-Word port. Serves the arcade tree, boots headless Chromium and
// dispatches REAL pointer events on the 3D squares and the letter bank, asserting through
// window.__codeword() that the board really changes: selection, letter entry, the swap rule,
// the dead-end check, a full solve to the win sheet, restart, the clock running out, and a
// portrait touch pass. A canvas that merely exists is not proof.
//
// usage: node codeword-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/codeword/index.html';
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
const PROFILE = mkdtempSync('/tmp/cw-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const qs = process.argv.includes('--quick');
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
const VIEW = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
await S('Emulation.setDeviceMetricsOverride', VIEW);
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

// wait for the hook (three.js comes off a CDN, so allow a slow start)
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = (await ev('typeof window.__codewordReady !== "undefined" && window.__codewordReady === true')) === true; }
ok(ready, 'page boots and exposes the hook');
if (!ready) { const body = await ev('document.body.innerText.slice(0,200)'); T('body: ' + JSON.stringify(body)); process.exit(1); }

const state = () => ev('window.__codeword()');
const tap = (x, y) => ev(`(()=>{
  const el = document.querySelector('canvas');
  const mk = (t) => new PointerEvent(t, {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:7, pointerType:'touch', isPrimary:true, button:0, buttons:1});
  el.dispatchEvent(mk('pointerdown'));
  el.dispatchEvent(mk('pointerup'));
  return true;
})()`);
const tapKey = (letter) => ev(`(()=>{
  const p = window.__codeword.keyPoint('${letter}');
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:8, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { el: el.tagName + (el.dataset ? ':' + (el.dataset.letter || '') : ''), x: p.x, y: p.y };
})()`);
const tapCell = async (r, c) => {
  const p = await ev(`window.__codeword.tilePoint(${r},${c})`);
  if (!p) return null;
  await tap(p.x, p.y);
  await sleep(80);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('on'),title:document.getElementById('o-title').textContent,sub:document.getElementById('o-sub').textContent,key:document.getElementById('o-sol').textContent}))()`);

// ---- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ hook: typeof (await ev('typeof window.__codeword')), letters: s0.letters, filled: s0.filled, cells: s0.cells, keys: s0.keys, words: s0.words }));
ok((await ev('typeof window.__codeword')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.letters >= 10 && s0.filled === s0.givens.length, 'boots with only the givens filled', { letters: s0.letters, filled: s0.filled });
ok(s0.givens.length === 3, 'three givens revealed', s0.givens);
ok(s0.keys === 26, 'letter bank has 26 keys', s0.keys);
ok(!s0.over && !s0.solved, 'not already won or lost');
const bb0 = await ev('window.__codeword.boardBox()');
const band0 = await ev('window.__codeword.band()');
T('layout ' + JSON.stringify({ bb0, band0 }));
ok(bb0 && bb0.h > 200 && bb0.y >= band0.top - 18 && bb0.y + bb0.h <= band0.bottom + 18, 'board sits inside the HUD band', { bb0, band0 });
await shot('codeword-gate-boot');

// ---- 2) pick a square that is not a given, type its letter
const cells = await ev('window.__codeword.cells()');
T('camera ' + JSON.stringify(await ev('window.__codeword.camera()')));
const givens = s0.givens.map(([n]) => n);
const target = cells.find((x) => !givens.includes(x.n));
T('first cell ' + JSON.stringify(target));
await tapCell(target.r, target.c);
const sSel = await state();
ok(sSel.sel === target.n && sSel.selCell && sSel.selCell[0] === target.r && sSel.selCell[1] === target.c,
  'tap selects the square and its number', { sel: sSel.sel, want: target.n, selCell: sSel.selCell });

const truth = await ev(`window.__codeword.solutionLetter(${target.r},${target.c})`);
const keyHit = await tapKey(truth);
const sTyped = await state();
ok(sTyped.map[target.n] === truth, `key tap writes ${truth} on ${target.n}`, { map: sTyped.map[target.n], keyHit });
ok(sTyped.filled === s0.filled + 1, 'one more number filled', { before: s0.filled, after: sTyped.filled });
await shot('codeword-gate-typed');

// ---- 3) the swap rule: give that letter to a different number and the first one takes its old letter
const other = cells.find((x) => x.n !== target.n && !givens.includes(x.n));
await tapCell(other.r, other.c);
await tapKey(truth);
const sSwap = await state();
ok(sSwap.map[other.n] === truth && !sSwap.map[target.n], 'typing a taken letter moves it off the old number', { other: sSwap.map[other.n], old: sSwap.map[target.n] });
const sBack = await ev(`window.__codeword.assign(${target.n}, '${truth}')`);
ok(sBack.map[target.n] === truth, 're-assigning restores it', sBack.map[target.n]);

// ---- 4) the dead-end check: poison a number with a letter that provably kills a run, Check
// flags squares, then repair and Check goes quiet again
const probe = await ev(`(()=>{const out={};for(const l of 'qzjvxkw'.split('')) out[l]=window.__codeword.probeDead(${target.n}, l);return out;})()`);
const deadLetter = Object.entries(probe).sort((a, b) => b[1] - a[1])[0];
T('dead probe ' + JSON.stringify(probe) + ' -> ' + JSON.stringify(deadLetter));
ok(deadLetter[1] > 0, 'a letter that kills a run exists', probe);
await ev(`window.__codeword.assign(${target.n}, '${deadLetter[0]}')`);
await clickEl('b-check');
const deadHint = await ev(`document.getElementById('hint').textContent`);
ok(/can no longer be right/i.test(deadHint), 'Check reports dead squares', deadHint);
await ev(`window.__codeword.assign(${target.n}, '${truth}')`);
await clickEl('b-check');
const cleanHint = await ev(`document.getElementById('hint').textContent`);
ok(/still has a possible word/i.test(cleanHint), 'Check is silent once repaired', cleanHint);
const sChecks = await state();
ok(sChecks.checks === 2, 'checks are counted', sChecks.checks);

// ---- 5) clear button empties the selected number
await tapCell(other.r, other.c);
await clickEl('b-clear');
const sClear = await state();
ok(!sClear.map[other.n], 'Clear empties the selected number', { num: other.n, map: sClear.map[other.n] });

// ---- 6) solve the whole board with real taps on squares and keys
let taps = 0;
const seen = new Set();
for (const cell of cells) {
  const n = cell.n;
  if (seen.has(n)) continue;
  seen.add(n);
  const st = await state();
  if (st.over) break;
  if (st.map[n]) continue;
  await tapCell(cell.r, cell.c); taps++;
  const letter = await ev(`window.__codeword.solutionLetter(${cell.r},${cell.c})`);
  await tapKey(letter); taps++;
  if (qs && taps > 12) break;
}
const sWin = await state();
const winSheet = await shot('codeword-gate-win');
const ws = await sheet();
T('win ' + JSON.stringify({ solved: sWin.solved, over: sWin.over, filled: sWin.filled, letters: sWin.letters, taps, sheet: ws }));
ok(sWin.solved === true, 'board is solved', { filled: sWin.filled, letters: sWin.letters });
ok(sWin.over === 'win' && ws.open, 'win sheet is up', { over: sWin.over, sheet: ws.open, title: ws.title });
ok(sWin.filled === sWin.letters, 'every number filled at the win', { filled: sWin.filled, letters: sWin.letters });
ok(/code broken/i.test(ws.title), 'win sheet titles it', ws.title);

// ---- 7) restart from the sheet
await clickEl('o-again');
const sAgain = await state();
const sheetAfter = await sheet();
ok(sAgain.filled === sAgain.givens.length && !sAgain.solved && !sAgain.over, 'restart clears the board back to the givens', { filled: sAgain.filled });
ok(!sheetAfter.open, 'restart closes the sheet', sheetAfter.open);

// ---- 8) the clock runs out into the lose sheet
await ev('window.__codeword.setup({ remaining: 2 })');
await sleep(2800);
const sLose = await state();
const loseSheet = await sheet();
await shot('codeword-gate-lose');
T('lose ' + JSON.stringify({ over: sLose.over, remaining: sLose.remaining, sheet: loseSheet.open, title: loseSheet.title }));
ok(sLose.over === 'lose' && loseSheet.open, 'clock zero opens the lose sheet', { over: sLose.over, sheet: loseSheet.open });
ok(/time.s up/i.test(loseSheet.title), 'lose sheet titles it', loseSheet.title);
ok(loseSheet.key.includes('='), 'lose sheet reveals the number key', loseSheet.key.slice(0, 40));

// ---- 9) portrait phone pass: the board must fit between the bars and still take taps
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.reload', { ignoreCache: true });
ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = (await ev('typeof window.__codewordReady !== "undefined" && window.__codewordReady === true')) === true; }
ok(ready, 'portrait reload boots');
const bbP = await ev('window.__codeword.boardBox()');
const bandP = await ev('window.__codeword.band()');
T('portrait ' + JSON.stringify({ bbP, bandP }));
ok(bbP && bbP.w <= 390 && bbP.y >= bandP.top - 14 && bbP.y + bbP.h <= bandP.bottom + 14, 'board fits the portrait band', { bbP, bandP });
const pCells = await ev('window.__codeword.cells()');
const pGivens = (await state()).givens.map(([n]) => n);
const free = pCells.find((x) => !pGivens.includes(x.n));
await tapCell(free.r, free.c);
const sPsel = await state();
ok(sPsel.sel === free.n, 'portrait tap selects a square', { sel: sPsel.sel, want: free.n });
const pLetter = await ev(`window.__codeword.solutionLetter(${free.r},${free.c})`);
const keyHitP = await tapKey(pLetter);
const sPtyped = await state();
ok(sPtyped.map[free.n] === pLetter, 'portrait key tap writes the letter', { map: sPtyped.map[free.n], keyHitP });
await shot('codeword-gate-portrait');

// ---- 10) console stayed clean
const bad = cdp.events.filter((e) => (e.method === 'Log.entryAdded' && ['error'].includes(e.params.entry.level))
  || e.method === 'Runtime.exceptionThrown');
ok(bad.length === 0, 'no console errors or uncaught exceptions', bad.map((b) => b.params?.entry?.text || b.params?.exceptionDetails?.text).slice(0, 3));

T(`\n${fails ? fails + ' FAILURE(S)' : 'ALL GATE CHECKS PASSED'}`);
T('screens: ' + [winSheet, loseSheet].join(' '));
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
