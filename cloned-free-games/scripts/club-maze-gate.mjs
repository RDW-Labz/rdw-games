#!/usr/bin/env node
// Interaction gate for the Club Maze port: real CDP mouse/keyboard/touch on the shipped page,
// state-hook assertions for slides, ring order, undo, win, cap-out, restart and portrait framing.
// usage: node club-maze-gate.mjs <dir-containing-games/arcade/club-maze>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/tmp/cmstage');
const FILE = 'games/arcade/club-maze/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// Slice the page's CORE block so the gate solves levels with the exact rules the browser runs.
const html = await readFile(join(ROOT, FILE), 'utf8');
const core = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!core) { console.log('NO CORE BLOCK'); process.exit(1); }
const rules = await import('data:text/javascript;base64,' + Buffer.from(
  core[1] + '\nexport { DIRS, LEVELS_CORE, slide, advance, par };').toString('base64'));
const { DIRS, LEVELS_CORE, slide, advance, par } = rules;

// BFS that records the direction sequence, so the gate can replay a solve through the page.
function solve(gridStr, start, targets) {
  const grid = gridStr.split('\n').map((r) => r.split(''));
  const key = (p, i) => p[0] + ',' + p[1] + ':' + i;
  const prev = new Map();
  const seen = new Set([key(start, 0)]);
  let frontier = [[start, 0]];
  while (frontier.length) {
    const next = [];
    for (const [pos, idx] of frontier) {
      if (idx === targets.length) {
        const path = [];
        let cur = key(pos, idx);
        while (prev.has(cur)) { const [pk, d] = prev.get(cur); path.unshift(d); cur = pk; }
        return path;
      }
      for (const d of Object.keys(DIRS)) {
        const np = slide(grid, pos, d);
        if (np[0] === pos[0] && np[1] === pos[1]) continue;
        const ni = advance(targets, idx, np);
        const k = key(np, ni);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, [key(pos, idx), d]);
        next.push([np, ni]);
      }
    }
    frontier = next;
  }
  return null;
}

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cm-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: PROFILE } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
});
T('devtools up');
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const server = await serve();
const port = server.address().port;
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
T('page loaded');

const errorsOf = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(300);
};
const ptOf = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Arrow', 'Arrow'), windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Arrow', 'Arrow'), windowsVirtualKeyCode: vk });
  await sleep(260);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 1) boot ----
const s0 = await ev('window.__clubmaze()');
const shotBoot = await shot('club-maze-gate-boot');
const lv0 = LEVELS_CORE[0];
const path0 = solve(lv0.grid, lv0.targets[0].length ? (() => { const rows = lv0.grid.split('\n'); for (let r = 0; r < 8; r++) { const c = rows[r].indexOf('S'); if (c >= 0) return [r, c]; } return [0, 0]; })() : [0, 0], lv0.targets);
T(`boot pos=${s0.pos} par=${s0.par} solve=${path0 && path0.length}`);

// ---- 2) a real click on the arrow pad slides the player ----
const firstDir = path0[0];
const padPt = await ptOf(`.pad button[data-dir="${firstDir}"]`);
await click(padPt);
const sClick = await ev('window.__clubmaze()');

// ---- 3) a keyboard arrow slides the player, and undo takes it back ----
const sBeforeKey = await ev('window.__clubmaze()');
await key('ArrowLeft', 37);
await key('ArrowRight', 39);
const sKeys = await ev('window.__clubmaze()');
const undoPt = await ptOf('#history');
await click(undoPt);
const sUndo = await ev('window.__clubmaze()');

// ---- 4) a real swipe slides the player (kit onDirection on document.body) ----
const swipeDir = path0[0] === 'up' ? 'down' : 'up';
const preSwipe = await ev('window.__clubmaze()');
await ev(`(()=>{
  const o = { bubbles: true, pointerType: 'touch', button: 0 };
  document.body.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 640, clientY: 400 }));
  document.body.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: ${swipeDir === 'left' ? 520 : swipeDir === 'right' ? 760 : 640}, clientY: ${swipeDir === 'up' ? 300 : swipeDir === 'down' ? 500 : 400} }));
  return true;
})()`);
await sleep(300);
const sSwipe = await ev('window.__clubmaze()');

// ---- 5) solve level 1 through the page's own move path, replaying the BFS directions ----
await ev('window.__clubmaze.loadLevel("' + lv0.grid.replace(/\n/g, '\\n') + '", ' + JSON.stringify(lv0.targets) + ', ' +
  JSON.stringify((() => { const rows = lv0.grid.split('\n'); for (let r = 0; r < 8; r++) { const c = rows[r].indexOf('S'); if (c >= 0) return [r, c]; } return [0, 0]; })()) + ', ' + lv0.par + ')');
