#!/usr/bin/env node
// Interaction gate for the Open Chaos Chess port: real CDP mouse/touch input on the 3D
// board, state-hook assertions for the random move, the AI reply, undo, a forced last
// capture (win) and a forced wipe (lose). Screenshots for every checkpoint.
// usage: node occ-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage-occ');
const FILE = 'games/arcade/open-chaos-chess.html';
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
const PROFILE = mkdtempSync('/tmp/occ-gate-');
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
const tapSquare = async (r, c) => {
  const p = await ev(`window.__occ.tilePoint(${r},${c})`);
  await click(p);
  await sleep(120);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(360);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

const START = 'rnbqkbnr' + 'pppppppp' + '.'.repeat(32) + 'PPPPPPPP' + 'RNBQKBNR';
const KNIGHTS = 'nnnnnnnn' + '.'.repeat(48) + 'NNNNNNNN';

// ---- 1) boot
const s0 = await ev('window.__occ()');
const b0 = await ev('window.__occ.board()');
const corners = {};
for (const [k, r, c] of [['a8', 0, 0], ['h8', 0, 7], ['a1', 7, 0], ['h1', 7, 7]]) corners[k] = await ev(`window.__occ.tilePoint(${r},${c})`);
const shotBoot = await shot('occ-gate-boot');

// ---- 2) tap a pawn: it shows its destinations, then the RNG commits one
await tapSquare(6, 4);            // e2
const sSel = await ev('window.__occ()');
await sleep(1400);                // pending resolves at ~460 ms, then the AI replies
const sMoved = await ev('window.__occ()');
const bMoved = await ev('window.__occ.board()');
const shotMove = await shot('occ-gate-move');
await sleep(2200);
const sReply = await ev('window.__occ()');

// ---- 3) tapping the opponent's piece must not select it
await tapSquare(1, 4);            // e7 (coral)
const sEnemy = await ev('window.__occ()');

// ---- 4) undo brings back the player's turn and the start position
await clickEl('undo');
const sUndo = await ev('window.__occ()');
const bUndo = await ev('window.__occ.board()');

// ---- 5) forced last capture -> win sheet. b7 pawn has exactly one legal move: xa8.
await ev(`window.__occ.setup('bN6/1P6/8/8/8/8/8/8 w')`);
await sleep(400);
const sWinBefore = await ev('window.__occ()');
const winMoves = await ev('window.__occ.movesFrom(9)');   // b7 = r1,c1 -> 9
await tapSquare(1, 1);
await sleep(1500);
const sWin = await ev('window.__occ()');
const winSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shotWin = await shot('occ-gate-win');

// ---- 6) forced wipe -> lose sheet. Black bishop a8 has one move: xb7, white's last piece.
await ev(`window.__occ.setup('b7/1K6/8/8/8/8/8/8 b')`);
await sleep(2200);                // the opponent plays on its own timer
const sLose = await ev('window.__occ()');
const loseSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 7) restart from the sheet, then the Mode button cycles to knights-only
await clickEl('overBtn');
await sleep(600);
const sNew = await ev('window.__occ()');
const bNew = await ev('window.__occ.board()');
await clickEl('mode');            // bloodthirst keeps the standard board
const sBlood = await ev('window.__occ()');
await clickEl('mode');            // knights
const sKnights = await ev('window.__occ()');
const bKnights = await ev('window.__occ.board()');
const shotKnights = await shot('occ-gate-knights');
// knights-only really plays: tap a knight and let the RNG move it
await tapSquare(7, 1);
await sleep(1800);
const sKnightMoved = await ev('window.__occ()');
const bKnightMoved = await ev('window.__occ.board()');

