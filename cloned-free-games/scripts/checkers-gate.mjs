#!/usr/bin/env node
// Interaction gate for the Checkers port: real CDP mouse/touch, compulsory-capture rules,
// win/lose sheets, restart, console-error capture. usage: node checkers-gate.mjs <dir>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/checkers.html';
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
      if (msg.id && c.p.has(msg.id)) { const { ok, bad, method } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? bad(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/checkers-gate-');
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
await sleep(6000);

const errorsOf = (from = 0) => cdp.events.slice(from).filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const cellPt = (r, c) => ev(`window.__checkers.tilePoint(${r},${c})`);
const clickCell = async (r, c) => { const p = await cellPt(r, c); await click(p); await sleep(220); return p; };
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(900); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const pos = (spec) => {
  const b = new Array(64).fill('.');
  for (const [k, list] of Object.entries(spec)) for (const [r, c] of list) b[r * 8 + c] = k;
  return b.join('');
};

// ---- 1) boot
const s0 = await ev('window.__checkers()');
const cam0 = await ev('window.__checkers.camera()');
const shotBoot = await shot('checkers-gate-boot');
const corners = {};
for (const [k, r, c] of [['tl', 0, 1], ['tr', 0, 7], ['bl', 7, 0], ['br', 7, 7]])
  corners[k] = await cellPt(r, c);

// ---- 2) select a piece, then a real click on a legal square moves it, AI replies
const sBootBoard = s0.board;
const firstFrom = [...Array(64).keys()].find((i) => sBootBoard[i] === 'w' && ((i / 8) | 0) === 5);
const fromR = (firstFrom / 8) | 0, fromC = firstFrom % 8;
await clickCell(fromR, fromC);
const sSel = await ev('window.__checkers()');
const tgt = sSel.targets[0];
const toR = (tgt / 8) | 0, toC = tgt % 8;
await clickCell(toR, toC);
const sMoved = await ev('window.__checkers()');
const shotMove = await shot('checkers-gate-move');
await sleep(1400);                            // let the engine reply
const sReply = await ev('window.__checkers()');

// ---- 3) compulsory capture: a jump must be available and must remove a piece
await ev(`window.__checkers.load(${JSON.stringify(pos({ w: [[6, 1]], b: [[5, 2], [0, 1]] }))})`);
await sleep(500);
const sCapPre = await ev('window.__checkers()');
await clickCell(6, 1);
const sCapSel = await ev('window.__checkers()');
await clickCell(4, 3);
const sCap = await ev('window.__checkers()');
const shotCap = await shot('checkers-gate-capture');
await sleep(1400);
const sCapAfter = await ev('window.__checkers()');

// ---- 4) win: capture the last enemy piece
await ev(`window.__checkers.load(${JSON.stringify(pos({ w: [[6, 1]], b: [[5, 2]] }))})`);
await sleep(500);
const sWinPre = await ev('window.__checkers()');
await clickCell(6, 1);
await clickCell(4, 3);
await sleep(500);
const sWin = await ev('window.__checkers()');
const winSheet = await sheet();
const shotWin = await shot('checkers-gate-win');

// ---- 5) lose: black takes your last piece
await ev(`window.__checkers.load(${JSON.stringify(pos({ b: [[2, 1]], w: [[3, 2]] }))}, 'b')`);
await sleep(1800);
const sLose = await ev('window.__checkers()');
const loseSheet = await sheet();
const shotLose = await shot('checkers-gate-lose');

// ---- 6) restart from the sheet, then the R key
await clickEl('overBtn');
await sleep(900);
const sNew = await ev('window.__checkers()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(700);
const sR = await ev('window.__checkers()');

// ---- 7) touch: portrait phone, tap a piece then its target
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const t0 = await ev('window.__checkers()');
const tFrom = [...Array(64).keys()].find((i) => t0.board[i] === 'w' && ((i / 8) | 0) === 5);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
const tPt = await cellPt((tFrom / 8) | 0, tFrom % 8);
await tap(tPt);
const tSel = await ev('window.__checkers()');
const tTgt = tSel.targets[0];
const tTgtPt = await cellPt((tTgt / 8) | 0, tTgt % 8);
await tap(tTgtPt);
await sleep(500);
const sTouch = await ev('window.__checkers()');
const tCorner = await cellPt(0, 7);
const shotTouch = await shot('checkers-gate-touch');
const errors = errorsOf();

const checks = {
  boot: !!s0 && s0.mine === 12 && s0.theirs === 12 && s0.turn === 'w' && s0.over === false && s0.legal > 0,
  onScreen: Object.values(corners).every((p) => p && p.x > 6 && p.x < 1274 && p.y > 6 && p.y < 794),
  selected: sSel.sel === firstFrom && sSel.targets.length > 0,
  moved: sMoved.board[firstFrom] === '.' && sMoved.moves >= 1 && sMoved.mine === 12 && sMoved.theirs === 12,
  aiReplied: sReply.turn === 'w' && !sReply.over && sReply.moves >= 2 && sReply.mine === 12,
  captureAvailable: sCapPre.mandatory === true && sCapSel.targets.length === 1,
  captured: sCap.theirs === 1 && sCap.mine === 1 && sCap.board[42] === '.' && sCap.board[35] === 'w' && sCap.board[49] === '.',
  turnPassed: sCapAfter.turn === 'w' || sCapAfter.over,
  won: sWin.over === true && sWin.won === true && sWin.theirs === 0 && winSheet.open === true && /win/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && sLose.mine === 0 && loseSheet.open === true && /machine/i.test(loseSheet.title),
  restarted: sNew.over === false && sNew.mine === 12 && sNew.theirs === 12 && sNew.moves === 0 && sNew.turn === 'w',
  keyRestart: sR.over === false && sR.mine === 12 && sR.moves === 0,
  touchSelected: tSel.sel === tFrom && tSel.targets.length > 0,
  touchMoved: sTouch.moves >= 1 && sTouch.board[tFrom] === '.' && (sTouch.board[tTgt] !== 'b' || sTouch.moves >= 2),
  touchOnScreen: tPt && tTgtPt && tCorner && [tPt, tTgtPt, tCorner].every((p) => p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors,
};
console.log(JSON.stringify({
  checks, errors, cam0,
  s0: { mine: s0.mine, theirs: s0.theirs, legal: s0.legal },
  move: { from: firstFrom, to: tgt }, sMoved: { moves: sMoved.moves, turn: sMoved.turn },
  aiReplied: { turn: sReply.turn, moves: sReply.moves },
  cap: { mandatory: sCapPre.mandatory, targets: sCapSel.targets, after: { mine: sCap.mine, theirs: sCap.theirs } },
  capAfter: { turn: sCapAfter.turn, moves: sCapAfter.moves, over: sCapAfter.over },
  winSheet, sWin: { over: sWin.over, won: sWin.won },
  loseSheet, sLose: { over: sLose.over, mine: sLose.mine },
  sNew: { mine: sNew.mine, moves: sNew.moves }, sR: { mine: sR.mine, moves: sR.moves },
  touch: { from: tFrom, to: tTgt, moves: sTouch.moves },
  corners, shots: [shotBoot, shotMove, shotCap, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
