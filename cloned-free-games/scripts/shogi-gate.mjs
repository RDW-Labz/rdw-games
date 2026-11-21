#!/usr/bin/env node
// Interaction gate for the Shogi port: real CDP mouse + touch on the board, the move/promotion/
// drop paths, win and lose sheets, restart and undo, a portrait refit, console-error capture.
// Services the site repo root so the port's relative ./kit.js resolves to the shipped copy.
// usage: node scripts/shogi-gate.mjs [root] [file]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/shogi/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws open failed')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) {
        const { ok, bad, method } = c.p.get(msg.id);
        c.p.delete(msg.id);
        msg.error ? bad(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/shogi-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp' } });
let err = '';
const wsUrl = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => {
    err += d;
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); ok(m[1]); }
  });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
// Chromium 156 on this box never returns from browser-level Target.createTarget: read the page
// target off /json/list and attach to it directly (page-level CDP needs no sessionId).
const origin = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
let pageWs = null;
for (let i = 0; i < 40 && !pageWs; i++) {
  const list = await (await fetch(`${origin}/json/list`)).json().catch(() => []);
  const pg = list.find((t) => t.type === 'page');
  if (pg) pageWs = pg.webSocketDebuggerUrl;
  else await new Promise((r) => setTimeout(r, 250));
}
if (!pageWs) { console.error('no page target'); proc.kill('SIGKILL'); process.exit(2); }
const cdp = await CDP.attach(pageWs);
const server = await serve();
const port = server.address().port;
const URL0 = `http://127.0.0.1:${port}/${FILE}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error' };
  return r.result?.value;
};
const state = () => ev('window.__shogi ? window.__shogi() : null');

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: URL0 });
await sleep(7000);

const errorsOf = (from = 0) => cdp.events.slice(from)
  .filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text ||
    (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const cellPt = (r, c) => ev(`window.__shogi.tilePoint(${r},${c})`);
const clickCell = async (r, c) => { const p = await cellPt(r, c); await click(p); await sleep(260); return p; };
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(900); return b; };
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),
  title:document.getElementById('overTitle').textContent,
  promo:document.getElementById('promo').classList.contains('open')}))()`);
const until = async (fn, ms = 20000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};
const pos = (entries) => {
  const b = new Array(81).fill('.');
  for (const [r, c, p] of entries) b[r * 9 + c] = p;
  return b.join(' ');
};
const setup = async (board, hands, turn) => ev(`window.__shogi.setup(${JSON.stringify({ board, hands: hands || { b: {}, w: {} }, turn: turn || 'b' })})`);

// ---- 1) boot + picker inverse over every square
const s0 = await state();
const cam0 = await ev('window.__shogi.camera()');
const shotBoot = await shot('shogi-gate-boot');
const rect = await ev(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {w:r.width,h:r.height};})()`);
let inverseBad = [];
for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
  const p = await cellPt(r, c);
  const got = await ev(`window.__shogi.pickAt(${JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) })})`);
  if (got !== r * 9 + c) inverseBad.push([r, c, got]);
}
const outside = [];
for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
  const p = await cellPt(r, c);
  if (!p || p.x < 4 || p.x > 1276 || p.y < 4 || p.y > 796) outside.push([r, c, p]);
}

// ---- 2) real click: pawn forward, then the engine's reply
await clickCell(6, 4);
const sSel = await state();
await clickCell(5, 4);
const sMoved = await state();
const shotMove = await shot('shogi-gate-move');
const replied = await until(async () => { const s = await state(); return s && s.moves >= 2 && s.turn === 'b' && !s.thinking; }, 25000);
const sReply = await state();

// ---- 3) promotion: mandatory (pawn to the last rank) with no prompt
await setup(pos([[1, 4, 'bFU'], [0, 8, 'wOU'], [8, 0, 'bOU']]));
await sleep(400);
const pt14 = await cellPt(1, 4), pt04 = await cellPt(0, 4);
const el14 = await ev(`(()=>{const e=document.elementFromPoint(${Math.round(pt14.x)},${Math.round(pt14.y)});return e?e.tagName+'.'+e.className:'none';})()`);
const el04 = await ev(`(()=>{const e=document.elementFromPoint(${Math.round(pt04.x)},${Math.round(pt04.y)});return e?e.tagName+'.'+e.className:'none';})()`);
const hintTxt = await ev(`document.getElementById('hint').textContent`);
await clickCell(1, 4);
const sPromSel = await state();
await clickCell(0, 4);
const sProm = await state();
const promSheet = await sheet();

// ---- 4) promotion prompt: rook moving inside the zone asks, Promote applies
await setup(pos([[2, 8, 'bHI'], [0, 4, 'wOU'], [8, 0, 'bOU']]));
await sleep(400);
await clickCell(2, 8);
await clickCell(2, 7);
const sAsk = await state();
const askSheet = await sheet();
const shotPrompt = await shot('shogi-gate-prompt');
await clickEl('promoYes');
const sPromYes = await state();

// ---- 5) drop: chip → empty square, hand spends, piece lands
await setup(pos([[8, 4, 'bOU'], [0, 0, 'wOU'], [2, 2, 'bFU']]), { b: { KI: 2 }, w: {} });
await sleep(400);
const chip = await ev('window.__shogi.chipPoint("KI")');
if (chip) { await click(chip); await sleep(300); }
await clickCell(4, 4);
const sDrop = await state();
const shotDrop = await shot('shogi-gate-drop');

// ---- 6) win: mate in one, played with two real clicks
await setup(pos([[2, 4, 'bKI'], [2, 3, 'bGI'], [0, 4, 'wOU'], [8, 0, 'bOU']]));
await sleep(400);
await clickCell(2, 4);
await clickCell(1, 4);
await sleep(600);
const sWin = await state();
const winSheet = await sheet();
const shotWin = await shot('shogi-gate-win');

// ---- 7) lose: a mated sente position opens the lose sheet on load
await setup(pos([[0, 0, 'wHI'], [2, 3, 'wKI'], [2, 4, 'wKI'], [2, 5, 'wKI'], [0, 4, 'bOU'], [8, 4, 'wOU']]));
await sleep(700);
const sLose = await state();
const loseSheet = await sheet();
const shotLose = await shot('shogi-gate-lose');

// ---- 8) restart from the lose sheet's own button, then the R key
await clickEl('overBtn');
const sNew = await state();
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await state();

// ---- 9) undo returns the board and the turn to the player
const boardBefore = sR.board;
await clickCell(6, 2);            // bishop pawn
await clickCell(5, 2);
const sUndoPre = await state();
await clickEl('undo');
const sUndo = await state();

// ---- 10) portrait touch: every square still resolves, and a tap plays
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Page.navigate', { url: URL0 });
await sleep(7000);
const t0 = await state();
const tRect = await ev(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {w:r.width,h:r.height};})()`);
let tInverseBad = [];
for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
  const p = await cellPt(r, c);
  const got = await ev(`window.__shogi.pickAt(${JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) })})`);
  if (got !== r * 9 + c || !p || p.y < 2 || p.y > 842) tInverseBad.push([r, c, got, p && Math.round(p.y)]);
}
const tap = async (p) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
await tap(await cellPt(6, 4));
const tSel = await state();
await tap(await cellPt(5, 4));
await sleep(400);
const tMoved = await state();
const shotTouch = await shot('shogi-gate-touch');
const errors = errorsOf();