// ---- 8) a third Mode click wraps back to normal, then R restarts the position
const sKnightMoved2 = await ev('window.__occ()');
await clickEl('mode');
const sWrap = await ev('window.__occ()');
const bWrap = await ev('window.__occ.board()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await ev('window.__occ()');
const bR = await ev('window.__occ.board()');
const shotEnd = await shot('occ-gate-end');

// ---- 9) portrait phone: a real finger tap must move a piece
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tCorner = await ev('window.__occ.tilePoint(0,7)');
const tPawn = await ev('window.__occ.tilePoint(6,4)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
await tap(tPawn);
const tSel = await ev('window.__occ()');
const tSelOK = tSel && (tSel.pending === true || tSel.selected === 56 || tSel.ply >= 1);
await sleep(3000);
const sTouch = await ev('window.__occ()');
const bTouch = await ev('window.__occ.board()');
const shotTouch = await shot('occ-gate-touch');
const errors2 = errorsOf(cdp.events);

const checks = {
  boot: s0 && s0.mine === 16 && s0.theirs === 16 && s0.meshes === 32 && s0.turn === 'w' && s0.over === false && b0 === START,
  onScreen: Object.values(corners).every((p) => p && p.x > 8 && p.x < 1272 && p.y > 8 && p.y < 792),
  selected: sSel.selected === 52 && sSel.pending === true,
  moved: sMoved.ply >= 1 && sMoved.mine === 16 && sMoved.theirs === 16 && sMoved.selected === -1 && bMoved !== START && bMoved !== b0,
  replied: sReply.ply >= 2 && sReply.turn === 'w' && sReply.ai === false,
  enemyRejected: sEnemy.selected === -1,
  undone: sUndo.ply === 0 && bUndo === START && sUndo.over === false,
  winSetup: sWinBefore.mine === 2 && sWinBefore.theirs === 1 && Array.isArray(winMoves) && winMoves.length === 1 && winMoves[0] === 0,
  won: sWin.over === true && sWin.result === 'win' && sWin.theirs === 0 && winSheet.open === true && /win/i.test(winSheet.title),
  lost: sLose.over === true && sLose.result === 'lose' && sLose.mine === 0 && loseSheet.open === true && /wipe|out/i.test(loseSheet.title),
  restarted: sNew.ply === 0 && sNew.over === false && bNew === START,
  bloodthirst: sBlood.mode === 'bloodthirst' && sBlood.mine === 16,
  knightsBoard: sKnights.mode === 'knights' && sKnights.mine === 8 && sKnights.theirs === 8 && sKnights.meshes === 16 && bKnights === KNIGHTS,
  knightsMoved: sKnightMoved.ply >= 1 && bKnightMoved !== KNIGHTS && sKnightMoved.mode === 'knights',
  modeWrap: sWrap.mode === 'normal' && bWrap === START && sWrap.ply === 0,
  keyRestart: sR.ply === 0 && bR === START && sR.over === false,
  touchMoved: sTouch.ply >= 1 && bTouch !== START && tSelOK,
  touchOnScreen: tCorner && tPawn && [tCorner, tPawn].every((p) => p.x > 2 && p.x < 388 && p.y > 2 && p.y < 842),
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors, errors2,
  s0, sSel: { selected: sSel.selected, pending: sSel.pending },
  sMoved: { ply: sMoved.ply, turn: sMoved.turn, mine: sMoved.mine, theirs: sMoved.theirs, last: sMoved.last },
  sReply: { ply: sReply.ply, turn: sReply.turn },
  sUndo: { ply: sUndo.ply }, sWin: { over: sWin.over, result: sWin.result, theirs: sWin.theirs }, winSheet,
  sLose: { over: sLose.over, result: sLose.result, mine: sLose.mine }, loseSheet,
  sKnights: { mode: sKnights.mode, mine: sKnights.mine, meshes: sKnights.meshes },
  sKnightMoved: { ply: sKnightMoved.ply }, sR: { ply: sR.ply, mode: sR.mode },
  sTouch: { ply: sTouch.ply, mine: sTouch.mine },
  bMoved, bKnights, bTouch,
  shots: [shotBoot, shotMove, shotWin, shotKnights, shotEnd, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
