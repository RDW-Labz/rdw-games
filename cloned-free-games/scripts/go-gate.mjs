#!/usr/bin/env node
// Interaction gate for the Go 9x9 port. Serves the shipped folder, drives headless Chromium,
// dispatches real in-page PointerEvents at board intersections and real CDP mouse clicks on the
// HUD buttons, then asserts the state hook changed. A canvas that merely exists is not proof.
// usage: node go-gate.mjs [dir-with-games/arcade] [port-slug]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const SLUG = process.argv[3] || 'go-board';
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
const PROFILE = mkdtempSync('/tmp/go-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdpBrowser = await CDP.attach(endpoint);
// On this box's chromium (156) browser-level Target.createTarget never returns, and page-level
// methods are refused on the browser socket — attach straight to the page target's ws instead.
const devPort = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page || !page.webSocketDebuggerUrl) throw new Error('no page target in /json/list');
const cdp = await CDP.attach(page.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
void cdpBrowser;
const server = await serve();
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name} ${extra}`); }
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const load = async () => {
  await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const has = await ev('typeof window.__go === "function" && !!document.querySelector("canvas")');
    if (has === true) { await sleep(900); return true; }
  }
  return false;
};
const state = () => ev('window.__go()');
const bstr = () => ev('window.__go.board()');

// Real pointer input: one PointerEvent pair per target element (elementFromPoint usually IS the
// canvas — dispatching on both it and querySelector('canvas') would tap twice).
const tapRC = async (r, c) => {
  const p = await ev(`window.__go.cellPoint(${r},${c})`);
  if (!p) return false;
  const res = await ev(`(()=>{const x=${p.x},y=${p.y};
    const t=[document.elementFromPoint(x,y),document.querySelector('canvas')].filter(Boolean);
    const set=[...new Set(t)];
    for(const el of set){
      el.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true}));
      el.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true}));
    }
    return set.length;})()`);
  await sleep(260);
  return res;
};
const clickBtn = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(340);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// Poll rather than sleep: headless throttles timers and the AI beat is a setTimeout.
const waitFor = async (fnExpr, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(fnExpr);
    if (v) return v;
    await sleep(300);
  }
  return null;
};

console.log(`GO GATE  ${FILE}  http://127.0.0.1:${port}/${FILE}`);
ok('page boots with the hook + canvas', await load());

// ---- 1) boot -------------------------------------------------------------------
let s = await state();
let bd = await bstr();
ok('starts empty, human to move',
  s && s.plies === 0 && s.stones === 0 && s.turn === 'b' && s.human === 'b', JSON.stringify(s));
ok('board string is 81 points', typeof bd === 'string' && bd.length === 81, `${bd?.length}`);

// ---- 2) a real tap places a stone and the engine answers -------------------------
const fired = await tapRC(4, 4);
ok('pointer events reached one target element', fired === 1, String(fired));
s = await waitFor('window.__go().plies >= 2 ? window.__go() : null', 9000);
bd = await bstr();
ok('tap placed black at the centre and the machine replied',
  s && s.plies >= 2 && s.stones >= 2 && bd[4 * 9 + 4] === 'X' && bd.includes('O'),
  JSON.stringify(s) + ' ' + bd);
ok('no duplicate input was counted', s && s.dups === 0 && s.inputs === 1, JSON.stringify({ inputs: s?.inputs, dups: s?.dups }));
const shotPlay = await shot('go-board-01-tap');

// ---- 3) undo returns the turn to the human with the board rebuilt ---------------
await clickBtn('undo');
s = await state();
ok('undo clears back to the human turn', s.plies === 0 && s.stones === 0 && s.turn === 'b' && !s.over, JSON.stringify(s));

