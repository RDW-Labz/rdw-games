#!/usr/bin/env node
// Interaction gate for the Matewave port: real CDP mouse/touch input on the 3D board,
// state-hook assertions for play / tactics / openings, screenshots.
// usage: node matewave-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/matewave.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/matewave-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
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

// This build's browser-level Target.createTarget never returns; drive the page target
// directly — page-level CDP needs no session id.
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await pageCdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(5000);

const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickSquare = async (r, c) => {
  const p = await ev(`window.__matewave.tilePoint(${r},${c})`);
  if (!p || p.x == null) throw new Error('tilePoint null at ' + r + ',' + c);
  await click(p);
  await sleep(260);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(420);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot: play mode, 32-piece board, 20 legal white moves
const s0 = await ev('window.__matewave()');
const b0 = await ev('window.__matewave.board()');
const pts = {};
for (const [k, r, c] of [['e2', 6, 4], ['e4', 4, 4], ['a1', 7, 0], ['h8', 0, 7], ['e1', 7, 4], ['e8', 0, 4]]) pts[k] = await ev(`window.__matewave.tilePoint(${r},${c})`);
const shotBoot = await shot('matewave-gate-boot');

// ---- 2) real click-click move e2-e4, engine answers
await clickSquare(6, 4);
const sSel = await ev('window.__matewave()');
await clickSquare(4, 4);
const sAfter = await ev('window.__matewave()');
const boardAfter = await ev('window.__matewave.board()');
await sleep(3000);
const sReply = await ev('window.__matewave()');

// ---- 3) enemy piece must not select
await clickSquare(1, 4);
const sEnemy = await ev('window.__matewave()');

// ---- 4) engine ladder cycles with the HUD
const lvlBefore = await ev('window.__matewave()');
await clickEl('levelBtn');
const lvlAfter = await ev('window.__matewave()');
const hudLevel = await ev(`document.getElementById('info').textContent`);

// ---- 5) undo returns to the player's turn at the start
await clickEl('undo');
const sUndo = await ev('window.__matewave()');

// ---- 6) mode -> Tactics via the real button; mate-in-1 proven by clicks
await clickEl('modeTactics');
const t0 = await ev('window.__matewave()');
const shotTactics = await shot('matewave-gate-tactics');
await clickSquare(7, 4);          // e1 rook
const tSel = await ev('window.__matewave()');
await clickSquare(0, 4);          // e8 mate
await sleep(900);
const tSolved = await ev('window.__matewave()');
const tacticSheet = await sheet();
const shotSolved = await shot('matewave-gate-solved');

// ---- 7) Next puzzle advances the set
await clickEl('overBtn');
const tNext = await ev('window.__matewave()');

// ---- 8) a wrong move is scored and leaves the board untouched
const tBoardBefore = await ev('window.__matewave.board()');
await clickSquare(7, 0);          // a1 rook
await clickSquare(6, 0);          // a2 — legal, but not the mate
await sleep(400);
const tWrong = await ev('window.__matewave()');
const tBoardAfterWrong = await ev('window.__matewave.board()');
await sleep(1300);

// ---- 9) mode -> Openings; book move, black's reply, wrong move, then finish the line
await clickEl('modeOpenings');
const o0 = await ev('window.__matewave()');
await clickSquare(6, 4);          // e2
await clickSquare(4, 4);          // e4 — book
await sleep(1400);
const oAfterE4 = await ev('window.__matewave()');
await clickSquare(7, 1);          // b1 — legal, not the book move
await clickSquare(5, 2);          // c3
await sleep(500);
const oWrong = await ev('window.__matewave()');
await sleep(1300);
await clickSquare(7, 6);          // g1
await clickSquare(5, 5);          // f3 — book
await sleep(1400);
await clickSquare(7, 5);          // f1
await clickSquare(4, 2);          // c4 — book, line complete
await sleep(1400);
const oDone = await ev('window.__matewave()');
const openingSheet = await sheet();
const shotOpening = await shot('matewave-gate-opening');

// ---- 10) sheet advances to the next opening, then R restarts it
await clickEl('overBtn');
const oNext = await ev('window.__matewave()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const oRestart = await ev('window.__matewave()');

// ---- 11) portrait touch: a tap-tap move must really move
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
await clickEl('modePlay');
const tEdge = await ev('window.__matewave.tilePoint(0,7)');
const tFrom = await ev('window.__matewave.tilePoint(6,4)');
const tTo = await ev('window.__matewave.tilePoint(4,4)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
await tap(tFrom);
const touchSel = await ev('window.__matewave()');
await tap(tTo);
await sleep(2600);
const touchAfter = await ev('window.__matewave()');
const boardTouch = await ev('window.__matewave.board()');
const shotTouch = await shot('matewave-gate-touch');
const errors2 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const START = 'rnbqkbnr' + 'pppppppp' + '.'.repeat(32) + 'PPPPPPPP' + 'RNBQKBNR';
const checks = {
  boot: !!s0 && s0.mode === 'play' && s0.pieces === 32 && s0.legalAll === 20 && s0.turn === 'w' && s0.meshes === 32 && s0.thinking === false && b0 === START,
  select: sSel.selected === 52 && sSel.legalForSel === 2,
  moved: sAfter.ply === 1 && sAfter.pieces === 32 && sAfter.selected === -1 && boardAfter[36] === 'P' && boardAfter[52] === '.',
  replied: sReply.ply >= 2 && sReply.turn === 'w' && sReply.thinking === false,
  enemyRejected: sEnemy.selected === -1,
  levelCycled: lvlAfter.level === (lvlBefore.level + 1) % 5 && lvlAfter.levelName !== lvlBefore.levelName && hudLevel.includes(lvlAfter.levelName),
  undone: sUndo.ply === 0 && sUndo.pieces === 32,
  tacticsLoaded: t0.mode === 'tactics' && t0.tactics.idx === 0 && t0.tactics.total === 7 && t0.pieces === 9,
  tacticsSelected: tSel.selected === 60,
  tacticsSolved: tSolved.tactics.status === 'solved' && tSolved.tactics.solved === 1 && tSolved.over === true && tacticSheet.open === true && /solved/i.test(tacticSheet.title),
  tacticNext: tNext.tactics.idx === 1 && tNext.tactics.status === 'play' && tNext.over === false,
  tacticWrongScored: tWrong.tactics.misses === 1 && tWrong.ply === tNext.ply && tBoardAfterWrong === tBoardBefore,
  openingsLoaded: o0.mode === 'openings' && o0.opening.idx === 0 && o0.opening.name === 'Italian Game' && o0.opening.total === 6,
  openingBookMove: oAfterE4.opening.step >= 2 && oAfterE4.ply >= 2 && oAfterE4.turn === 'w' && oAfterE4.over === false,
  openingWrongScored: oWrong.opening.misses === 1 && oWrong.opening.step === oAfterE4.opening.step,
  openingComplete: oDone.opening.done === 1 && oDone.over === true && openingSheet.open === true && /line complete/i.test(openingSheet.title),
  openingNext: oNext.opening.idx === 1 && oNext.opening.name === 'Ruy Lopez' && oNext.over === false,
  openingRestart: oRestart.opening.step === 0 && oRestart.ply === 0 && oRestart.opening.idx === 1,
  onScreen: Object.values(pts).every((p) => p && p.x > 8 && p.x < 1272 && p.y > 8 && p.y < 792),
  touchMoved: touchSel.selected === 52 && touchAfter.ply >= 1 && boardTouch[36] === 'P' && boardTouch[52] === '.',
  touchOnScreen: !!(tEdge && tFrom && tTo) && [tEdge, tFrom, tTo].every((p) => p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors,
  boardAfter, b0,
  s0: { mode: s0.mode, pieces: s0.pieces, legalAll: s0.legalAll },
  sSel: { selected: sSel.selected, legalForSel: sSel.legalForSel },
  sAfter: { ply: sAfter.ply, turn: sAfter.turn, pieces: sAfter.pieces },
  sReply: { ply: sReply.ply, turn: sReply.turn, thinking: sReply.thinking },
  lvl: { before: lvlBefore.levelName, after: lvlAfter.levelName, hud: hudLevel },
  t0: { mode: t0.mode, tactics: t0.tactics, pieces: t0.pieces },
  tSel: { selected: tSel.selected, legalForSel: tSel.legalForSel },
  tSolved: { tactics: tSolved.tactics, over: tSolved.over }, tacticSheet,
  tNext: tNext.tactics, tWrong: { tactics: tWrong.tactics, ply: tWrong.ply },
  o0: { mode: o0.mode, opening: o0.opening },
  oAfterE4: { opening: oAfterE4.opening, ply: oAfterE4.ply, turn: oAfterE4.turn },
  oWrong: oWrong.opening,
  oDone: { opening: oDone.opening, over: oDone.over }, openingSheet,
  oNext: oNext.opening, oRestart: { opening: oRestart.opening, ply: oRestart.ply },
  errors2, touchSel: { selected: touchSel.selected }, touchAfter: { ply: touchAfter.ply, turn: touchAfter.turn }, boardTouch,
  tEdge, tFrom, tTo,
  shots: [shotBoot, shotTactics, shotSolved, shotOpening, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
