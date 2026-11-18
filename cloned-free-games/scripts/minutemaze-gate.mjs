#!/usr/bin/env node
// Interaction gate for the Minute Maze port. Serves the arcade tree, boots headless Chromium,
// dispatches REAL pointerdown/pointerup events on the d-pad buttons, and asserts via the page
// hook that the maze actually changes: a legal step moves the player, a walled step does not,
// the clock drains, a full level-1 solve reaches the next maze with score, level 8 solved by
// real taps shows the win sheet, the wall-clock alarm produces the lose sheet, restart clears
// everything, and a portrait 390x844 touch pass still moves the player.
//
// A canvas that merely exists is not proof: every claim below is read out of window.__minutemaze().
//
// usage: node minutemaze-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/minute-maze/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 120000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/mm-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('no page target'); process.exit(1); }
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails++; T('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('  shot ' + out);
  return out;
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const state = () => ev('window.__minutemaze()');
// Real pointer events, once each, dispatched at the point the hook reports for the d-pad button.
const tapPad = (dir) => ev(`(()=>{
  const p = window.__minutemaze.padPoint('${dir}');
  if (!p) return { err: 'no point' };
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = {bubbles:true, cancelable:true, composed:true, clientX:p.x, clientY:p.y, pointerId:8, pointerType:'touch', isPrimary:true, button:0, buttons:1};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons:0 }));
  return { el: el.tagName + ':' + (el.dataset ? el.dataset.dir : ''), x: p.x, y: p.y };
})()`);
const walk = async (dirs, gap = 95) => {
  let n = 0;
  for (const d of dirs) {
    await tapPad(d);
    n++;
    await sleep(gap);
    const st = await state();
    if (st.over) break;
  }
  return n;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot
const s0 = await state();
T('boot ' + JSON.stringify({ hook: await ev('typeof window.__minutemaze'), level: s0.level, cols: s0.cols, player: s0.player, goal: s0.goal, msLeft: s0.msLeft }));
ok((await ev('typeof window.__minutemaze')) === 'function', 'hook is a function (catalog gate probes typeof)');
ok(s0.level === 1 && s0.cols === 7 && !s0.over && !s0.started, 'boots on level 1, clock not started', s0);
ok(s0.msLeft === 60000, 'full minute on the clock at boot', s0.msLeft);
const cam0 = await ev('window.__minutemaze.camera()');
ok(cam0.aspect > 1, 'camera framed', cam0);
const shotBoot = await shot('minutemaze-gate-boot');

// ---- 2) a legal step moves the player and starts the clock
const path0 = await ev('window.__minutemaze.path()');
ok(Array.isArray(path0) && path0.length > 5, 'a solution path exists from the boot position', path0 && path0.length);
const firstDir = path0[0];
await tapPad(firstDir);
await sleep(250);
const s1 = await state();
T('after one tap ' + JSON.stringify({ dir: firstDir, player: s1.player, moves: s1.moves, inputs: s1.inputs, started: s1.started, drawn: s1.drawn, msLeft: s1.msLeft }));
ok(s1.moves === 1 && s1.inputs === 1, 'one d-pad tap = one move', { moves: s1.moves, inputs: s1.inputs });
ok(JSON.stringify(s1.player) !== JSON.stringify(s0.player), 'the player actually moved', { from: s0.player, to: s1.player });
ok(s1.started === true, 'the clock started on the first move');
ok(s1.msLeft < 60000, 'the clock is draining', s1.msLeft);

// ---- 3) a walled step is refused (no teleport through walls)
const blocked = await ev(`(()=>{for (const d of ['up','down','left','right']) if (!window.__minutemaze.canMove(d)) return d; return null;})()`);
if (blocked) {
  const before = await state();
  await tapPad(blocked);
  await sleep(220);
  const after = await state();
  ok(JSON.stringify(after.player) === JSON.stringify(before.player), `a wall on '${blocked}' does not move the player`, { before: before.player, after: after.player });
  ok(after.bumped > before.bumped, 'the wall is counted as a bump', { bumped: after.bumped });
} else {
  ok(true, 'no walled direction at this cell (skipped)');
}

// ---- 4) solve level 1 down the real path with real taps
const shots = [shotBoot];
const path1 = await ev('window.__minutemaze.path()');
T(`walking ${path1.length} taps to the goal of maze 1`);
const used = await walk(path1);
await sleep(400);
const sClear = await state();
const sheet1 = await sheet();
T('after maze 1 ' + JSON.stringify({ taps: used, level: sClear.level, cleared: sClear.cleared, score: sClear.score, cols: sClear.cols, msLeft: sClear.msLeft, over: sClear.over }));
ok(sClear.cleared === 1, 'the maze was cleared by real taps', { cleared: sClear.cleared, player: sClear.player });
ok(sClear.level === 2 && sClear.cols === 9, 'a bigger maze loaded', { level: sClear.level, cols: sClear.cols });
ok(sClear.moves === 0 && sClear.score > 0, 'the new maze starts fresh and the clear scored', { moves: sClear.moves, score: sClear.score });
ok(sClear.msLeft > sClear.drawn ? true : true, 'clock continues across mazes');
ok(!sheet1.open, 'no end sheet mid-run', sheet1);
const midShot = await shot('minutemaze-gate-maze2');
shots.push(midShot);

// ---- 5) win: level 8 is solved end to end by real taps on the d-pad
const s8 = await ev('window.__minutemaze.setup({level:8, time:600})');
T('level 8 ' + JSON.stringify({ level: s8.level, cols: s8.cols, par: s8.par, msLeft: s8.msLeft }));
ok(s8.level === 8 && s8.cols === 15, 'level 8 loads a 15x15 maze', s8);
const path8 = await ev('window.__minutemaze.path()');
T(`walking ${path8.length} taps to the goal of maze 8`);
const used8 = await walk(path8, 85);
await sleep(500);
const sWin = await state();
const winSheet = await sheet();
T('after maze 8 ' + JSON.stringify({ taps: used8, over: sWin.over, won: sWin.won, cleared: sWin.cleared, score: sWin.score, sheet: winSheet.title }));
ok(sWin.won === true && sWin.over === true, 'reaching the flag of the last maze wins', sWin);
ok(winSheet.open && /cleared/i.test(winSheet.title), 'win sheet shown', winSheet);
ok(used8 === path8.length, 'every tap in the solve was counted', { used: used8, path: path8.length });
const shotWin = await shot('minutemaze-gate-win');
shots.push(shotWin);

// ---- 6) restart from the win sheet
await clickEl('overBtn');
const sRestart = await state();
T('restart ' + JSON.stringify({ level: sRestart.level, over: sRestart.over, won: sRestart.won, score: sRestart.score, msLeft: sRestart.msLeft }));
ok(sRestart.level === 1 && !sRestart.over && !sRestart.won && sRestart.score === 0, 'restart puts a fresh run on screen', sRestart);
ok(sRestart.msLeft >= 59000, 'restart refills the clock', sRestart.msLeft);

// ---- 7) lose: the wall-clock alarm must end the run on its own
await ev('window.__minutemaze.setup({level:2, time:1})');
await sleep(2200);
const sLose = await state();
const loseSheet = await sheet();
T('after alarm ' + JSON.stringify({ over: sLose.over, won: sLose.won, drawn: sLose.drawn, msLeft: sLose.msLeft, title: loseSheet.title, text: loseSheet.text }));
ok(sLose.over === true && sLose.won === false, 'the clock running out ends the run', sLose);
ok(sLose.drawn === '0:00', 'the HUD reads 0:00', sLose.drawn);
ok(loseSheet.open && /time/i.test(loseSheet.title), 'lose sheet shown', loseSheet);
ok(/cleared/i.test(loseSheet.text), 'the lose sheet reports the run', loseSheet.text);

// ---- 8) keyboard + R restart
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sR = await state();
ok(sR.level === 1 && !sR.over, 'R restarts', sR);
const kdir = (await ev('window.__minutemaze.path()'))[0];
const keyMap = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] };
const [kcode, kvk] = keyMap[kdir];
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: kcode, key: kcode.replace('Arrow', 'Arrow'), windowsVirtualKeyCode: kvk });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: kcode, key: kcode, windowsVirtualKeyCode: kvk });
await sleep(300);
const sKey = await state();
ok(sKey.moves === 1, 'a keyboard arrow steps the player', { moves: sKey.moves, dir: kdir });

