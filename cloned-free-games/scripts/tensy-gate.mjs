#!/usr/bin/env node
// Interaction gate for the Tensy port. Real CDP input only: taps select path cells, a full ten
// clears them, a real drag clears a path in one gesture, the win sheet and the no-tens loss sheet
// are reached from QA positions, and a 390x844 portrait touch pass proves the board fits the HUD.
// usage: node tensy-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/tensy/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/tensy-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const until = async (fn, ms = 10000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4500);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const drag = async (pts) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[0].x, y: pts[0].y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts[0].x, y: pts[0].y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  for (const p of pts.slice(1)) {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(30);
  }
  const last = pts[pts.length - 1];
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const pointOf = (i) => ev(`window.__tensy.tilePoint(${i})`);
const clickCell = async (i, wait = 220) => { const p = await pointOf(i); if (!p || p.__err) return { err: p && p.__err }; await click(p); await sleep(wait); return p; };
const clickEl = async (id, wait = 400) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b); await sleep(wait); return b;
};
const state = () => ev('window.__tensy()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__tensy');
const rules = await ev('window.__tensy.rules()');
const s0 = await state();
T('boot ' + JSON.stringify({ hookType, rules, hasPath: s0 && s0.hasPath, cleared: s0 && s0.cleared }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(rules && rules.N === 6 && rules.SUM === 10 && rules.targets.length === 3, 'the rules are 6x6, clear exactly ten, three targets', rules);
ok(s0 && s0.board.length === 36 && s0.board.every((v) => v > 0 && v <= 9), 'boots a full 6x6 board of 1..9', s0 && s0.board.filter((v) => !v || v > 9));
ok(s0 && s0.hasPath === true && !s0.over, 'the opening board always offers a legal move', s0 && { hasPath: s0.hasPath, over: s0.over });
const shotBoot = await shot('tensy-gate-boot');

// ---------- 2) tapping builds a path ----------
let path = await ev('window.__tensy.nextPath()');
ok(path && path.length >= 2, 'the live board reports a winning path', path);
const before2 = await state();
await clickCell(path[0], 240);
const mid = await state();
T('select ' + JSON.stringify({ p0: path[0], sel: mid.sel, sum: mid.sum, inputs: mid.inputs }));
ok(mid.sel && mid.sel.length === 1 && mid.sel[0] === path[0] && mid.sum === before2.board[path[0]], 'a real tap selects the first cell and shows its value', { sel: mid.sel, sum: mid.sum });
await clickCell(path[1], 340);
const afterTap = await state();
T('complete ' + JSON.stringify({ sel: afterTap.sel, sum: afterTap.sum, cleared: afterTap.cleared, moves: afterTap.moves, sum0: before2.sum }));
ok(afterTap.moves === before2.moves + 1 && afterTap.cleared === before2.cleared + path.length, 'tapping a ten clears the path and scores it', { moves: afterTap.moves, cleared: afterTap.cleared });
ok(afterTap.sum === 0 && afterTap.sel.length === 0, 'the selection resets after the clear', { sum: afterTap.sum, sel: afterTap.sel });
ok(JSON.stringify(afterTap.board) !== JSON.stringify(before2.board), 'the board changed after the clear', null);
const shotPlay = await shot('tensy-gate-play');

// ---------- 3) a real drag clears a path ----------
path = await ev('window.__tensy.nextPath()');
const beforeD = await state();
const pts = [];
for (const c of path) pts.push(await pointOf(c));
ok(pts.every((p) => p && !p.__err), 'every cell of the drag path has a screen point', pts);
await drag(pts);
await sleep(400);
const afterDrag = await state();
T('drag ' + JSON.stringify({ len: path.length, cleared: afterDrag.cleared, moves: afterDrag.moves, dups: afterDrag.dups }));
ok(afterDrag.cleared >= beforeD.cleared + path.length, 'one real drag gesture clears the whole path', { before: beforeD.cleared, after: afterDrag.cleared, len: path.length });

// ---------- 4) win sheet from a QA position ----------
const winCells = new Array(36).fill(9);
winCells[14] = 4; winCells[15] = 6;      // 14 and 15 touch horizontally
const setupWin = await ev('window.__tensy.setup(' + JSON.stringify(winCells) + ', {cleared: 18, target: 20})');
T('setupWin ' + JSON.stringify({ hasPath: setupWin && setupWin.hasPath, cleared: setupWin && setupWin.cleared, over: setupWin && setupWin.over }));
ok(setupWin && setupWin.hasPath === true && !setupWin.over, 'a QA board with one ten is live', setupWin && { hasPath: setupWin.hasPath, over: setupWin.over });
await clickCell(14, 250);
await clickCell(15, 400);
const winState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 6000);
const winSheet = await sheet();
T('win ' + JSON.stringify({ result: winState && winState.result, cleared: winState && winState.cleared, sheet: winSheet }));
ok(winState && winState.over && winState.result === 'win', 'clearing past the target opens the win state', winState && { result: winState.result, cleared: winState.cleared });
ok(winSheet && winSheet.open && /level clear|every target hit/i.test(winSheet.title), 'the win sheet carries its own title', winSheet);
const shotWin = await shot('tensy-gate-win');

// ---------- 5) loss sheet: a board with no ten ----------
const deadCells = new Array(36).fill(9);
const deadSetup = await ev('window.__tensy.setup(' + JSON.stringify(deadCells) + ', {cleared: 4, target: 20})');
const deadState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 5000);
const deadSheet = await sheet();
T('lose ' + JSON.stringify({ hasPath: deadSetup && deadSetup.hasPath, result: deadState && deadState.result, sheet: deadSheet }));
ok(deadSetup && deadSetup.hasPath === false, 'a board of nines has no legal path', deadSetup && deadSetup.hasPath);
ok(deadState && deadState.over && deadState.result === 'lose', 'a dead board ends the level as a loss', deadState && { result: deadState.result });
ok(deadSheet && deadSheet.open && /no tens left/i.test(deadSheet.title), 'the loss sheet carries its own title', deadSheet);
const shotLose = await shot('tensy-gate-lose');

