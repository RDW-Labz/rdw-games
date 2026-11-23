#!/usr/bin/env node
// Interaction gate for the Lexica port. Serves the SITE REPO ROOT (so the port imports the same
// kit.js it ships with), boots headless Chromium and drives real CDP clicks on real tiles, then
// reads window.__lexica() for proof. Every assertion below is a state change caused by a click —
// a canvas that merely exists is not proof.
//
// usage: node lexica-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/lexica/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/lx-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
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
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(7000);

const state = () => ev('window.__lexica()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

async function clickId(id) {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};})()`);
  if (!b || !b.w) { T('  !! no visible #' + id + ' :: ' + JSON.stringify(b)); return false; }
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(130);
  return true;
}
async function cellPoint(i, n) {
  const p = await ev(`window.__lexica.tilePoint(${Math.floor(i / n)}, ${i % n})`);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { T('  !! bad tile point for ' + i + ' :: ' + JSON.stringify(p)); return null; }
  return p;
}
async function tapCell(i, n) {
  const p = await cellPoint(i, n);
  if (!p) return false;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(90);
  return true;
}
async function chainTaps(path, n) {
  for (const i of path) if (!(await tapCell(i, n))) return false;
  return true;
}

// ---- 1) boot
ok((await ev('typeof window.__lexica')) === 'function', 'hook is a function (the catalog gate probes typeof)');
const s0 = await state();
if (!s0 || s0.__err) { console.error('NO HOOK ' + JSON.stringify(s0)); process.exit(1); }
ok(s0.n === 4 && s0.board.length === 16, 'boots on a 4x4 board', { n: s0.n, cells: s0.board.length });
ok(s0.minLen === 3, 'the 4x4 board needs three-letter words', s0.minLen);
ok(s0.score === 0 && s0.round === 0 && !s0.over && !s0.sheet, 'boots unplayed', { score: s0.score, round: s0.round });
ok(s0.remaining > 60 && s0.remaining <= 90, 'the round clock is armed from boot', s0.remaining);
ok(s0.seeds.length >= 3 && s0.seeds.every((x) => x.word.length >= 3), 'the board ships seeded words', s0.seeds.map((x) => x.word));

const geom = await ev(`(() => {
  const b = window.__lexica.band();
  const cv = document.querySelector('body > canvas').getBoundingClientRect();
  const n = window.__lexica().n;
  const bad = [], pick = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const p = window.__lexica.tilePoint(r, c);
    const idx = r * n + c;
    const back = window.__lexica.cellAt(p);
    if (back !== idx) pick.push([idx, back]);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    const nx = 2 * (p.x - cv.left) / cv.width - 1;
    if (ny > b.top + 0.004 || ny < b.bottom - 0.004 || Math.abs(nx) > 0.96) bad.push([r, c, +nx.toFixed(3), +ny.toFixed(3)]);
  }
  return { bad, pick, band: b, vp: [innerWidth, innerHeight] };
})()`);
ok(geom.bad.length === 0, 'all 16 tiles sit inside the play band', geom.bad.slice(0, 4));
ok(geom.pick.length === 0, 'every tile point resolves back to its own tile', geom.pick.slice(0, 4));
const shotBoot = await shot('lexica-gate-boot');

// ---- 2) the clock is wall-clock, not frame-counted
const r1 = (await state()).remaining;
await sleep(1100);
const r2 = (await state()).remaining;
ok(r2 < r1 - 0.5, 'the clock drains on wall time', { before: r1, after: r2 });

// ---- 3) tap a seeded word and submit it
const seed = (await state()).seeds[0];
T('seeded word ' + seed.word + ' at ' + JSON.stringify(seed.path));
await chainTaps(seed.path, 4);
let sc = await state();
ok(sc.chain.length === seed.path.length, 'tapping the tiles builds the chain', { chain: sc.chain, want: seed.path });
ok(sc.chainWord === seed.word, 'the chain spells the seeded word', { got: sc.chainWord, want: seed.word });
ok(sc.inputs === seed.path.length, 'every accepted tap is counted once', sc.inputs);
const shotMid = await shot('lexica-gate-mid');
await clickId('submit');
sc = await state();
ok(sc.score > 0, 'submitting the word scores', { score: sc.score, word: seed.word });
ok(sc.found.includes(seed.word), 'the word joins the found list', sc.found);
ok(sc.chain.length === 0, 'the chain clears after a scored word', sc.chain);
ok(sc.submits === 1 && sc.errors === 0, 'one honest submit, no errors', { submits: sc.submits, errors: sc.errors });

// ---- 4) a rejected word changes nothing but the error counter
await tapCell(seed.path[0], 4);
const before = await state();
await clickId('submit');                       // one letter: too short
const after = await state();
ok(after.score === before.score, 'a one-letter "word" scores nothing', { before: before.score, after: after.score });
ok(after.errors === before.errors + 1, 'the rejection is counted', { before: before.errors, after: after.errors });
ok(after.chain.length === 0, 'the rejected chain is cleared', after.chain);
await clickId('clear');

// ---- 5) the same tap twice inside one tick is one tap (double-tap guard)
const dupD = (await state()).dups;
const p0 = await cellPoint(seed.path[seed.path.length - 1], 4);
const dupRes = await ev(`(() => {
  const p = ${JSON.stringify(p0)};
  const fire = (type) => window.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 11, pointerType: 'mouse' }));
  const before = window.__lexica();
  fire('pointerdown'); fire('pointerup');
  fire('pointerdown'); fire('pointerup');
  const after = window.__lexica();
  return { dups: after.dups - before.dups, chain: after.chain.length, inputs: after.inputs - before.inputs, before: before.dups };
})()`);
ok(dupRes.dups >= 1 && dupRes.chain === 1 && dupRes.inputs === 1,
  'a doubled tap on one tile counts once', dupRes);
await clickId('clear');

// ---- 6) the swipe gesture submits a whole chain at once
const seed2 = (await state()).seeds[1];
const swipe = await ev(`(async () => {
  const n = window.__lexica().n;
  const path = ${JSON.stringify(seed2.path)};
  const pts = path.map((i) => window.__lexica.tilePoint(Math.floor(i / n), i % n));
  const fire = (type, el, p) => el.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 7, pointerType: 'touch' }));
  const body = document.body;
  fire('pointerdown', body, pts[0]);
  for (const p of pts.slice(1)) fire('pointermove', body, p);
  fire('pointerup', body, pts[pts.length - 1]);
  await new Promise((r) => setTimeout(r, 250));
  const st = window.__lexica();
  return { score: st.score, found: st.found, lastWord: st.lastWord, chain: st.chain.length };
})()`);
ok(swipe && swipe.found && swipe.found.includes(seed2.word), 'a swipe through a seeded word scores it', { ...swipe, word: seed2.word });

// ---- 7) lose: the clock runs out below the goal
await ev('window.__lexica.setup({ round: 0, score: 2, remaining: 1.2 })');
let lost = null;
for (let i = 0; i < 24 && !lost; i++) {
  await sleep(250);
  const st = await state();
  if (st.over) lost = st;
}
const lSheet = await sheet();
ok(!!lost && lost.result === 'lose' && lost.overReason === 'Time', 'the clock running out below the goal loses the round',
  lost && { result: lost.result, why: lost.overReason, remaining: lost.remaining });
ok(lSheet.open && /Time's up/.test(lSheet.title), 'the lose sheet opens', lSheet);
const shotLose = await shot('lexica-gate-lose');
await clickId('overBtn');
const fresh = await state();
ok(!fresh.over && fresh.round === 0 && fresh.score === 0, 'new run resets to round one', { round: fresh.round, score: fresh.score });

// ---- 8) win: one point short on the last round, then score a word
const winSetup = await ev('window.__lexica.setup({ round: 2, score: 19, remaining: 60 })');
ok(winSetup && winSetup.n === 6 && winSetup.target === 20, 'QA jumps to the 6x6 final round one point short',
  winSetup && { n: winSetup.n, target: winSetup.target, score: winSetup.score });
const seed3 = winSetup.seeds.find((x) => x.path.length >= 4) || winSetup.seeds[0];
T('winning word ' + seed3.word);
await chainTaps(seed3.path, 6);
await clickId('submit');
let wonSt = null;
for (let i = 0; i < 16 && !wonSt; i++) {
  await sleep(250);
  const st = await state();
  if (st.over) wonSt = st;
}
const wSheet = await sheet();
ok(!!wonSt && wonSt.result === 'win' && wonSt.over, 'clearing the last round wins the run',
  wonSt && { result: wonSt.result, round: wonSt.round });
ok(wSheet.open && /Run complete/.test(wSheet.title), 'the win sheet opens', wSheet);
const shotWin = await shot('lexica-gate-win');
await clickId('overBtn');
ok(!(await state()).over, 'the win sheet starts a fresh run');

// ---- 9) portrait pass at 390x844
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`window.dispatchEvent(new Event('resize'))`);
await sleep(1200);
await ev('window.__lexica.newRun(7)');
await sleep(900);
const pgeom = await ev(`(() => {
  const b = window.__lexica.band();
  const cv = document.querySelector('body > canvas').getBoundingClientRect();
  const n = window.__lexica().n;
  const bad = [], pick = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const p = window.__lexica.tilePoint(r, c);
    const idx = r * n + c;
    if (window.__lexica.cellAt(p) !== idx) pick.push([idx, window.__lexica.cellAt(p)]);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top + 0.004 || ny < b.bottom - 0.004) bad.push([r, c, +ny.toFixed(3)]);
  }
  return { bad, pick, band: b, vp: [innerWidth, innerHeight] };
})()`);
ok(pgeom.bad.length === 0, 'portrait: every tile sits inside the play band', { bad: pgeom.bad.slice(0, 4), band: pgeom.band, vp: pgeom.vp });
ok(pgeom.pick.length === 0, 'portrait: every tile point resolves back to its own tile', pgeom.pick.slice(0, 4));
const pseed = (await state()).seeds[0];
await chainTaps(pseed.path, 4);
const pst = await state();
if (pst.chain.length !== pseed.path.length) {      // headless can swallow the first tap after a metrics override
  await chainTaps(pseed.path, 4);
}
const pst2 = await state();
ok(pst2.chainWord === pseed.word, 'portrait: tapping builds the word', { got: pst2.chainWord, want: pseed.word });
await clickId('submit');
ok((await state()).score > 0, 'portrait: submitting scores', (await state()).score);
const shotPortrait = await shot('lexica-gate-portrait');

// ---- 10) console errors
const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).filter((t) => !/favicon/i.test(t));
ok(errs.length === 0, 'no console errors', errs.slice(0, 4));

console.log(JSON.stringify({ shotBoot, shotMid, shotWin, shotLose, shotPortrait }, null, 1));
console.log(fails ? `GATE FAILED (${fails})` : 'LEXICA GATE PASS');
cdp.ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(fails ? 1 : 0);