// ---- 4) capture, then the machine respects the ko --------------------------------
// QA position: white (3,3) in atari, black takes it at (3,4); white must not retake at once.
const koSetup = 'b,2,3;b,4,3;b,3,2;w,3,3;w,2,4;w,4,4;w,3,5';
await ev(`window.__go.setup(${JSON.stringify(koSetup)})`);
await sleep(400);
bd = await bstr();
const before = bd.split('').filter((v) => v === 'O').length;
await tapRC(3, 4);
s = await waitFor('window.__go().captured >= 1 ? window.__go() : null', 6000);
bd = await bstr();
ok('the tap captured the white stone', s && s.captured >= 1 && bd[3 * 9 + 3] === '.', JSON.stringify(s) + ' ' + bd);
const s2 = await waitFor('window.__go().plies >= 9 ? window.__go() : null', 9000);
bd = await bstr();
ok('the machine replied without retaking (ko guard live)',
  s2 && s2.plies >= 9 && bd[3 * 9 + 3] === '.', JSON.stringify(s2) + ' ' + bd.slice(27, 36));
ok('capture removed exactly one white stone',
  bd.split('').filter((v) => v === 'O').length === before - 1 + 1, `white now ${bd.split('').filter((v) => v === 'O').length}`);

// ---- 5) win state: two passes on a decided board -> score sheet ------------------
// White is walled in with no legal move, so its first beat is a pass; the human's Pass ends it.
const spec = (() => {
  const parts = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    if ((r === 4 && c === 4) || (r === 0 && c === 0) || (r === 0 && c === 1)) continue;
    parts.push(`b,${r},${c}`);
  }
  parts.push('w,0,1');            // last stone is white -> white to move
  return parts.join(';');
})();
await ev(`window.__go.setup(${JSON.stringify(spec)})`);
await sleep(300);
const stuck = await state();
const stuckStones = stuck.stones;
ok('the QA position loads with every point settled', stuck && stuckStones === 79 && stuck.turn === 'b', JSON.stringify(stuck));
// The human passes into a board where white has no legal point: the machine must answer with a
// pass (no new stone), not shuffle, and the two passes end the game on area score.
await clickBtn('pass');
s = await waitFor('window.__go().over ? window.__go() : null', 9000);
const sheet = await ev('document.getElementById("over").classList.contains("open") && document.getElementById("overTitle").textContent + " | " + document.getElementById("overText").textContent');
ok('the machine passed instead of placing (stone count unchanged)', s && s.stones === stuckStones, JSON.stringify({ before: stuckStones, after: s?.stones }));
ok('two passes ended the game with a score sheet',
  s && s.over === true && s.winner === 'b' && s.score && s.score.black > s.score.white,
  JSON.stringify(s));
ok('the sheet states the area score', typeof sheet === 'string' && /Black \d+ · White [\d.]+ \(komi 6\.5\)/.test(sheet), String(sheet));
console.log(`  info sheet: ${sheet}`);
const shotWin = await shot('go-board-02-score');

// ---- 6) lose state: resign ------------------------------------------------------
await clickBtn('overBtn');            // play again -> clean board
await sleep(500);
await clickBtn('resign');
await sleep(300);
s = await state();
ok('resign ends the game as a loss', s && s.over === true && s.winner === 'w', JSON.stringify(s));
const shotLose = await shot('go-board-03-resign');

// ---- 7) portrait touch ----------------------------------------------------------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await load();
await sleep(700);
const beforeP = await state();
await tapRC(4, 4);
const sP = await waitFor('window.__go().plies >= 2 ? window.__go() : null', 9000);
bd = await bstr();
ok('portrait touch taps and the reply lands', sP && sP.plies >= 2 && bd[4 * 9 + 4] === 'X', JSON.stringify(sP));
ok('portrait had an empty board before the tap', beforeP && beforeP.plies === 0);
const shotPhone = await shot('go-board-04-portrait');

// ---- 8) console errors ----------------------------------------------------------
const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text ||
    (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => t && !/favicon/.test(t));
ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\nshots: ${shotPlay}\n       ${shotWin}\n       ${shotLose}\n       ${shotPhone}`);
console.log(fails ? `\n${fails} GATE FAILURE(S)` : '\nGATE PASSED');
proc.kill();
server.close();
process.exit(fails ? 1 : 0);
