#!/usr/bin/env node
// Interaction gate for the Bagatur engine port: real CDP mouse input on the 3D board,
// state-hook assertions for move / capture / undo / mate, screenshots.
// usage: node lichess-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/bagatur-chess-engine.html';
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
const PROFILE = mkdtempSync('/tmp/chess-gate-');
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
await sleep(5000);

const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
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
  const p = await ev(`window.__bagatur.tilePoint(${r},${c})`);
  await click(p);
  await sleep(240);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot: a real 32-piece board, 20 legal moves for white, engine idle
const s0 = await ev('window.__bagatur()');
const b0 = await ev('window.__bagatur.board()');
const pts = {};
for (const [k, r, c] of [['e2', 6, 4], ['e4', 4, 4], ['e7', 1, 4], ['a1', 7, 0], ['h8', 0, 7], ['d5', 3, 3]]) pts[k] = await ev(`window.__bagatur.tilePoint(${r},${c})`);
const shotBoot = await shot('bagatur-gate-boot');

// ---- 2) real click-click move: e2 -> e4, then the engine answers
await clickSquare(6, 4);
const sSel = await ev('window.__bagatur()');
await clickSquare(4, 4);
const sAfter = await ev('window.__bagatur()');
const boardAfter = await ev('window.__bagatur.board()');
const shotMove = await shot('bagatur-gate-move');
await sleep(2600);
const sReply = await ev('window.__bagatur()');

// ---- 3) clicking an enemy piece must not select it
await clickSquare(1, 4);
const sEnemyClick = await ev('window.__bagatur()');

// ---- 4) hint: the engine suggests a real, legal white move and marks it
await clickEl('hintBtn');
const sHint = await ev('window.__bagatur()');
const hintLegal = await ev(`(()=>{const h=window.__bagatur().hint;if(!h)return false;return window.__bagatur.legalFrom(h[0]).includes(h[1]);})()`);
const hintVisible = await ev(`(()=>document.getElementById('hintBtn')!==null)()`);

// ---- 5) strength button cycles the ladder and the HUD follows
const lvlBefore = await ev('window.__bagatur()');
await clickEl('levelBtn');
const lvlAfter = await ev('window.__bagatur()');
const hudLevel = await ev(`document.getElementById('level').textContent`);

// ---- 6) undo returns to the player's turn at the start position
await clickEl('undo');
const sUndo = await ev('window.__bagatur()');

// ---- 7) capture removes a piece: e4xd5
await ev(`window.__bagatur.setup('4k3/8/8/3p4/4P3/8/8/4K3 w')`);
await sleep(300);
const sCapBefore = await ev('window.__bagatur()');
await clickSquare(4, 4);
await clickSquare(3, 3);
await sleep(400);
const sCap = await ev('window.__bagatur()');
const boardCap = await ev('window.__bagatur.board()');
const shotCap = await shot('bagatur-gate-capture');

// ---- 8) win path: Ra1-a8 mate opens the win sheet
await ev(`window.__bagatur.setup('6k1/5ppp/8/8/8/8/8/R5K1 w')`);
await sleep(300);
await clickSquare(7, 0);
await clickSquare(0, 0);
await sleep(700);
const sWin = await ev('window.__bagatur()');
const winSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shotWin = await shot('bagatur-gate-win');

// ---- 9) lose path: full-strength engine mates on its own turn
await ev('window.__bagatur.setLevel(4)');
await ev(`window.__bagatur.setup('r5k1/5ppp/8/8/8/8/5PPP/6K1 b')`);
await sleep(3600);
const sLose = await ev('window.__bagatur()');
const loseSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shotLose = await shot('bagatur-gate-lose');