await sleep(300);
const replay = [];
for (const d of path0) { replay.push(await ev(`window.__clubmaze.move(${JSON.stringify(d)})`)); await sleep(120); }
const sWin = await ev('window.__clubmaze()');
const winSheet = await sheet();
const shotWin = await shot('club-maze-gate-win');

// ---- 6) cap-out: burn the slack, then one more real slide ends the level ----
await ev('window.__clubmaze.loadLevel("' + lv0.grid.replace(/\n/g, '\\n') + '", ' + JSON.stringify(lv0.targets) + ', ' +
  JSON.stringify((() => { const rows = lv0.grid.split('\n'); for (let r = 0; r < 8; r++) { const c = rows[r].indexOf('S'); if (c >= 0) return [r, c]; } return [0, 0]; })()) + ', ' + lv0.par + ')');
await sleep(300);
await ev(`window.__clubmaze.setMoves(window.__clubmaze().cap)`);
const padPt2 = await ptOf(`.pad button[data-dir="${firstDir}"]`);
await click(padPt2);
await sleep(300);
const sCap = await ev('window.__clubmaze()');
const capSheet = await sheet();
const shotLose = await shot('club-maze-gate-cap');

// ---- 7) restart from the sheet, and R on the keyboard ----
const overBtn = await ptOf('#overBtn');
await click(overBtn);
await sleep(400);
const sNew = await ev('window.__clubmaze()');
await key('KeyR', 82);
await sleep(400);
const sR = await ev('window.__clubmaze()');

// ---- 8) portrait touch: tap the down arrow with a finger and watch the player move ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const tState = await ev('window.__clubmaze()');
const tPath = solve(lv0.grid, (() => { const rows = lv0.grid.split('\n'); for (let r = 0; r < 8; r++) { const c = rows[r].indexOf('S'); if (c >= 0) return [r, c]; } return [0, 0]; })(), lv0.targets);
const tDirBtn = await ptOf(`.pad button[data-dir="${tPath[0]}"]`);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(340);
};
await tap(tDirBtn);
const sTouch = await ev('window.__clubmaze()');
const tCorner = await ev(`window.__clubmaze.cellPoint(0,0)`);
const tFar = await ev(`window.__clubmaze.cellPoint(7,7)`);
const shotTouch = await shot('club-maze-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const checks = {
  boot: !!s0 && s0.level === 0 && s0.pos.join(',') === '6,4' && s0.moves === 0 && s0.ringsLeft === 1 && s0.par === 4 && s0.over === false,
  padClickSlides: differs(sClick.pos, s0.pos) && sClick.moves === 1 && sClick.inputs >= 1,
  keysSlide: sKeys.moves >= 2,
  undoRestores: sUndo.moves === sKeys.moves - 1,
  swipeSlides: sSwipe.moves >= 1 && differs(sSwipe.pos, preSwipe.pos),
  replaySolved: replay.every(Boolean) === true,
  won: sWin.over === true && sWin.won === true && sWin.ringsLeft === 0 && winSheet.open === true && /cleared/i.test(winSheet.title),
  capOut: sCap.over === true && sCap.won === false && sCap.moves > sCap.cap && capSheet.open === true && /out of slides/i.test(capSheet.title),
  restarted: sNew.over === false && sNew.moves === 0 && sNew.ringsLeft >= 1,
  keyRestart: sR.over === false && sR.moves === 0,
  touchSlides: differs(sTouch.pos, tState.pos) && sTouch.moves === 1,
  onScreen: inScreen(padPt, 1280, 800) && inScreen(await ev('window.__clubmaze.cellPoint(0,0)'), 1280, 800),
  touchOnScreen: inScreen(tDirBtn, 390, 844) && inScreen(tCorner, 390, 844) && inScreen(tFar, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { pos: s0.pos, par: s0.par, camera: s0.camera },
  path0,
  sClick: { pos: sClick.pos, moves: sClick.moves },
  sKeys: { pos: sKeys.pos, moves: sKeys.moves }, sUndo: { moves: sUndo.moves },
  sSwipe: { pos: sSwipe.pos, moves: sSwipe.moves, dups: sSwipe.dups },
  sWin: { moves: sWin.moves, ringsLeft: sWin.ringsLeft, over: sWin.over, won: sWin.won }, winSheet,
  sCap: { moves: sCap.moves, cap: sCap.cap, over: sCap.over, won: sCap.won }, capSheet,
  sNew: { moves: sNew.moves, ringsLeft: sNew.ringsLeft }, sR: { moves: sR.moves },
  sTouch: { pos: sTouch.pos, moves: sTouch.moves }, tState: { pos: tState.pos },
  tCorner, tFar,
  shots: [shotBoot, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
