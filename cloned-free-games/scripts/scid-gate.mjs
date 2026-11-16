#!/usr/bin/env node
// Interaction gate for the Scid on the Go port (chess database viewer): real CDP mouse
// clicks on the transport buttons, the move strip and the board, plus a portrait touch pass.
// usage: node scid-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage-scid');
const FILE = 'games/arcade/scid-on-the-go.html';
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
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    c.events = [];
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/scid-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4800);

const errorsOf = (evs) => evs.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
const errors = errorsOf(cdp.events);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
};
const clickChip = async (n) => {
  const b = await ev(`(()=>{const e=document.querySelectorAll('#strip .mv')[${n}];if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (b) { await click(b); await sleep(320); }
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const STARTPOS = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';

// ---- 1) boot: game 1 loaded at the start position
const s0 = await ev('window.__scid()');
const b0 = await ev('window.__scid.board()');
const games = await ev('window.__scid.games()');
const corners = {};
for (const [k, r, c] of [['a8', 0, 0], ['h8', 0, 7], ['a1', 7, 0], ['h1', 7, 7]]) corners[k] = await ev(`window.__scid.tilePoint(${r},${c})`);
const shotBoot = await shot('scid-gate-boot');

// ---- 2) four real clicks on Next step the game
for (let i = 0; i < 4; i++) await clickEl('next');
const sStep = await ev('window.__scid()');
const bStep = await ev('window.__scid.board()');
const chipNow = await ev(`(()=>{const e=document.querySelector('#strip .mv.now');return e?e.textContent:null;})()`);
const shotStep = await shot('scid-gate-step');

// ---- 3) Play runs the game on its own to the end, then auto-stops
await clickEl('play');
const sPlay = await ev('window.__scid()');
let sPlayed = null;
for (let i = 0; i < 40; i++) {           // headless throttles timers, so poll instead of sleeping blindly
  await sleep(500);
  sPlayed = await ev('window.__scid()');
  if (sPlayed.over) break;
}
// ---- 3b) pause works: restart the game, run briefly, then stop it mid-way
await clickEl('play');
await sleep(1400);
await clickEl('play');
const sPaused = await ev('window.__scid()');

// ---- 4) clicking the last move chip jumps to the final position
await clickChip(6);
const sEnd = await ev('window.__scid()');
const bEnd = await ev('window.__scid.board()');
const res = await ev(`document.getElementById('res').textContent`);
const shotEnd = await shot('scid-gate-end');

// ---- 5) Game button loads the next database entry at ply 0
await clickEl('games');
const sG2 = await ev('window.__scid()');
const bG2 = await ev('window.__scid.board()');
const title2 = await ev(`document.getElementById('gTitle').textContent`);

// ---- 6) tapping the board itself steps forward
const sq = await ev('window.__scid.tilePoint(4,4)');
await click(sq);
await sleep(400);
const sTap = await ev('window.__scid()');
const bTap = await ev('window.__scid.board()');

// ---- 7) flip, then R returns to the start of the game
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyF', key: 'f', windowsVirtualKeyCode: 70 });
await sleep(300);
const sFlip = await ev('window.__scid()');
const flipPt = await ev('window.__scid.tilePoint(0,0)');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await ev('window.__scid()');
const bR = await ev('window.__scid.board()');
const shotFlip = await shot('scid-gate-flip');

// ---- 8) portrait phone: a finger tap on the board steps the game
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);
const tCorner = await ev('window.__scid.tilePoint(0,7)');
const tSq = await ev('window.__scid.tilePoint(5,2)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
};
await tap(tSq);
await sleep(600);
const sTouch = await ev('window.__scid()');
const bTouch = await ev('window.__scid.board()');
const btnBox = await ev(`(()=>{const e=document.getElementById('next');const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`);
const shotTouch = await shot('scid-gate-touch');
const errors2 = errorsOf(cdp.events);

const checks = {
  boot: s0 && s0.gi === 0 && s0.ply === 0 && s0.total === 7 && s0.pieces === 32 && b0 === STARTPOS && s0.over === false,
  db: Array.isArray(games) && games.length === 4 && games[0].plies === 7 && games[2].plies === 14,
  onScreen: Object.values(corners).every((p) => p && p.x > 8 && p.x < 1272 && p.y > 8 && p.y < 792),
  stepped: sStep.ply === 4 && bStep !== STARTPOS && bStep !== b0 && /Nc6/.test(chipNow || ''),
  playing: sPlay.playing === true,
  autoplayed: sPlayed.playing === false && sPlayed.ply === 7 && sPlayed.over === true,
  paused: sPaused.playing === false && sPaused.ply > 0 && sPaused.ply < 7,
  jumped: sEnd.ply === 7 && sEnd.over === true && res === '1–0' && bEnd[13] === 'Q' && bEnd[20] === '.',
  nextGame: sG2.gi === 1 && sG2.ply === 0 && sG2.total === 4 && bG2 === STARTPOS && /Fool/.test(title2 || ''),
  boardTap: sTap.ply === 1 && bTap !== STARTPOS,
  flipped: sFlip.flipped === true && sFlip.pieces === 32 && flipPt && flipPt.x > 8 && flipPt.x < 1272,
  restarted: sR.ply === 0 && bR === STARTPOS && sR.flipped === true,
  touchStepped: sTouch.ply >= 1 && bTouch !== STARTPOS,
  touchLayout: btnBox && btnBox.x >= 0 && btnBox.y >= 0 && btnBox.x + btnBox.w <= 390 && btnBox.y + btnBox.h <= 844 && tCorner && tCorner.x > 2 && tCorner.x < 388 && tCorner.y > 2 && tCorner.y < 842,
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors, errors2,
  s0, sStep: { ply: sStep.ply, chipNow }, sPlay: { playing: sPlay.playing },
  sPlayed: { ply: sPlayed.ply, playing: sPlayed.playing, over: sPlayed.over },
  sEnd: { ply: sEnd.ply, over: sEnd.over, result: sEnd.result }, res,
  sG2: { gi: sG2.gi, title: sG2.game, total: sG2.total }, title2,
  sTap: { ply: sTap.ply }, sFlip: { flipped: sFlip.flipped }, sR: { ply: sR.ply, flipped: sR.flipped },
  sTouch: { ply: sTouch.ply }, btnBox, tCorner, tSq,
  bStep, bEnd, bTouch,
  shots: [shotBoot, shotStep, shotEnd, shotFlip, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