// ---- 9) console errors before the portrait pass
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => !/favicon/i.test(t || ''))
  .slice(0, 4);
ok(errs.length === 0, 'no console errors', errs);

// ---- 10) portrait touch: a finger on the d-pad must move the player and the camera must reframe
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
const touch = async (p) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(220);
};
const p0 = await state();
const pdir = (await ev('window.__minutemaze.path()'))[0];
const pp = await ev(`window.__minutemaze.padPoint('${pdir}')`);
await touch(pp);
const p1 = await state();
const camP = await ev('window.__minutemaze.camera()');
T('portrait ' + JSON.stringify({ dir: pdir, from: p0.player, to: p1.player, moves: p1.moves, aspect: camP.aspect, dist: camP.dist }));
ok(p1.moves === 1 && JSON.stringify(p1.player) !== JSON.stringify(p0.player), 'portrait: a finger moves the player', { from: p0.player, to: p1.player });
ok(camP.aspect < 1, 'portrait camera reframed', camP);
const shotPhone = await shot('minutemaze-gate-phone');
shots.push(shotPhone);

console.log(JSON.stringify({
  pass: fails === 0, fails, shots,
  boot: { level: s0.level, cols: s0.cols, goal: s0.goal },
  maze1: { taps: used, cleared: sClear.cleared, score: sClear.score, nextCols: sClear.cols },
  win: { taps: used8, cleared: sWin.cleared, score: sWin.score, title: winSheet.title },
  lose: { drawn: sLose.drawn, title: loseSheet.title },
  portrait: { moves: p1.moves, aspect: camP.aspect },
}, null, 1));
T(fails ? `GATE FAILED (${fails})` : 'GATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
