#!/usr/bin/env node
// Interaction gate for the Naija-Ludo port: real CDP mouse + touch on the shipped page, with
// state-hook assertions for the two-dice rules — exit on a 6, walk by a die, the sum play, the
// split play, a capture by sum, a star square refusing a capture, doubles earning a re-roll, a
// dead roll passing the turn, a rival seat playing itself, winning + the end sheet, restart,
// framing in both orientations, a pixel readback, and a portrait touch pass.
//
// usage: node naija-ludo-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/naija-ludo/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const CMD_TIMEOUT = 180000;

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/ludo-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion,PaintHolding',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' }, detached: true });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 120000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageCdp = await CDP.attach(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
// kill the whole process GROUP: SIGKILL on the parent orphans its renderer/zygote children, and 252
// of those were found leaked on this box
const cleanup = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } try { server.close(); } catch {} };
process.on('unhandledRejection', (e) => { console.error('unhandled', e); cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });

const click = async (pt) => {
  if (!pt) return false;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
  return true;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled};})()`);
  if (!b) return null;
  await click(b);
  await sleep(400);
  return b;
};
const st = () => ev('window.__ludo()');
const poll = async (fn, ms = 8000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const consoleErrors = () => pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
// click the visible gold dot whose spend matches pred; recomputes the list first
const clickSpend = async (pred) => {
  const list = await ev('window.__ludo.spendList()');
  if (!Array.isArray(list)) return { err: list, list: [] };
  const k = list.findIndex(pred);
  if (k < 0) return { err: 'no match', list };
  const pt = await ev(`window.__ludo.spendPoint(${k})`);
  await click(pt);
  return { k, pt, list };
};
const setup = (o) => ev('window.__ludo.setup(' + JSON.stringify(o) + ')');

// ---- 1) boot
const boot0 = Date.now();
const hookType = await poll(async () => { const t = await ev('typeof window.__ludo'); return t === 'function' ? t : null; }, 120000, 500);
const bootMs = Date.now() - boot0;
const b0 = await st();
const diag0 = await ev('window.__ludo.diag()');
const pxCentre = await ev('window.__ludo.gl(0.5,0.5)');
const shotBoot = await shot('ludo-gate-boot');

const frameOf = async (w, h) => {
  const pts = await ev('window.__ludo.allPoints()');
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const off = pts.filter((p) => p.x < 4 || p.x > w - 4 || p.y < 4 || p.y > h - 4).length;
  return { bbox, inside: off === 0, off, cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, w, h, n: pts.length };
};
const frameL = await frameOf(1280, 800);

// ---- 2) a 6 and a 3: bring a token out, then walk it 3
await setup({ tok: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, phase: 'roll' });
await ev('window.__ludo.forceDie(6, 3)');
const rollBtnState = await ev('(()=>{const b=document.getElementById("roll");return {disabled:b.disabled};})()');
await clickEl('roll');
const afterRoll = await st();
const exitPlay = await clickSpend((x) => x.i === 0 && x.to === 0);
const afterExit = await poll(async () => { const s = await st(); return s && s.tok[0][0] === 0 ? s : null; }, 6000, 120);
const walkPlay = await clickSpend((x) => x.i === 0 && x.to === 3);
const afterWalk = await poll(async () => { const s = await st(); return s && s.tok[0][0] === 3 ? s : null; }, 8000, 150);
T('exit+walk ' + JSON.stringify({ rollBtnDisabled: rollBtnState && rollBtnState.disabled, dice: afterRoll && afterRoll.dice, legal: afterRoll && afterRoll.legal,
  afterExit: afterExit && { tok0: afterExit.tok[0], used: afterExit.used, turn: afterExit.turn, legal: afterExit.legal },
  afterWalk: afterWalk && { tok0: afterWalk.tok[0], used: afterWalk.used, turn: afterWalk.turn, moves: afterWalk.moves, phase: afterWalk.phase } }));

// ---- 3) the sum play: one token at 10 walks 2+3 = 5
await setup({ tok: [[10, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, dice: [2, 3], phase: 'move' });
const sumPre = await ev('window.__ludo.spendList()');
const sumPlay = await clickSpend((x) => x.sum && x.to === 15);
const afterSum = await poll(async () => { const s = await st(); return s && s.tok[0][0] === 15 ? s : null; }, 6000, 120);
T('sum ' + JSON.stringify({ spends: sumPre && sumPre.map((x) => [x.i, x.to, x.dice, x.sum]), play: sumPlay.k,
  after: afterSum && { tok0: afterSum.tok[0], used: afterSum.used, turn: afterSum.turn, moves: afterSum.moves } }));

// ---- 4) the split: two tokens at 5 and 20 take one die each
await setup({ tok: [[5, 20, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, dice: [2, 3], phase: 'move' });
const splitPre = await ev('window.__ludo.spendList()');
await clickSpend((x) => x.i === 0 && x.dice.join() === '0');
const afterSplit1 = await poll(async () => { const s = await st(); return s && s.tok[0][0] === 7 ? s : null; }, 6000, 120);
const leftDice = await ev('window.__ludo.spendList()');
await clickSpend((x) => x.i === 1 && x.to === 23);
const afterSplit2 = await poll(async () => { const s = await st(); return s && s.tok[0][1] === 23 ? s : null; }, 6000, 120);
T('split ' + JSON.stringify({ pre: splitPre && splitPre.length, after1: afterSplit1 && afterSplit1.tok[0],
  left: leftDice && leftDice.map((x) => [x.i, x.to]), after2: afterSplit2 && { tok0: afterSplit2.tok[0], turn: afterSplit2.turn, moves: afterSplit2.moves } }));

// ---- 5) a capture by sum: seat 0 at 4 + (2+3) lands on ring 30 where a gold token stands
await setup({ tok: [[4, -1, -1, -1], [48, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, dice: [2, 3], phase: 'move' });
const capPre = await st();
await clickSpend((x) => x.sum && x.to === 9);
const capPost = await poll(async () => { const s = await st(); return s && s.captures > 0 ? s : null; }, 6000, 120);
T('capture ' + JSON.stringify({ pre: capPre.tok, post: capPost && { tok: capPost.tok, captures: capPost.captures, turn: capPost.turn, phase: capPost.phase, bonus: capPost.bonus } }));

// ---- 6) the same landing on a star square is a stand-off: seat 0 at 3 + (3+2) lands on ring 29
await setup({ tok: [[3, -1, -1, -1], [47, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, dice: [3, 2], phase: 'move' });
await clickSpend((x) => x.sum && x.to === 8);
await sleep(600);
const starPost = await st();
T('star ' + JSON.stringify({ tok0: starPost.tok[0], tok1: starPost.tok[1], captures: starPost.captures }));

// ---- 7) doubles: a 4+4 rolls a bonus, and both dice still have to be spent
await setup({ tok: [[10, 20, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, phase: 'roll' });
await ev('window.__ludo.forceDie(4, 4)');
await clickEl('roll');
const dblRoll = await st();
const dblPlays = await ev('window.__ludo.spendList()');
await clickSpend((x) => x.i === 0 && x.to === 14);
await sleep(400);
await clickSpend(() => true);
const dblPost = await poll(async () => { const s = await st(); return s && s.moves >= 2 ? s : null; }, 8000, 150);
T('doubles ' + JSON.stringify({ dice: dblRoll && dblRoll.dice, bonus: dblRoll && dblRoll.bonus, doubles: dblRoll && dblRoll.doubles,
  plays: dblPlays && dblPlays.map((x) => [x.i, x.to, x.sum]), post: dblPost && { tok0: dblPost.tok[0], turn: dblPost.turn, phase: dblPost.phase, moves: dblPost.moves } }));

// ---- 8) a dead roll passes the turn on its own
await setup({ tok: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, phase: 'roll' });
await ev('window.__ludo.forceDie(2, 3)');
await clickEl('roll');
const deadRoll = await st();
const passed = await poll(async () => { const s = await st(); return s && s.turn !== 0 ? s : null; }, 12000, 150);
T('pass ' + JSON.stringify({ dice: deadRoll && deadRoll.dice, legal: deadRoll && deadRoll.legal, turn: passed && passed.turn, rolls: passed && passed.rolls }));

// ---- 9) a rival seat plays by itself
await setup({ tok: [[-1, -1, -1, -1], [0, 0, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 1, phase: 'roll' });
const aiPre = await st();
const aiPost = await poll(async () => {
  const s = await st();
  if (!s) return null;
  return JSON.stringify(s.tok[1]) !== JSON.stringify(aiPre.tok[1]) || s.moves > aiPre.moves ? s : null;
}, 25000, 250);
T('ai ' + JSON.stringify({ pre: aiPre.tok[1], post: aiPost && aiPost.tok[1], moves: aiPost && aiPost.moves }));

// ---- 10) the winning roll, the end sheet, restart
await setup({ tok: [[56, 56, 56, 55], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, phase: 'roll' });
await ev('window.__ludo.forceDie(1, 4)');
await clickEl('roll');
const winRoll = await st();
await clickSpend((x) => x.to === 56);
const winState = await poll(async () => { const s = await st(); return s && s.phase === 'over' ? s : null; }, 8000, 120);
await sleep(500);
const winSheet = await st();
const shotWin = await shot('ludo-gate-win');
await clickEl('overBtn');
await sleep(700);
const restarted = await st();
T('win ' + JSON.stringify({ dice: winRoll && winRoll.dice, phase: winState && winState.phase, winner: winState && winState.winner,
  home: winState && winState.home, sheet: winSheet && winSheet.sheet, title: winSheet && winSheet.title, shot: shotWin,
  restart: restarted && { phase: restarted.phase, yard: restarted.yard, sheet: restarted.sheet } }));

// ---- 11) a rich mid-game board: the tile-art shot and a live-draw proof
await setup({ tok: [[3, 8, 52, 56], [12, 20, -1, 56], [5, -1, -1, -1], [30, 33, 54, -1]], turn: 0, dice: [2, 5], phase: 'move' });
await sleep(1200);
const artState = await st();
const diagArt = await ev('window.__ludo.diag()');
const pxArt = await ev('window.__ludo.gl(0.5,0.52)');
const artSpends = await ev('window.__ludo.spendList()');
const shotArt = await shot('naija-ludo');
const errors1 = consoleErrors();

// ---- 12) portrait + touch: a finger rolls a 6 and taps the exit dot
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await poll(async () => (await ev('typeof window.__ludo')) === 'function' ? 1 : null, 120000, 400);
const touchTap = async (p) => {
  if (!p) return;
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 9, radiusY: 9, force: 1 }] });
  await sleep(80);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(340);
};
const p0 = await st();
const frameP = await frameOf(390, 844);
await setup({ tok: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]], turn: 0, phase: 'roll' });
await ev('window.__ludo.forceDie(6, 5)');
const pRollBtn = await ev('(()=>{const b=document.getElementById("roll");const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
await touchTap(pRollBtn);
const pRolled = await st();
const pDot = await ev('window.__ludo.spendPoint(0)');
await touchTap(pDot);
const pMoved = await poll(async () => { const s = await st(); return s && s.tok[0][0] === 0 ? s : null; }, 8000, 150);
await setup({ tok: [[3, 8, 52, 56], [12, 20, -1, 56], [5, -1, -1, -1], [30, 33, 54, -1]], turn: 0, dice: [2, 5], phase: 'move' });
await sleep(800);
const shotTouch = await shot('ludo-gate-touch');
T('touch ' + JSON.stringify({ dice: pRolled && pRolled.dice, pDot, moved: pMoved && pMoved.tok[0], inputs: pMoved && pMoved.inputs, frameP, shot: shotTouch }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const bright = (px) => Array.isArray(px) && px.slice(0, 3).some((v, i) => Math.abs(v - [11, 14, 20][i]) > 8);
const checks = {
  bootHook: hookType === 'function',
  bootOpening: !!b0 && b0.turn === 0 && b0.phase === 'roll' && b0.dice.join() === '0,0' && b0.tok.flat().every((q) => q === -1) && b0.home.every((h) => h === 0),
  boardShape: !!b0 && b0.cells === 52 && JSON.stringify(b0.starters) === '[21,34,47,8]',
  drewSomething: !!diag0 && diag0.frames > 0 && diag0.children < 400,
  boardPixel: bright(pxCentre),
  landscapeFramed: frameL.inside && near(frameL.cx, 640, 77) && Math.abs(frameL.cy - 400) < 90,
  rollButtonLive: !!rollBtnState && rollBtnState.disabled === false,
  rollsTwoDice: !!afterRoll && afterRoll.dice.join() === '6,3' && afterRoll.phase === 'move' && afterRoll.legal === 4,
  exitsOnSix: !!afterExit && afterExit.tok[0][0] === 0 && afterExit.used.join() === 'true,false' && afterExit.turn === 0 && afterExit.legal === 1,
  walksByDie: !!afterWalk && afterWalk.tok[0][0] === 3 && afterWalk.turn === 1 && afterWalk.moves === 2 && afterWalk.phase === 'roll',
  sumOffered: !!sumPre && sumPre.length === 3 && sumPre.some((x) => x.sum && x.to === 15),
  sumMovesBoth: !!afterSum && afterSum.tok[0][0] === 15 && afterSum.moves === 1,
  splitTwoTokens: !!afterSplit2 && afterSplit2.tok[0][0] === 7 && afterSplit2.tok[0][1] === 23 && afterSplit2.moves === 2 && afterSplit2.turn === 1,
  splitLeftOneDie: !!leftDice && leftDice.length === 2 && leftDice.every((x) => x.dice.join() === '1'),
  captureWorks: !!capPost && capPost.captures === 1 && capPost.tok[0][0] === 9 && capPost.tok[1][0] === -1,
  captureEarnsRoll: !!capPost && capPost.turn === 0 && capPost.phase === 'roll',
  starRefusesCapture: !!starPost && starPost.tok[0][0] === 8 && starPost.tok[1][0] === 47 && starPost.captures === 0,
  doublesCounted: !!dblRoll && dblRoll.dice.join() === '4,4' && dblRoll.bonus === true && dblRoll.doubles === 1,
  doublesKeepSeat: !!dblPost && dblPost.turn === 0 && dblPost.phase === 'roll' && dblPost.moves >= 2,
  deadRollPasses: !!deadRoll && deadRoll.legal === 0 && !!passed && passed.turn !== 0,
  rivalPlays: !!aiPost && JSON.stringify(aiPost.tok[1]) !== JSON.stringify(aiPre.tok[1]),
  exactRollWins: !!winState && winState.phase === 'over' && winState.winner === 0 && winState.home[0] === 4,
  sheetSaysWin: !!winSheet && winSheet.sheet === true && /you win/i.test(winSheet.title),
  restartWorks: !!restarted && restarted.phase === 'roll' && restarted.home.every((h) => h === 0) && restarted.yard.every((y) => y === 4) && restarted.sheet === false,
  artBoardLive: !!artState && artState.home[0] === 1 && artState.home[1] === 1 && artState.phase === 'move' && Array.isArray(artSpends) && artSpends.length >= 4,
  artPixels: bright(pxArt),
  portraitFramed: frameP.inside && near(frameP.cx, 195, 24) && Math.abs(frameP.cy - 422) < 100,
  touchRolls: !!pRolled && pRolled.dice.join() === '6,5' && pRolled.phase === 'move',
  touchMoves: !!pMoved && pMoved.tok[0][0] === 0 && pMoved.moves >= 1,
  noErrors: !errors1 && !errors2,
  sameHookInFrame: !!p0 && typeof p0 === 'object',
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
const report = {
  checks, failed, errors1, errors2, bootMs,
  b0: b0 && { turn: b0.turn, phase: b0.phase, dice: b0.dice, cells: b0.cells, starters: b0.starters },
  diag: diag0, px: pxCentre, frameL, frameP,
  exitWalk: { dice: afterRoll && afterRoll.dice, legal: afterRoll && afterRoll.legal, afterExit: afterExit && { tok0: afterExit.tok[0], used: afterExit.used, legal: afterExit.legal }, afterWalk: afterWalk && { tok0: afterWalk.tok[0], turn: afterWalk.turn } },
  sum: { spends: sumPre && sumPre.map((x) => [x.i, x.to, x.dice]), after: afterSum && { tok0: afterSum.tok[0], moves: afterSum.moves } },
  split: { pre: splitPre && splitPre.length, left: leftDice && leftDice.map((x) => [x.i, x.to]), after: afterSplit2 && { tok0: afterSplit2.tok[0], turn: afterSplit2.turn } },
  capture: capPost && { tok: capPost.tok, captures: capPost.captures, turn: capPost.turn, phase: capPost.phase },
  star: { tok0: starPost.tok[0], tok1: starPost.tok[1], captures: starPost.captures },
  doubles: { dice: dblRoll && dblRoll.dice, bonus: dblRoll && dblRoll.bonus, plays: dblPlays && dblPlays.length, post: dblPost && { tok0: dblPost.tok[0], turn: dblPost.turn, phase: dblPost.phase } },
  win: winState && { phase: winState.phase, winner: winState.winner, title: winSheet && winSheet.title },
  restart: restarted && { phase: restarted.phase, yard: restarted.yard, sheet: restarted.sheet },
  art: { spends: artSpends && artSpends.length, diag: diagArt },
  touch: { dice: pRolled && pRolled.dice, tok0: pMoved && pMoved.tok[0] },
  shots: { boot: shotBoot, win: shotWin, art: shotArt, touch: shotTouch },
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'naija-ludo-gate.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ failed, checks, bootMs, shots: report.shots }, null, 1));
cleanup();
process.exit(failed.length ? 1 : 0);
