#!/usr/bin/env node
// Interaction gate for the Gomoku port: real CDP mouse/touch input on the 3D board,
// state-hook assertions for place / AI reply / undo / win / lose / restart, screenshots.
// usage: node gomoku-gate.mjs <dir-containing-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/gomoku.html';
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
const PROFILE = mkdtempSync('/tmp/gomoku-gate-');
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
const tapCell = async (r, c) => {
  const p = await ev(`window.__gomoku.cellPoint(${r},${c})`);
  await click(p);
  await sleep(260);
  return p;
};
const clickEl = async (id) => {
  const p = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(p);
  await sleep(340);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// poll instead of sleeping a fixed time: headless throttles timers
const until = async (expr, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); }
  return false;
};

// ---- 1) boot: empty board, human to move
const s0 = await ev('window.__gomoku()');
const b0 = await ev('window.__gomoku.board()');
const pCenter = await ev('window.__gomoku.cellPoint(7,7)');
const pCorner = await ev('window.__gomoku.cellPoint(0,0)');
const pFar = await ev('window.__gomoku.cellPoint(14,14)');
const shotBoot = await shot('gomoku-gate-boot');

// ---- 2) a real click drops a stone and the machine answers
await tapCell(7, 7);
const sPlaced = await ev('window.__gomoku()');
await until('window.__gomoku().plies >= 2');
const sReply = await ev('window.__gomoku()');
const bReply = await ev('window.__gomoku.board()');
const shotReply = await shot('gomoku-gate-reply');

// ---- 3) a second move, then undo takes back both plies
const free = await ev(`(()=>{const s=window.__gomoku.board();for(let i=0;i<225;i++)if(s[i]==='.')return i;return -1;})()`);
await tapCell(Math.floor(free / 15), free % 15);
await until('window.__gomoku().plies >= 4');
const sMid = await ev('window.__gomoku()');
await clickEl('undo');
const sUndo = await ev('window.__gomoku()');

// ---- 4) win: four black in a row, click the fifth through the real board
await ev(`window.__gomoku.setup('b,7,3;b,7,4;b,7,5;b,7,6;w,2,2')`);
await sleep(400);
const sWinBefore = await ev('window.__gomoku()');
await tapCell(7, 7);
await until('window.__gomoku().over === true', 4000);
const sWin = await ev('window.__gomoku()');
const winSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shotWin = await shot('gomoku-gate-win');

// ---- 5) lose: the machine already has four and finishes it after a human move
await ev(`window.__gomoku.setup('w,7,3;w,7,4;w,7,5;w,7,6')`);
await sleep(400);
const sLoseBefore = await ev('window.__gomoku()');
await tapCell(0, 0);
await until('window.__gomoku().over === true', 6000);
const sLose = await ev('window.__gomoku()');
const loseSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shotLose = await shot('gomoku-gate-lose');

// ---- 6) restart from the sheet, then R
await clickEl('overBtn');
await sleep(400);
const sNew = await ev('window.__gomoku()');
const bNew = await ev('window.__gomoku.board()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await ev('window.__gomoku()');
const shotEnd = await shot('gomoku-gate-end');

// ---- 7) portrait phone: a tap with no mouse must still place a stone
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tEdge = await ev('window.__gomoku.cellPoint(0,0)');
const tFar = await ev('window.__gomoku.cellPoint(14,14)');
const tCenter = await ev('window.__gomoku.cellPoint(7,7)');
const tapAt = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
await tapAt(tCenter);
const sTouchPlaced = await ev('window.__gomoku()');
await until('window.__gomoku().plies >= 2', 6000);
const sTouch = await ev('window.__gomoku()');
const shotTouch = await shot('gomoku-gate-touch');
const errors2 = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const EMPTY = '.'.repeat(225);
const checks = {
  boot: s0 && s0.plies === 0 && s0.turn === 'b' && s0.stones === 0 && s0.over === false && b0 === EMPTY,
  pointsOnScreen: [pCenter, pCorner, pFar].every((p) => p && p.x > 8 && p.x < 1272 && p.y > 8 && p.y < 792),
  placed: sPlaced.plies === 1 && sPlaced.turn === 'w' && bReply[7 * 15 + 7] === 'X',
  replied: sReply.plies === 2 && sReply.turn === 'b' && sReply.thinking === false && sReply.stones === 2,
  midGame: sMid.plies === 4,
  undone: sUndo.plies === 2 && sUndo.turn === 'b' && sUndo.over === false,
  won: sWinBefore.plies === 5 && sWin.over === true && sWin.winner === 1 && winSheet.open === true && /five/i.test(winSheet.title) && sWin.line && sWin.line.length >= 5,
  lost: sLoseBefore.turn === 'b' && sLose.over === true && sLose.winner === 2 && loseSheet.open === true && /machine/i.test(loseSheet.title),
  restarted: sNew.plies === 0 && sNew.over === false && bNew === EMPTY,
  keyRestart: sR.plies === 0 && sR.over === false,
  touchPlaced: sTouchPlaced.plies === 1 && sTouch.plies >= 2 && sTouch.turn === 'b',
  touchOnScreen: [tEdge, tFar, tCenter].every((p) => p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors, errors2,
  s0, sPlaced: { plies: sPlaced.plies, turn: sPlaced.turn }, sReply: { plies: sReply.plies, turn: sReply.turn, stones: sReply.stones },
  sMid: { plies: sMid.plies }, sUndo: { plies: sUndo.plies, turn: sUndo.turn },
  sWinBefore: { plies: sWinBefore.plies, turn: sWinBefore.turn }, sWin: { over: sWin.over, winner: sWin.winner, line: sWin.line }, winSheet,
  sLoseBefore: { plies: sLoseBefore.plies, turn: sLoseBefore.turn }, sLose: { over: sLose.over, winner: sLose.winner }, loseSheet,
  sNew: { plies: sNew.plies, over: sNew.over }, sTouch: { plies: sTouch.plies, turn: sTouch.turn },
  pCenter, pCorner, pFar, tEdge, tFar, tCenter,
  shots: [shotBoot, shotReply, shotWin, shotLose, shotEnd, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