// ---- 10) restart from the sheet, then the R key
await clickEl('overBtn');
await sleep(500);
const sNew = await ev('window.__bagatur()');
const boardNew = await ev('window.__bagatur.board()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await ev('window.__bagatur()');
const shotEnd = await shot('bagatur-gate-end');

// ---- 11) touch: portrait phone, tap-tap must move for real
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tEdge = await ev('window.__bagatur.tilePoint(0,7)');
const tFrom = await ev('window.__bagatur.tilePoint(6,4)');
const tTo = await ev('window.__bagatur.tilePoint(4,4)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
await tap(tFrom);
const tSel = await ev('window.__bagatur()');
await tap(tTo);
await sleep(2400);
const sTouch = await ev('window.__bagatur()');
const boardTouch = await ev('window.__bagatur.board()');
const shotTouch = await shot('bagatur-gate-touch');
const errors2 = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const START = 'rnbqkbnr' + 'pppppppp' + '.'.repeat(32) + 'PPPPPPPP' + 'RNBQKBNR';
const checks = {
  boot: !!s0 && s0.pieces === 32 && s0.legalAll === 20 && s0.turn === 'w' && s0.meshes === 32 && s0.thinking === false && b0 === START,
  select: sSel.selected === 52 && sSel.legalForSel === 2,
  moved: sAfter.ply === 1 && sAfter.pieces === 32 && sAfter.selected === -1 && boardAfter[36] === 'P' && boardAfter[52] === '.',
  replied: sReply.ply >= 2 && sReply.turn === 'w' && sReply.thinking === false,
  enemyRejected: sEnemyClick.selected === -1,
  hinted: hintLegal === true && Array.isArray(sHint.hint) && sHint.hint.length === 2 && hintVisible === true,
  levelCycled: lvlAfter.level === (lvlBefore.level + 1) % 5 && lvlAfter.levelName !== lvlBefore.levelName && hudLevel.includes(lvlAfter.levelName),
  undone: sUndo.ply === 0 && sUndo.pieces === 32,
  captured: sCapBefore.pieces === 4 && sCap.pieces === 3 && boardCap[27] === 'P' && boardCap[36] === '.',
  won: sWin.over === true && sWin.result === 'win' && winSheet.open === true && /win/i.test(winSheet.title),
  lost: sLose.over === true && sLose.result === 'lose' && loseSheet.open === true && /checkmate/i.test(loseSheet.title),
  restarted: sNew.ply === 0 && sNew.pieces === 32 && sNew.over === false && boardNew === START,
  keyRestart: sR.ply === 0 && sR.pieces === 32 && sR.over === false,
  onScreen: Object.values(pts).every((p) => p && p.x > 8 && p.x < 1272 && p.y > 8 && p.y < 792),
  touchMoved: sTouch.ply >= 1 && boardTouch[36] === 'P' && boardTouch[52] === '.' && tSel.selected === 52,
  touchOnScreen: !!(tEdge && tFrom && tTo) && [tEdge, tFrom, tTo].every((p) => p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors,
  boardAfter, boardCap, boardNew,
  s0, sSel: { selected: sSel.selected, legalForSel: sSel.legalForSel },
  sAfter: { ply: sAfter.ply, turn: sAfter.turn, pieces: sAfter.pieces },
  sReply: { ply: sReply.ply, turn: sReply.turn, thinking: sReply.thinking },
  sHint: { hint: sHint.hint }, hintLegal,
  lvl: { before: lvlBefore.levelName, after: lvlAfter.levelName, hud: hudLevel },
  sCap: { pieces: sCap.pieces, ply: sCap.ply },
  sWin: { over: sWin.over, result: sWin.result }, winSheet,
  sLose: { over: sLose.over, result: sLose.result }, loseSheet,
  errors2, tSel: { selected: tSel.selected, legalForSel: tSel.legalForSel },
  sTouch: { ply: sTouch.ply, turn: sTouch.turn, pieces: sTouch.pieces }, boardTouch,
  tEdge, tFrom, tTo,
  shots: [shotBoot, shotMove, shotCap, shotWin, shotLose, shotEnd, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
