#!/usr/bin/env node
// Interaction gate for the Bubble Shooter port: real CDP mouse clicks on the aiming plane, real
// touch taps in portrait, and state-hook assertions for stick / pop / kick-off drop / win sheet /
// danger-line loss / undo / restart / the double-dispatch guard. A canvas that merely exists is
// not proof. usage: node bubbleshooter-gate.mjs [dir-with-games/arcade]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/bubble-shooter/index.html';
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
const PROFILE = mkdtempSync('/tmp/bs-gate-');
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
// Drive the page target directly: browser-level Target.createTarget hangs on this headless build.
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const server = await serve();
const port = server.address().port;
const URL0 = `http://127.0.0.1:${port}/${FILE}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok   ' + msg);
  else { fails++; console.log('  FAIL ' + msg + (extra === undefined ? '' : ' — ' + JSON.stringify(extra))); }
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: URL0 });
await sleep(6000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const state = () => ev('window.__bubble()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// Fire a shot by clicking the screen point of a board coordinate (the page solves it on its plane).
const fireAt = async (gx, gy, wait = 1100) => {
  const p = await ev(`window.__bubble.point(${gx},${gy})`);
  if (!p || p.__err) return { p, err: p && p.__err };
  await click(p);
  await sleep(wait);
  return p;
};

// ---- 1) boot
console.log('1) boot');
const hookType = await ev('typeof window.__bubble');
const s0 = await state();
ok(hookType === 'function', 'the debug hook is a function (catalog gate probes typeof === function)', hookType);
ok(s0 && s0.bubbles === 34 && s0.shots === 0 && !s0.over, '34 bubbles dealt over four rows, no shots fired', s0 && { bubbles: s0.bubbles, shots: s0.shots });
ok(s0 && s0.counts.filter((n) => n >= 3).length >= 2, 'at least two colours have three or more bubbles', s0 && s0.counts);
const cam0 = await ev('window.__bubble.camera()');
const shotBoot = await shot('bubbleshooter-gate-boot');

// ---- 2) framing: every column of rows 3 and 10 is on screen and clear of the HUD bars
console.log('2) framing');
const framed = await ev(`(()=>{
  const out=[]; const H=innerHeight, W=innerWidth;
  for (const r of [0,3,6,10]) for (let c=0;c<9;c++){
    const p=window.__bubble.cellPoint(r,c);
    if(!p) { out.push([r,c,null]); continue; }
    if(p.x<2||p.x>W-2||p.y<70||p.y>H-64) out.push([r,c,Math.round(p.x),Math.round(p.y)]);
  }
  return out;
})()`);
ok(Array.isArray(framed) && framed.length === 0, 'every cell point sits inside the play area between the HUD bars', framed);

// ---- 3) a real click sticks a bubble and moves the counters
console.log('3) real shot');
const t3 = await fireAt(4.5, 6);
const s1 = await state();
ok(!t3.err, 'the aim point resolved to screen coordinates', t3);
ok(s1.shots === 1 && !s1.flying && s1.bubbles !== 34, 'one click fired one shot and changed the board (34 -> ' + s1.bubbles + ')', { shots: s1.shots, bubbles: s1.bubbles });
ok(s1.inputs === 1 && s1.dups === 0, 'the tap counted once, no duplicate', { inputs: s1.inputs, dups: s1.dups });
const s1b = await state();
const shotMid = await shot('bubbleshooter-gate-play');

// ---- 4) pop + kick: three of a colour pop, and a blob hanging off them drops
console.log('4) pop and kick');
await ev('window.__bubble.setup([[0,4,1],[0,5,1],[1,5,2],[2,6,2],[3,6,2]], 1)');
await sleep(250);
const sBefore = await state();
ok(sBefore.bubbles === 5, 'QA board loaded: a colour-1 pair with a colour-2 blob hanging off it', sBefore.bubbles);
await fireAt(4.3, 2);
const s2 = await state();
ok(s2.pops === 6 && s2.bubbles === 0, 'the shot popped the pair (3) and kicked the 3-bubble blob off (6 total, board empty)', { pops: s2.pops, bubbles: s2.bubbles });
const sh2 = await sheet();
ok(sh2.open && /Clear/i.test(sh2.title), 'the win sheet opened', sh2);
const shotWin = await shot('bubbleshooter-gate-win');

// ---- 5) restart from the sheet
console.log('5) restart');
await clickEl('overBtn');
await sleep(400);
const s3 = await state();
const sh3 = await sheet();
ok(s3.shots === 0 && s3.bubbles === 34 && !s3.over && !sh3.open, 'Play again deals a fresh board and closes the sheet', { shots: s3.shots, bubbles: s3.bubbles, open: sh3.open });

// ---- 6) danger line: a real shot that settles on the line ends the run
console.log('6) danger line');
await ev('window.__bubble.setup([[0,4,2],[1,4,3],[2,4,2],[3,4,3],[4,4,2],[5,4,3],[6,4,2],[7,4,3],[8,4,2],[9,4,3]], 2)');
await sleep(250);
const s4a = await state();
ok(s4a.lost === false, 'the QA board is not lost until a bubble settles', s4a.lost);
await fireAt(4.4, 5);
const s4 = await state();
const sh4 = await sheet();
ok(s4.lost === true && s4.over === true, 'settling on the danger row ends the run', { lost: s4.lost, highest: s4.highest });
ok(sh4.open && /low/i.test(sh4.title), 'the lose sheet opened (' + sh4.title + ')', sh4);

// ---- 7) undo from the lose sheet puts the board back
console.log('7) undo');
await clickEl('overBack');
await sleep(400);
const s5 = await state();
ok(s5.lost === false && s5.over === false && s5.bubbles === 10, 'Back up undoes the killing shot', { lost: s5.lost, bubbles: s5.bubbles });

// ---- 8) double-dispatch guard: two pointerups inside one tick fire one shot
console.log('8) double-tap guard');
await clickEl('new');
await sleep(500);
const before8 = await state();
const dup = await ev(`(()=>{
  const p = window.__bubble.point(4.0, 5.0);
  const mk = (t) => new PointerEvent(t, { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  const c = document.querySelector('canvas');
  c.dispatchEvent(mk('pointerdown')); window.dispatchEvent(mk('pointerup'));
  window.dispatchEvent(mk('pointerup'));
  return { x: p.x, y: p.y };
})()`);
await sleep(1200);
const s6 = await state();
ok(s6.shots === before8.shots + 1, 'two pointerups in one tick fired exactly one shot', { before: before8.shots, after: s6.shots });
ok(s6.dups >= 1, 'the duplicate was counted and dropped', s6.dups);

// ---- 9) undo button, then R restarts
console.log('9) undo and R');
await clickEl('undoBtn');
await sleep(400);
const s7 = await state();
ok(s7.shots === before8.shots, 'Undo took the shot back', { shots: s7.shots });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(700);
const s8 = await state();
ok(s8.shots === 0 && s8.bubbles === 34, 'R deals a new board', { shots: s8.shots, bubbles: s8.bubbles });

const errors1 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
ok(!errors1, 'no console errors on the desktop pass', errors1);

// ---- 10) portrait touch: 390x844, a finger tap fires a shot, the board stays framed
console.log('10) portrait touch');
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: URL0 });
await sleep(6000);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1100);
};
const tp = await ev('window.__bubble.point(4.2, 6.5)');
ok(tp && !tp.err, 'the portrait aim point resolved', tp);
await tap(tp);
const s9 = await state();
ok(s9.shots === 1 && s9.inputs === 1 && s9.bubbles !== 34, 'one finger tap fired one shot and changed the board', { shots: s9.shots, inputs: s9.inputs, bubbles: s9.bubbles });
const framed2 = await ev(`(()=>{
  const out=[]; const H=innerHeight, W=innerWidth;
  for (const r of [0,3,6,10]) for (let c=0;c<9;c++){
    const p=window.__bubble.cellPoint(r,c);
    if(!p) { out.push([r,c,null]); continue; }
    if(p.x<2||p.x>W-2||p.y<70||p.y>H-64) out.push([r,c,Math.round(p.x),Math.round(p.y)]);
  }
  return out;
})()`);
ok(Array.isArray(framed2) && framed2.length === 0, 'the whole board is still framed on a 390x844 phone', framed2);
const shotTouch = await shot('bubbleshooter-gate-touch');
const errors2 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text).slice(0, 3).join(' | ');
ok(!errors2, 'no exceptions on the portrait pass', errors2);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + [shotBoot, shotMid, shotWin, shotTouch].join(' '));
console.log(fails ? fails + ' FAILURE(S)' : 'OK: bubble shooter gate');
process.exit(fails ? 1 : 0);