const checks = {
  boot: !!s0 && s0.turn === 'b' && s0.legal === 30 && s0.counts.b === 20 && s0.counts.w === 20 && s0.over === false && !s0.thinking,
  hookIsFunction: await ev('typeof window.__shogi') === 'function',
  pickerInverse: inverseBad.length === 0,
  allOnScreen: outside.length === 0,
  selected: sSel && sSel.sel === 58 && sSel.myMoves.some((m) => m[0] === 58 && m[1] === 49),
  moved: sMoved && sMoved.moves >= 1 && sMoved.board.split(' ')[58] === '.' && sMoved.board.split(' ')[49] === 'bFU',
  aiReplied: replied && sReply.moves >= 2 && sReply.turn === 'b',
  promoted: sProm && sProm.board.split(' ')[4] === 'bTO' && promSheet.open === false && sProm.moves >= 1,
  promoteAsked: sAsk && sAsk.prompt && askSheet.promo === true,
  promoteYes: sPromYes && sPromYes.board.split(' ')[25] === 'bRY',
  dropped: sDrop && sDrop.board.split(' ')[40] === 'bKI' && (sDrop.hand.b.KI === 1) && sDrop.moves >= 1,
  won: sWin && sWin.over === true && sWin.won === true && winSheet.open === true && /win/i.test(winSheet.title),
  lost: sLose && sLose.over === true && sLose.won === false && loseSheet.open === true && /mated/i.test(loseSheet.title),
  restarted: sNew && sNew.over === false && sNew.moves === 0 && sNew.counts.b === 20 && sNew.counts.w === 20 && sNew.turn === 'b',
  keyRestart: sR && sR.moves === 0 && sR.board === boardBefore,
  undone: sUndo && sUndo.moves === 0 && sUndo.board === boardBefore && sUndo.turn === 'b',
  undoPlayed: sUndoPre && sUndoPre.moves >= 1,
  portraitInverse: tInverseBad.length === 0,
  portraitPicked: tSel && tSel.sel === 58 && tSel.myMoves.length > 0,
  touchMoved: tMoved && tMoved.moves >= 1 && tMoved.board.split(' ')[58] === '.',
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, cam0, rect, tRect,
  s0: { turn: s0.turn, legal: s0.legal, counts: s0.counts },
  move: { sel: sSel.sel, moved: sMoved.moves, replyMoves: sReply.moves, turn: sReply.turn },
  promote: { piece: sProm.board.split(' ')[4], prompt: !!(sAsk && sAsk.prompt), yes: sPromYes.board.split(' ')[25] },
  drop: { piece: sDrop.board.split(' ')[40], hand: sDrop.hand.b, moves: sDrop.moves },
  win: { title: winSheet.title, over: sWin.over, won: sWin.won },
  lose: { title: loseSheet.title, over: sLose.over, won: sLose.won },
  undo: { pre: sUndoPre.moves, after: sUndo.moves, turn: sUndo.turn },
  inverseBad: inverseBad.slice(0, 6), outside: outside.slice(0, 6), tInverseBad: tInverseBad.slice(0, 6),
  dbg: { pt14, pt04, el14, el04, hintTxt, sel: sPromSel && sPromSel.sel, my: sPromSel && sPromSel.myMoves,
    moves: sProm && sProm.moves, turn: sProm && sProm.turn, sq04: sProm && sProm.board.split(' ')[4], sq13: sProm && sProm.board.split(' ')[13] },
  shots: { shotBoot, shotMove, shotPrompt, shotDrop, shotWin, shotLose, shotTouch },
}, null, 1));
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) console.log('\nFAILED: ' + failed.join(', '));
else console.log('\nSHOGI GATE: all passed');
proc.kill('SIGKILL');
server.close();
process.exit(failed.length ? 1 : 0);
