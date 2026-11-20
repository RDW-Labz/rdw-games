#!/usr/bin/env node
// Interaction gate for The Squirrel's Maze 2D port: real CDP mouse/keyboard/touch on the shipped page,
// state-hook assertions for steps, acorn pickup, undo, a full BFS solve to the nest, the step-cap loss,
// sheet restart, and portrait framing.
// usage: node squirrel-gate.mjs <dir-containing-games/arcade/the-squirrel-s-maze-2d>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/the-squirrel-s-maze-2d/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const html = await readFile(join(ROOT, FILE), 'utf8');
const core = html.match(/\/\/ >>>CORE([\s\S]*?)\/\/ <<<CORE/);
if (!core) { console.log('NO CORE BLOCK'); process.exit(1); }
const rules = await import('data:text/javascript;base64,' + Buffer.from(
  core[1] + '\nexport { DIRS, isOpen, deal, stepTo };').toString('base64'));
const { DIRS, isOpen, deal, stepTo } = rules;

// BFS over (pos, acorn mask) that records the direction sequence, so the gate replays an exact solve.
function solvePath(d) {
  const K = d.acorns.length, all = (1 << K) - 1;
  const idxAt = new Map(d.acorns.map((p, i) => [p[0] + ',' + p[1], i]));
  const key = (r, c, mask) => r + ',' + c + ':' + mask;
  const prev = new Map();
  const startKey = key(d.start[0], d.start[1], 0);
  const seen = new Set([startKey]);
  let frontier = [[d.start[0], d.start[1], 0]];
  while (frontier.length) {
    const next = [];
    for (const [r, c, mask] of frontier) {
      if (mask === all && r === d.exit[0] && c === d.exit[1]) {
        const path = [];
        let cur = key(r, c, mask);
        while (prev.has(cur)) { const [pk, dir] = prev.get(cur); path.unshift(dir); cur = pk; }
        return path;
      }
      for (const k of Object.keys(DIRS)) {
        const nr = r + DIRS[k][0], nc = c + DIRS[k][1];
        if (!isOpen(d, nr, nc)) continue;
        let nm = mask;
        const ai = idxAt.get(nr + ',' + nc);
        if (ai !== undefined) nm |= (1 << ai);
        const kk = key(nr, nc, nm);
        if (seen.has(kk)) continue;
        seen.add(kk);
        prev.set(kk, [key(r, c, mask), k]);
        next.push([nr, nc, nm]);
      }
    }
    frontier = next;
  }
  return null;
}

const firstLegal = (d) => Object.keys(DIRS).find((k) => isOpen(d, d.start[0] + DIRS[k][0], d.start[1] + DIRS[k][1]));

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
const PROFILE = mkdtempSync('/tmp/sq-gate-');
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
  await sleep(320);
};
const ptOf = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const key = async (code, vk) => {
  const keyName = code.startsWith('Arrow') ? code : code.replace('Key', '');
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk });
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

const KEYMAP = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] };

// ---- 1) boot ----
const s0 = await ev('window.__squirrelmaze()');
const shotBoot = await shot('squirrel-gate-boot');
const d0 = deal(0, 0);
const path0 = solvePath(d0);
T(`boot level=${s0.level} pos=${s0.pos} acorns=${s0.acornsLeft} opt=${s0.optimal} path=${path0 && path0.length}`);

// ---- 2) a real click on the arrow pad steps the squirrel ----
const dir0 = path0[0];
await click(await ptOf(`.pad button[data-dir="${dir0}"]`));
const sClick = await ev('window.__squirrelmaze()');

// ---- 3) two keyboard steps walk it on, and undo takes one back ----
const stepA = path0[1], stepB = path0[2];
await key(...KEYMAP[stepA]);
await key(...KEYMAP[stepB]);
const sKeys = await ev('window.__squirrelmaze()');
await click(await ptOf('#undo'));
const sUndo = await ev('window.__squirrelmaze()');

// ---- 4) a real swipe (kit onDirection on document.body) steps it ----
const swipeDir = dir0 === 'up' ? 'down' : 'up';
const preSwipe = await ev('window.__squirrelmaze()');
await ev(`(()=>{
  const o = { bubbles: true, pointerType: 'touch', button: 0 };
  document.body.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 640, clientY: 400 }));
  document.body.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: ${swipeDir === 'left' ? 520 : swipeDir === 'right' ? 760 : 640}, clientY: ${swipeDir === 'up' ? 300 : swipeDir === 'down' ? 500 : 400} }));
  return true;
})()`);
await sleep(320);
const sSwipe = await ev('window.__squirrelmaze()');

