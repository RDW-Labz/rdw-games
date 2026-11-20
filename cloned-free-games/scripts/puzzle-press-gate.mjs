#!/usr/bin/env node
// Interaction gate for the Puzzle Press port (Wordrow / Clusters / Edgeways in one file).
// Serves the arcade tree, boots headless Chromium, dispatches REAL pointer events on the tiles and
// the on-screen keys, and asserts through window.__press() that every mode actually moves:
// a wrong guess is scored, the answer wins, six misses lose, a chosen group solves, four mistakes
// lose, and the Edgeways solution chain covers the box. Nothing here accepts "canvas exists".
//
// usage: node puzzle-press-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/puzzle-press/index.html';
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
const PROFILE = mkdtempSync('/tmp/pp-gate-');
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

const state = () => ev('window.__press()');

// a real pointer tap at a page point: fires once, on the element under the point
const tapAt = (x, y) => ev(`(()=>{
  const el = document.elementFromPoint(${x},${y}) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:${x}, clientY:${y}, pointerId:9, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return el.id || el.tagName;
})()`);
const tapTile = async (i) => {
  const p = await ev(`window.__press.tilePoint(${i})`);
  if (!p) return null;
  const el = await tapAt(p.x, p.y);
  await sleep(90);
  return el;
};
const tapKey = async (ch) => {
  const p = await ev(`window.__press.keyPoint(${JSON.stringify(String(ch))})`);
  if (!p) return null;
  const el = await tapAt(p.x, p.y);
  await sleep(60);
  return el;
};
const typeWord = async (w) => {
  for (const ch of w) await tapKey(ch);
  await tapKey('submit');
  await sleep(160);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot -------------------------------------------------------------------
const hookType = await ev('typeof window.__press');
const s0 = await state();
ok(hookType === 'function', 'hook is a function (the catalog gate probes typeof)');
ok(s0 && s0.mode === 'wordrow' && !s0.over && !s0.won, 'boots into Wordrow, not over', s0 && { mode: s0.mode, over: s0.over });
ok((await ev('window.__press.tilePoint(0)!==null')).toString() === 'true', 'tilePoint resolves a screen point');
const camAspect = await ev('(()=>{const c=document.querySelector("canvas");return {w:c.width,h:c.height}})()');
ok(camAspect.w > 0 && camAspect.h > 0, 'canvas sized', camAspect);
await shot('puzzle-press-gate-boot');

// ---- 2) Wordrow: a real wrong-but-valid guess is scored ------------------------
const wrong = await ev('window.__press.wrongGuesses(6)');
ok(Array.isArray(wrong) && wrong.length === 6, 'bank offers six wrong guesses to drive', wrong && wrong.length);
ok(await ev(`window.__press.guessValid(${JSON.stringify(wrong[0])})`), 'the sample guess is a legal guess');
await typeWord(wrong[0]);
let sw = await state();
ok(sw.wordrow.rows.length === 1, 'a tapped-out guess lands as row 1', sw.wordrow.rows);
ok(sw.wordrow.rows[0].word === wrong[0], 'the row holds the typed word', sw.wordrow.rows[0]);
ok(/^[gxy]{5}$/.test(sw.wordrow.rows[0].score), 'the row is scored green/gold/grey', sw.wordrow.rows[0].score);
ok(sw.over === false, 'a wrong guess does not end the game');
await shot('puzzle-press-gate-wordrow');

// ---- 3) Wordrow: six misses lose ----------------------------------------------
for (let k = 1; k < 6; k++) await typeWord(wrong[k]);
sw = await state();
let sh = await sheet();
T('after six ' + JSON.stringify({ rows: sw.wordrow.rows.length, over: sw.over, won: sw.won, sheet: sh.title }));
ok(sw.wordrow.rows.length === 6, 'six guesses on the board', sw.wordrow.rows.length);
ok(sw.over === true && sw.won === false, 'six misses reach the lose state', { over: sw.over, won: sw.won });
ok(sh.open && /tries/i.test(sh.title), 'lose sheet names the tries', sh);
ok(new RegExp(sw.wordrow.answer.toUpperCase()).test(sh.text), 'lose sheet reveals the answer', sh.text);

// ---- 4) restart, then win by tapping the answer --------------------------------
await clickEl('overBtn');
sw = await state();
ok(sw.wordrow.rows.length === 0 && !sw.over, 'Play again clears the board', sw.wordrow.rows.length);
await typeWord(sw.wordrow.answer);
sw = await state();
sh = await sheet();
T('after win ' + JSON.stringify({ rows: sw.wordrow.rows.length, won: sw.won, sheet: sh.title }));
ok(sw.won === true && sw.over === true, 'the answer wins', { won: sw.won });
ok(sw.wordrow.rows[sw.wordrow.rows.length - 1].score === 'ggggg', 'winning row is all green');
ok(sh.open && /Solved/i.test(sh.title), 'win sheet shown', sh);
await shot('puzzle-press-gate-wordrow-win');

// ---- 5) Clusters: a real four-tile pick solves a group -------------------------
await clickEl('overBtn');
await ev('window.__press.setMode("clusters")');
await sleep(900);
let sc = await state();
ok(sc.mode === 'clusters' && sc.clusters.groups.length === 4, 'clusters mode has four groups', sc.mode);
ok(sc.clusters.tiles.length === 16, 'sixteen tiles dealt', sc.clusters.tiles.length);
const g0 = sc.clusters.groups[0].words.map((w) => w.toLowerCase());
const idxs = g0.map((w) => sc.clusters.tiles.indexOf(w));
ok(idxs.every((i) => i >= 0), 'group 0 words are all on the board', { g0, idxs });
for (const i of idxs) await tapTile(i);
sc = await state();
ok(sc.clusters.sel.length === 4, 'four real tile taps select four tiles', sc.clusters.sel);
await tapKey('submit');
sc = await state();
T('after pick ' + JSON.stringify({ solved: sc.clusters.solved.length, mistakes: sc.clusters.mistakes }));
ok(sc.clusters.solved.length === 1 && sc.clusters.mistakes === 0, 'the group solves with no mistake', sc.clusters.solved);
await shot('puzzle-press-gate-clusters');

// ---- 6) Clusters: four mixed picks lose ---------------------------------------
// A mixed pick takes two tiles from each of two UNSOLVED groups (a pick that touches a solved
// group is refused before it counts, which is correct play but useless as a mistake probe).
for (let k = 0; k < 4; k++) {
  sc = await state();
  const openGroups = [0, 1, 2, 3].filter((g) => !sc.clusters.solved.some((s) => s.group === g));
  if (openGroups.length < 2) break;
  const [ga, gb] = openGroups;
  const pick = [
    sc.clusters.groups[ga].words[0], sc.clusters.groups[ga].words[1],
    sc.clusters.groups[gb].words[0], sc.clusters.groups[gb].words[1],
  ].map((w) => sc.clusters.tiles.indexOf(w.toLowerCase()));
  T('  mixed pick ' + JSON.stringify({ ga, gb, pick }));
  for (const i of pick) await tapTile(i);
  await tapKey('submit');
  sc = await state();
  if (sc.over) break;
}
sc = await state();
sh = await sheet();
T('after mixed ' + JSON.stringify({ mistakes: sc.clusters.mistakes, over: sc.over, sheet: sh.title }));
ok(sc.clusters.mistakes >= 4, 'four mixed picks cost four mistakes', sc.clusters.mistakes);
ok(sc.over === true && sc.won === false, 'clusters lose state reached', { over: sc.over, won: sc.won });
ok(sh.open, 'clusters lose sheet open', sh);

// ---- 7) Edgeways: tap the solution chain and cover all twelve ------------------
await clickEl('overBtn');
await ev('window.__press.setMode("edgeways")');
await sleep(900);
let se = await state();
ok(se.mode === 'edgeways', 'edgeways mode active', se.mode);
const sol = se.edgeways.solution;
// first word via REAL letter-tile taps, the rest through the same key path the pad uses
const sideOf = {};
se.edgeways.sides.forEach((s, si) => s.forEach((ch) => { sideOf[ch] = si; }));
const firstWord = sol[0];
for (const ch of firstWord) {
  for (let s = 0; s < 4; s++) {
    const k = se.edgeways.sides[s].indexOf(ch);
    if (k >= 0) { await tapTile(s * 4 + k); break; }
  }
}
se = await state();
ok(se.edgeways.cur === firstWord, 'tapping letter tiles types the word', { cur: se.edgeways.cur, want: firstWord });
await tapKey('submit');
se = await state();
ok(se.edgeways.chain.length === 1, 'the first word is accepted', se.edgeways.chain);
ok(se.edgeways.used.length === new Set(firstWord.split('')).size, 'its letters are marked used', se.edgeways.used);
for (const w of sol.slice(1)) await typeWord(w);
se = await state();
sh = await sheet();
T('after chain ' + JSON.stringify({ chain: se.edgeways.chain, used: se.edgeways.used.length, won: se.won, sheet: sh.title }));
ok(se.edgeways.chain.length === sol.length, 'the whole chain landed', se.edgeways.chain);
ok(se.edgeways.used.length === 12, 'all twelve letters covered', se.edgeways.used.length);
ok(se.won === true && se.over === true, 'edgeways win state reached', { won: se.won, over: se.over });
ok(sh.open && /twelve/i.test(sh.title + ' ' + sh.text), 'win sheet says all twelve are used', sh);
await shot('puzzle-press-gate-edgeways-win');

// ---- 8) portrait touch pass at 390x844 ----------------------------------------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);
await tapKey('c'); await tapKey('r'); await tapKey('a');
let sp = await state();
ok(sp.wordrow.cur === 'cra', 'portrait phone: three pad taps land three letters', sp.wordrow.cur);
await tapTile(14);
sp = await state();
ok(sp.mode === 'wordrow', 'portrait: board taps do not derail wordrow', sp.mode);
await shot('puzzle-press-gate-portrait');
await ev('window.__press.setMode("clusters")');
await sleep(800);
const spc = await state();
const pid = spc.clusters.tiles.indexOf(spc.clusters.groups[1].words[0].toLowerCase());
await tapTile(pid);
const spa = await state();
ok(spa.clusters.sel.length === 1, 'portrait: a real tile tap selects a cluster tile', spa.clusters.sel);

// ---- 9) console errors -------------------------------------------------------
const consoleErrs = cdp.events
  .filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => (e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || '') : e.params.entry.text))
  .filter((t) => !/favicon/i.test(t));
T('console errors: ' + JSON.stringify(consoleErrs.slice(0, 4)));
ok(consoleErrs.length === 0, 'no console errors during the run', consoleErrs.slice(0, 3));

T(fails ? `FAILED: ${fails} check(s)` : 'PASS puzzle-press gate');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