// ---------- 6) sheet buttons and the bottom bar ----------
// The sheet covers the bottom bar, so its own button is clicked while it is open.
await clickEl('overBtn');
const sRestart = await state();
T('restart-from-sheet ' + JSON.stringify({ over: sRestart && sRestart.over, cleared: sRestart && sRestart.cleared, hasPath: sRestart && sRestart.hasPath }));
ok(sRestart && !sRestart.over && sRestart.cleared === 0 && sRestart.hasPath, 'the sheet button re-deals a live board', sRestart && { over: sRestart.over, cleared: sRestart.cleared });
const lvlBefore = sRestart.level;
await clickEl('new');
const sNew = await state();
T('new ' + JSON.stringify({ before: lvlBefore, level: sNew && sNew.level, target: sNew && sNew.target }));
ok(sNew && sNew.level === (lvlBefore + 1) % 3 && sNew.cleared === 0, 'New board moves to the next target', { before: lvlBefore, after: sNew && sNew.level });
await clickEl('restart');
ok((await state()).cleared === 0, 'Restart clears the score on the same level', null);
// Back up is tested on a fresh dead board, since it must close the sheet without restarting.
await ev('window.__tensy.setup(' + JSON.stringify(new Array(36).fill(9)) + ', {cleared: 4, target: 20})');
await sleep(300);
await clickEl('overBack');
const backSheet = await sheet();
const backState = await state();
T('backup ' + JSON.stringify({ open: backSheet.open, over: backState && backState.over }));
ok(backSheet && !backSheet.open && backState && backState.over, 'Back up closes the sheet without touching the finished game', { sheet: backSheet, over: backState && backState.over });
// a finished game ignores board taps, so re-deal before the tap checks below
await clickEl('restart');
const liveAgain = await state();
ok(liveAgain && !liveAgain.over && liveAgain.hasPath, 'Restart from the bottom bar brings the board back to life', liveAgain && { over: liveAgain.over, hasPath: liveAgain.hasPath });

// ---------- 7) double-tap guard ----------
const stDup = await state();
const dupIdx = stDup.board.findIndex((v) => v > 0 && v < 10);
const beforeDup = await state();
const dupPoint = await pointOf(dupIdx);
await ev(`(()=>{const p=${JSON.stringify(dupPoint)};
  const c=document.querySelector('canvas');
  const mk=(t)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,pointerId:7,pointerType:'touch',isPrimary:true});
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  return true;})()`);
await sleep(350);
const afterDup = await state();
T('dup ' + JSON.stringify({ before: beforeDup.inputs, after: afterDup.inputs, dups: afterDup.dups }));
ok(afterDup.dups >= 1 && afterDup.inputs === beforeDup.inputs + 1, 'a same-point double tap counts once', { before: beforeDup.inputs, after: afterDup.inputs, dups: afterDup.dups });

// ---------- 8) portrait ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(1200);
const geom = await ev('window.__tensy.band()');
const inside = geom.points.filter((p) => p && p.x > 2 && p.x < 388 && p.y > geom.topPx && p.y < geom.botPx).length;
T('portrait ' + JSON.stringify({ topPx: geom.topPx, botPx: geom.botPx, inside, of: geom.points.length }));
ok(inside === 36, 'all 36 tiles project inside the band the hud leaves on a 390x844 phone', { inside, of: geom.points.length });
// every tile point must resolve back to its own cell through the live picker
const roundTrip = await ev(`(()=>{const bad=[];for(let i=0;i<36;i++){const p=window.__tensy.tilePoint(i);const j=window.__tensy.cellAt(p.x,p.y);if(j!==i)bad.push([i,j]);}return bad;})()`);
T('picker round-trip mismatches ' + JSON.stringify(roundTrip));
ok(Array.isArray(roundTrip) && roundTrip.length === 0, 'each tile point picks its own cell on a portrait screen', roundTrip);
const tapIdx = (await state()).board.findIndex((v) => v > 0);
// Headless Chromium swallows the first mouse event after a metrics override, so prime the input
// with a neutral press on the brand bar, then tap the tile (and retry once — a real finger repeats).
await click({ x: 12, y: 12 });
await sleep(150);
let ptP = await clickCell(tapIdx, 400);
let sPortrait = await until(async () => { const s = await state(); return s && s.sel.length ? s : null; }, 2500);
if (!sPortrait) { ptP = await clickCell(tapIdx, 400); sPortrait = await until(async () => { const s = await state(); return s && s.sel.length ? s : null; }, 2500); }
const sPortraitRaw = await state();
T('portrait tap ' + JSON.stringify({ idx: tapIdx, pt: ptP, sel: sPortraitRaw.sel, taps: sPortraitRaw.taps, dups: sPortraitRaw.dups, over: sPortraitRaw.over }));
ok(sPortrait !== null, 'a touch on the portrait board selects a cell', { ptP, sel: sPortrait && sPortrait.sel });
const shotPortrait = await shot('tensy-gate-portrait');

// ---------- 9) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 220));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the run', errText);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + [shotBoot, shotPlay, shotWin, shotLose, shotPortrait].join(' '));
if (fails.length) { console.error(`\nTENSY GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('TENSY GATE PASS');