// ---- 5) solve the level through the page's own move path (BFS directions from the shipped rules) ----
await ev('window.__squirrelmaze.qa(0, 0)');
await sleep(300);
const replay = [];
for (const d of path0) { replay.push(await ev(`window.__squirrelmaze.move(${JSON.stringify(d)})`)); }
const sWin = await ev('window.__squirrelmaze()');
const winSheet = await sheet();
const shotWin = await shot('squirrel-gate-win');

// ---- 6) the step cap: burn it down, then one real pad click ends the run ----
await ev('window.__squirrelmaze.qa(0, 0)');
await sleep(300);
await ev('window.__squirrelmaze.setSteps(window.__squirrelmaze().cap)');
const legLose = firstLegal(d0);
await click(await ptOf(`.pad button[data-dir="${legLose}"]`));
await sleep(300);
const sCap = await ev('window.__squirrelmaze()');
const capSheet = await sheet();
const shotLose = await shot('squirrel-gate-cap');

// ---- 7) the sheet's own buttons restart honestly ----
await click(await ptOf('#overBtn'));
await sleep(400);
const sNew = await ev('window.__squirrelmaze()');
await key('KeyR', 82);
await sleep(400);
const sR = await ev('window.__squirrelmaze()');
await click(await ptOf('#newmaze'));
await sleep(400);
const sFresh = await ev('window.__squirrelmaze()');

// ---- 8) portrait touch: a finger on the pad steps the squirrel ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const tState = await ev('window.__squirrelmaze()');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(340);
};
await tap(await ptOf(`.pad button[data-dir="${dir0}"]`));
const sTouch = await ev('window.__squirrelmaze()');
const tStart = await ev(`window.__squirrelmaze.cellPoint(1,1)`);
const tExit = await ev(`window.__squirrelmaze.cellPoint(${d0.exit[0]},${d0.exit[1]})`);
const dCorner = await ev('window.__squirrelmaze()');
const tCorner = await ev(`window.__squirrelmaze.cellPoint(${dCorner.size - 1},${dCorner.size - 1})`);
const shotTouch = await shot('squirrel-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const checks = {
  boot: !!s0 && s0.level === 0 && s0.steps === 0 && s0.pos.join(',') === '1,1' && s0.acornsLeft === 2 && s0.startGrid === '.',
  padClickSteps: differs(sClick.pos, s0.pos) && sClick.steps === 1 && sClick.inputs >= 1,
  keysStep: sKeys.steps >= 3,
  undoSteps: sUndo.steps === sKeys.steps - 1,
  swipeSteps: sSwipe.steps >= 1 && differs(sSwipe.pos, preSwipe.pos),
  replaySolved: replay.every(Boolean) === true && replay.length > 0,
  won: sWin.over === true && sWin.won === true && sWin.acornsLeft === 0 && winSheet.open === true && /nest/i.test(winSheet.title),
  lost: sCap.over === true && sCap.won === false && sCap.steps > sCap.cap && capSheet.open === true && /lost/i.test(capSheet.title),
  sheetRestarts: sNew.over === false && sNew.steps === 0 && sNew.acornsLeft >= 1,
  keyRestart: sR.over === false && sR.steps === 0,
  newMazeDiffers: sFresh.dealNo > sNew.dealNo && sFresh.steps === 0 && sFresh.over === false,
  touchSteps: differs(sTouch.pos, tState.pos) && sTouch.steps === 1,
  desktopOnScreen: inScreen(await ev(`window.__squirrelmaze.cellPoint(1,1)`), 1280, 800),
  touchOnScreen: inScreen(tStart, 390, 844) && inScreen(tExit, 390, 844) && inScreen(tCorner, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { level: s0.level, pos: s0.pos, acorns: s0.acorns, exit: s0.exit, optimal: s0.optimal, cap: s0.cap, camera: s0.camera },
  path0Length: path0.length,
  sClick: { pos: sClick.pos, steps: sClick.steps, acornsLeft: sClick.acornsLeft },
  sKeys: { pos: sKeys.pos, steps: sKeys.steps }, sUndo: { steps: sUndo.steps },
  sSwipe: { pos: sSwipe.pos, steps: sSwipe.steps, dups: sSwipe.dups },
  sWin: { steps: sWin.steps, acornsLeft: sWin.acornsLeft, over: sWin.over, won: sWin.won }, winSheet,
  sCap: { steps: sCap.steps, cap: sCap.cap, over: sCap.over, won: sCap.won }, capSheet,
  sNew: { level: sNew.level, steps: sNew.steps, over: sNew.over }, sR: { steps: sR.steps },
  sFresh: { level: sFresh.level, dealNo: sFresh.dealNo, steps: sFresh.steps },
  sTouch: { pos: sTouch.pos, steps: sTouch.steps }, tState: { pos: tState.pos },
  tStart, tExit, tCorner,
  shots: [shotBoot, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
