#!/usr/bin/env node
// Interaction gate for the Tile Match port: real CDP mouse/touch input on the 3D pile, plus
// state-hook assertions for covered-tile rejection, tray grouping, the double-dispatch guard,
// a full solution playthrough to the win sheet, the bar-full loss from a QA position, undo,
// restart, hint and a 390x844 touch pass. A canvas that merely exists is not proof.
// usage: node tilematch-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/tile-match/index.html';
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
const PROFILE = mkdtempSync('/tmp/tm-gate-');
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
await sleep(7000);

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
const tapTile = async (i, ms = 90) => {
  const p = await ev(`window.__tilematch.aim(${i})`);
  await click(p);
  await sleep(ms);
  return p;
};
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(350); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const st = async () => ev('window.__tilematch()');

const hookType = await ev('typeof window.__tilematch');
if (hookType !== 'function') {
  console.log('GATE FAIL — hook missing (' + hookType + '): ' + errorsOf());
  proc.kill('SIGKILL'); server.close(); process.exit(1);
}

// ---- 1) boot: a real 78-tile pile with a choice of free tiles
const s0 = await st();
const cam0 = await ev('window.__tilematch.camera()');
const slots = await ev('window.__tilematch.slots()');
const shotBoot = await shot('tilematch-boot');

// every free tile's aim point must resolve back to that tile
const aimCheck = await ev(`(()=>{const h=window.__tilematch,f=h.freeList();let bad=[];for(const i of f){const p=h.aim(i);if(h.pickAt(p.x,p.y)!==i)bad.push(i);}return {n:f.length,bad};})()`);

// ---- 2) a covered tile is not tappable
const coveredIx = await ev(`(()=>{const h=window.__tilematch();const f=new Set(window.__tilematch.freeList());for(let i=0;i<h.lives.length;i++)if(h.lives[i]&&!f.has(i))return i;return -1;})()`);
const pCov = await tapTile(coveredIx);
const sCov = await st();

// ---- 3) one honest tap takes a free tile into the bar
const freeIx = await ev('window.__tilematch.freeList()[0]');
const pOne = await tapTile(freeIx);
const sOne = await st();

// ---- 4) the same point fired twice inside ~70 ms is one tap. Dispatch both pointerups in one
// page-side tick: two awaited CDP round-trips land apart and read as two honest taps.
const before = (await st()).inputs;
const dupJson = await ev(`(()=>{const h=window.__tilematch,i=h.freeList()[0],p=h.aim(i);
  const el=document.elementFromPoint(p.x,p.y)||document.body;
  const mk=(t)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,pointerId:1,isPrimary:true,pointerType:'mouse'});
  el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('pointerup')); el.dispatchEvent(mk('pointerup'));
  return h();})()`);
await sleep(150);
const sDup = await st();
const dupDropped = sDup.dups >= 1 && (sDup.inputs - before) === 1;

// ---- 5) hint marks a free tile
await clickEl('hintBtn');
const hintIx = await ev('window.__tilematch.hintIx()');
const hintFree = await ev(`(()=>{const h=window.__tilematch();const i=window.__tilematch.hintIx();if(i<0)return false;return window.__tilematch.freeList().includes(i)&&h.lives[i]===1;})()`);

// ---- 6) win: restart and play the deal's own peel order to an empty pile
await clickEl('new');
const sRestart = await st();
const order = await ev('window.__tilematch.solution()');
let steps = 0, peak = 0, wrong = 0, clearedSeen = 0, lastScore = 0;
let shotMid = null;
for (const i of order) {
  const live = await ev(`window.__tilematch().lives[${i}]`);
  if (!live) { wrong++; continue; }
  await tapTile(i, 0);
  steps++;
  const s = await st();
  if (s.trayLen > peak) peak = s.trayLen;
  if (s.score > lastScore) { clearedSeen++; lastScore = s.score; }
  if (steps === 14) shotMid = await shot('tilematch-mid');
  if (s.over) break;
}
const sWin = await st();
const winSheet = await sheet();
const shotWin = await shot('tilematch-win');

