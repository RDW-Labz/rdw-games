#!/usr/bin/env node
// Interaction gate for the Sudaku port (pattern-driven sudoku workbench).
// Real CDP mouse on the 3D board and the pad; every assertion reads the page's state hook,
// so pixels alone never count as proof. Covers: select, type a digit, All-diff eliminations,
// Ripple to a win through the real buttons, Play again, three contradictions -> lose sheet,
// plus a 390x844 portrait pass (board must clear the HUD, tap + pad still work).
//
// usage: node sudaku-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PORT_PATH = '/games/arcade/sudaku-pattern-driven-sudoku/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails.push(msg);
  T('  FAIL ' + msg + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''));
  return false;
};

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
  return new Promise((okay) => s.listen(0, '127.0.0.1', () => okay(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((okay, bad) => { ws.onopen = okay; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { okay: o, bad: b } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? b(new Error(msg.error.message)) : o(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((okay, bad) => {
      this.p.set(id, { okay, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/sudaku-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((okay, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); okay(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
T('serving ' + ROOT + ' on ' + port);
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error' };
  return r.result ? r.result.value : undefined;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await mkdir(OUT, { recursive: true });

const url = `http://127.0.0.1:${port}${PORT_PATH}`;
await S('Page.navigate', { url });
const boot = await (async () => {
  for (let i = 0; i < 60; i++) {
    const v = await ev('typeof window.__sudaku === "function" ? 1 : (window.__err || 0)');
    if (v === 1) return true;
    await sleep(400);
  }
  return false;
})();
ok(boot, 'page boots and exposes the state hook');
if (!boot) {
  const dump = await ev('document.body.innerText.slice(0,300)');
  T('body: ' + JSON.stringify(dump));
  T('console: ' + JSON.stringify(pageCdp.events.filter((e) => e.method === 'Log.entryAdded').slice(-6)));
  process.exit(1);
}

const hook = () => ev('window.__sudaku()');
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 });
  await sleep(140);
};
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT, 'sudaku-' + name + '.png');
  await writeFile(p, Buffer.from(r.data, 'base64'));
  T('shot ' + p);
  return p;
};

const s0 = await hook();
ok(s0 && s0.n === 9 && s0.filled === 31 && !s0.solved && !s0.over, 'boot state: 9x9, 31 givens, live', s0 && { n: s0.n, filled: s0.filled });
await shot('boot');

// ---- 1. select a cell through the real canvas ----
const emptyIdx = (s) => s.values.findIndex((v) => v === 0);
const target = emptyIdx(s0);
const tp = await ev(`window.__obj.tilePoint(${Math.floor(target / 9)}, ${target % 9})`);
ok(tp && tp.x > 0 && tp.y > 0, 'tilePoint resolves an empty cell to screen coordinates', tp);
await click(tp);
let s1 = await hook();
ok(s1.sel === target, 'tap selects the cell under the pointer', { want: target, got: s1.sel, inputs: s1.inputs, dups: s1.dups });

// ---- 2. type the correct digit from the pad (so the ripple path below is honest) ----
const answer = await ev(`window.__obj.answer()`);
const wantDigit = answer[target];
const before = s1.filled;
const padPt = await ev(`window.__obj.padPoint(${wantDigit})`);
ok(padPt && padPt.x > 0 && padPt.y > 0, 'the pad key reports a point', padPt);
await click(padPt);
let s2 = await hook();
ok(s2.filled === before + 1, 'pad press writes a digit into the selected cell', { before, after: s2.filled, log: s2.log });
ok(s2.values[s2.sel] === wantDigit, 'the written value is the key that was pressed', { sel: s2.sel, v: s2.values[s2.sel], wantDigit });
await shot('typed');

// ---- 3. All-diff must do real work after a digit was typed ----
const logBefore = s2.log;
await ev(`window.__obj.pattern('alldiff')`);
let s3 = await hook();
const elims = (s3.log.match(/all-diff:\s*(\d+)/) || [])[1];
ok(Number(elims) > 0, 'All-diff eliminates candidates created by the typed digit', { log: s3.log, logBefore });
const changedCands = s3.cands.filter((c, i) => c !== s2.cands[i]).length;
ok(changedCands > 0, 'All-diff visibly narrowed the pencil marks', { changedCands });

// ---- 4. One-of / Ripple to a win through the real buttons ----
const ripplePt = await ev(`(() => { const b = document.getElementById('rippleBtn').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
let won = false, presses = 0;
for (let i = 0; i < 6 && !won; i++) {
  await click(ripplePt);
  presses++;
  const s = await hook();
  if (s.won) won = true;
}
let s4 = await hook();
ok(won, 'Ripple alone finishes the board (win state reached by the port\'s own rules)', { presses, filled: s4.filled, log: s4.log });
if (won) {
  ok(s4.over === true, 'win sets over');
  ok(s4.solved === true, 'win board passes the clue check');
  const sheet = await ev(`document.getElementById('over').classList.contains('open')`);
  const title = await ev(`document.getElementById('overTitle').textContent`);
  ok(sheet === true && /Solved/.test(title), 'win sheet opens with its title', { sheet, title });
  await shot('win');
}

// ---- 5. Play again resets the board ----
const againPt = await ev(`(() => { const b = document.getElementById('overBtn').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
await click(againPt);
let s5 = await hook();
ok(s5.filled === 31 && !s5.over && !s5.won && s5.mistakes === 0, 'Play again resets to the fresh puzzle', { filled: s5.filled, over: s5.over });

// ---- 6. three contradictions close the grid ----
let s6 = s5, charged = 0;
for (let cellTry = 0; cellTry < 8 && charged < 3; cellTry++) {
  const idx = s6.values.findIndex((v, i) => v === 0 && i !== s6.sel);
  if (idx < 0) break;
  const pt = await ev(`window.__obj.tilePoint(${Math.floor(idx / 9)}, ${idx % 9})`);
  await click(pt);
  for (let d = 9; d >= 1 && charged < 3; d--) {
    const cur = await hook();
    if (cur.over) break;
    if (cur.mistakes > charged) { charged = cur.mistakes; break; }
    const p = await ev(`window.__obj.padPoint(${d})`);
    await click(p);
    const after = await hook();
    if (after.mistakes > charged) { charged = after.mistakes; s6 = after; break; }
    s6 = after;
  }
  s6 = await hook();
}
ok(s6.mistakes >= 3, 'three contradicting entries are charged', { mistakes: s6.mistakes });
ok(s6.over === true && s6.won === false, 'grid closes on the third contradiction', { over: s6.over, won: s6.won, log: s6.log });
const loseTitle = await ev(`document.getElementById('overTitle').textContent`);
ok(/closed/i.test(loseTitle), 'lose sheet opens', { loseTitle });
await shot('lose');

// ---- 7. portrait pass ----
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`dispatchEvent(new Event('resize')); 1`);
await sleep(700);
const rest = await ev(`(() => { document.getElementById('overBack').click(); return (typeof window.__sudaku === 'function'); })()`);
await ev(`window.__obj.newGame(null, null); 1`);
await sleep(700);
const geom = await ev(`(() => {
  const s = window.__sudaku();
  const hudTop = document.querySelector('.top').getBoundingClientRect().bottom;
  const hudBot = document.querySelector('.bottom').getBoundingClientRect().top;
  const pts = [];
  for (const [r, c] of [[0,0],[0,8],[8,0],[8,8]]) {
    const p = window.__obj.tilePoint(r, c);
    const hit = document.elementFromPoint(p.x, p.y);
    pts.push({ r, c, x: Math.round(p.x), y: Math.round(p.y), overCanvas: !!(hit && hit.tagName === 'CANVAS'), inBand: p.y > hudTop && p.y < hudBot });
  }
  return { pts, hudTop: Math.round(hudTop), hudBot: Math.round(hudBot), w: innerWidth, h: innerHeight };
})()`);
ok(geom.pts.every((p) => p.overCanvas), 'portrait: every corner cell projects onto the canvas, not the pad', geom);
ok(geom.pts.every((p) => p.inBand), 'portrait: the whole board sits between the top bar and the bottom HUD', { hudTop: geom.hudTop, hudBot: geom.hudBot, pts: geom.pts });
const ptCell = await ev(`(() => { const s = window.__sudaku(); const i = s.values.findIndex((v) => v === 0); return { i, p: window.__obj.tilePoint(Math.floor(i/9), i%9) }; })()`);
await click(ptCell.p);
let sp = await hook();
ok(sp.sel === ptCell.i, 'portrait: tap selects the cell', { want: ptCell.i, got: sp.sel });
const pDigit = await ev(`window.__obj.padPoint(2)`);
await click(pDigit);
sp = await hook();
ok(sp.filled === 32, 'portrait: pad press writes the digit', { filled: sp.filled });
await shot('portrait');

// ---- 8. 16x16 mode boots and its board fits too ----
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await ev(`dispatchEvent(new Event('resize')); window.__obj.newGame(1, 0); 1`);
await sleep(900);
const s16 = await hook();
ok(s16.n === 16 && s16.filled === 159 && !s16.solved, '16x16 puzzle loads with its 159 givens', { n: s16.n, filled: s16.filled });
const g16 = await ev(`(() => {
  const pts = [];
  for (const [r, c] of [[0,0],[0,15],[15,0],[15,15]]) {
    const p = window.__obj.tilePoint(r, c);
    const hit = document.elementFromPoint(p.x, p.y);
    pts.push({ r, c, x: Math.round(p.x), y: Math.round(p.y), ok: !!(hit && hit.tagName === 'CANVAS') });
  }
  return { pts, hudTop: Math.round(document.querySelector('.top').getBoundingClientRect().bottom), hudBot: Math.round(document.querySelector('.bottom').getBoundingClientRect().top) };
})()`);
ok(g16.pts.every((p) => p.ok && p.y > g16.hudTop && p.y < g16.hudBot), '16x16: corners land on the canvas inside the HUD band', g16);
await shot('16x16');
await ev(`window.__obj.pattern('ripple'); 1`);
await sleep(300);
const s16b = await hook();
ok(s16b.solved === true && s16b.won === true, '16x16 ripple solves its board', { filled: s16b.filled, over: s16b.over, log: s16b.log });
await shot('16x16-solved');

// ---- console errors ----
const errs = pageCdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).filter((t) => !/favicon/i.test(t));
ok(errs.length === 0, 'no console errors', errs.slice(0, 4));

console.log(JSON.stringify({ pass: fails.length === 0, fails, url }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