// ---- 7) lose: a QA position with six different kinds in the bar, one free tile of a seventh
// kind to fill it, and a second free tile so the tap cannot empty the board (a clear wins).
const topIx = slots.findIndex((s) => s[2] === 2);
const topIx2 = slots.findIndex((s, n) => s[2] === 2 && n > topIx);
const setupExpr = 'window.__tilematch.setup(' + JSON.stringify([[topIx, 6], [topIx2, 0]]) + ',' + JSON.stringify([0, 1, 2, 3, 4, 5]) + ')';
const setupRes = await ev(setupExpr);
const sLoseSetup = await st();
const pLose = await tapTile(topIx);
const sLose = await st();
const loseSheet = await sheet();

// ---- 8) Back up from the lose sheet returns the tile to the pile
await clickEl('overBack');
const sUndo = await st();

// ---- 9) restart again
await clickEl('new');
const sNew = await st();

// ---- 10) 390x844 touch pass
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const camTouch = await ev('window.__tilematch.camera()');
const tFree = await ev('window.__tilematch.freeList()[0]');
const tA = await ev(`window.__tilematch.aim(${tFree})`);
const touchTap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
};
await touchTap(tA);
const sTouch = await st();
const dupBeforeTouch = sDup.dups;
const shotTouch = await shot('tilematch-touch');
const touchAim = await ev(`(()=>{const h=window.__tilematch,f=h.freeList();let bad=0;for(const i of f){const p=h.aim(i);if(h.pickAt(p.x,p.y)!==i)bad++;}return {n:f.length,bad};})()`);

const errors = errorsOf();
const onScreen = (p, w, h) => p && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;

const checks = {
  bootTiles: s0 && s0.tiles === 78 && s0.over === false,
  bootChoice: s0 && s0.free >= 10,
  bootOnScreen: onScreen(pOne, 1280, 800),
  aimsResolve: aimCheck && aimCheck.bad.length === 0 && aimCheck.n >= 10,
  coveredRejected: coveredIx >= 0 && sCov && sCov.tiles === 78 && sCov.blocked >= 1 && sCov.inputs === 0 && sCov.taps === 1,
  tookTile: sOne && sOne.tiles === 77 && sOne.trayLen === 1 && sOne.inputs === 1,
  dupDropped,
  hintWorks: hintFree === true && hintIx >= 0,
  restarted: sRestart && sRestart.tiles === 78 && sRestart.over === false && sRestart.trayLen === 0,
  playedOut: sWin && sWin.tiles === 0 && steps === 78 && wrong === 0,
  trayNeverFull: peak <= 6,
  triplesCleared: clearedSeen === 26 && sWin.score === 26,
  won: sWin && sWin.over === true && sWin.won === true && winSheet.open === true && /cleared/i.test(winSheet.title),
  loseReached: sLoseSetup && sLoseSetup.trayLen === 6 && sLoseSetup.tiles === 2 && sLose && sLose.trayLen === 7 &&
    sLose.lost === true && loseSheet.open === true && /bar full/i.test(loseSheet.title),
  undoFromLose: sUndo && sUndo.over === false && sUndo.trayLen === 6 && sUndo.tiles === 2,
  newBoard: sNew && sNew.tiles === 78 && sNew.over === false,
  touchTook: sTouch && sTouch.tiles === 77 && sTouch.dups === dupBeforeTouch,
  touchOnScreen: onScreen(tA, 390, 844) && camTouch && Math.abs(camTouch.aspect - 0.46) < 0.02,
  touchAimsResolve: touchAim && touchAim.bad === 0,
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, cam0, camTouch,
  s0: { tiles: s0.tiles, free: s0.free },
  covered: { ix: coveredIx, blocked: sCov && sCov.blocked, tiles: sCov && sCov.tiles },
  took: { tiles: sOne.tiles, tray: sOne.tray, inputs: sOne.inputs, dups: sOne.dups },
  dup: { inputs: sDup.inputs, dups: sDup.dups },
  hintIx,
  play: { steps, peak, clearedSeen, score: sWin && sWin.score, tray: sWin && sWin.tray },
  win: { sheet: winSheet.title, text: winSheet.text },
  lose: { setupRes, setup: sLoseSetup && sLoseSetup.trayLen, tiles: sLoseSetup && sLoseSetup.tiles, sheet: loseSheet.title, text: loseSheet.text },
  undo: { over: sUndo.over, tray: sUndo.trayLen, tiles: sUndo.tiles },
  touch: { tiles: sTouch.tiles, at: tA },
  shots: [shotBoot, shotMid, shotWin, shotTouch],
}, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
