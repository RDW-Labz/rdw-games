#!/usr/bin/env node
// Interaction gate for the Mahjong Solitaire port: real CDP mouse/touch input on the 3D pile,
// state-hook assertions for select / match / hint / double-dispatch / stuck / win / restart,
// plus screenshots. A canvas that merely exists is not proof.
// usage: node mahjong-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/mahjong-solitaire/index.html';
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
const PROFILE = mkdtempSync('/tmp/mj-gate-');
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
await sleep(6500);

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
const tapTile = async (i, ms = 120) => {
  const p = await ev(`window.__mahjong.aim(${i})`);
  await click(p);
  await sleep(ms);
  return p;
};
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(300); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const st = async () => ev('window.__mahjong()');

// ---- 1) boot: a real 136-tile pile with a choice of free tiles
const s0 = await st();
const cam0 = await ev('window.__mahjong.camera()');
const shotBoot = await shot('mahjong-gate-boot');
const slots = await ev('window.__mahjong.slots()');

// ---- 2) one real pair comes off the pile through pointer input
let p0 = await ev('window.__mahjong.freePair()');
const aimA = await tapTile(p0[0]);
const sSel = await st();
const aimB = await tapTile(p0[1]);
const s1 = await st();
const shotPair = await shot('mahjong-gate-pair');

// ---- 3) the catalog gate fires the same point twice: the second must be counted as a dup
const p1 = await ev('window.__mahjong.freePair()');
const dbl = await ev(`window.__mahjong.aim(${p1[0]})`);
await Promise.all([click(dbl), click(dbl)]);   // concurrent, like the gate does it
await sleep(200);
const sDup = await st();
await ev('window.__mahjong.select(-1)');

// ---- 4) hint lights a real matching pair
const hintPair = await ev('window.__mahjong.hint()');
await sleep(150);
const sHint = await st();

// ---- 5) clear the whole pile with real clicks, following the deal's own clearance order
// (first-free-pair play can dead-end on a perfectly solvable deal — that is mahjong, not a bug)
await clickEl('new');
await sleep(700);
const seq = await ev('window.__mahjong.solution()');
let cleared = 0, wrong = 0;
for (const [a, b] of seq) {
  const before = (await st()).left;
  await tapTile(a, 40);
  await tapTile(b, 40);
  const after = (await st()).left;
  if (after === before - 1) cleared++; else { wrong++; if (wrong > 2) break; }
}
const sWin = await st();
const winSheet = await sheet();
const shotWin = await shot('mahjong-gate-win');

// ---- 6) restart from the sheet rebuilds a full pile
await clickEl('overBtn');
await sleep(600);
const sNew = await st();

// ---- 7) stuck sheet from a QA position: two free tiles that do not match
const freeTop = slots.map((s, i) => i).slice(-2);
await ev(`window.__mahjong.setup([[${freeTop[0]},0],[${freeTop[1]},1]])`);
await sleep(500);
const sStuck = await st();
const stuckSheet = await sheet();
const shotStuck = await shot('mahjong-gate-stuck');

// ---- 8) touch: portrait phone, tap a real pair
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(7000);
const tState = await st();
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
let tPair = await ev('window.__mahjong.freePair()');
const tA = await ev(`window.__mahjong.aim(${tPair[0]})`);
const tB = await ev(`window.__mahjong.aim(${tPair[1]})`);
const tEdge = await ev('window.__mahjong.tilePoint(0)');
await tap(tA);
await tap(tB);
const sTouch = await st();
const shotTouch = await shot('mahjong-gate-touch');

const errors = errorsOf();
const onScreen = (p, w, h) => p && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;

const checks = {
  bootTiles: s0 && s0.tiles === 136 && s0.left === 68,
  bootChoice: s0 && s0.free >= 8 && s0.noPair === false,
  bootOnScreen: onScreen(aimA, 1280, 800) && onScreen(aimB, 1280, 800),
  selected: sSel && sSel.selected === p0[0] && sSel.tiles === 136,
  matched: s1 && s1.left === 67 && s1.tiles === 134,
  dupDropped: sDup && sDup.dups >= 1 && sDup.inputs === 3 && sDup.left === 67 && sDup.tiles === 134,
  hintWorks: Array.isArray(hintPair) && hintPair.length === 2 && hintPair[0] !== hintPair[1] &&
    sHint.kinds[hintPair[0]] === sHint.kinds[hintPair[1]] && sHint.lives[hintPair[0]] === 1 && sHint.lives[hintPair[1]] === 1,
  cleared: sWin && sWin.left === 0 && sWin.tiles === 0 && cleared === 68 && wrong === 0,
  won: sWin && sWin.over === true && sWin.won === true && winSheet.open === true && /cleared/i.test(winSheet.title),
  restarted: sNew && sNew.left === 68 && sNew.tiles === 136 && sNew.over === false,
  stuck: sStuck && sStuck.over === true && sStuck.stuck === true && sStuck.left === 1 && stuckSheet.open === true && /no moves/i.test(stuckSheet.title),
  touchPair: sTouch && sTouch.left === 67 && sTouch.tiles === 134 && sTouch.dups === 0,
  touchOnScreen: onScreen(tA, 390, 844) && onScreen(tB, 390, 844) && onScreen(tEdge, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, cam0,
  s0: { tiles: s0.tiles, left: s0.left, free: s0.free },
  pair0: p0, sel: sSel && sSel.selected, afterMatch: { left: s1.left, tiles: s1.tiles },
  dup: { inputs: sDup.inputs, dups: sDup.dups, left: sDup.left },
  hintPair, clearedSteps: cleared,
  win: { left: sWin.left, sheet: winSheet.title },
  restarted: { left: sNew.left, tiles: sNew.tiles },
  stuck: { left: sStuck.left, stuck: sStuck.stuck, sheet: stuckSheet.title, text: stuckSheet.text },
  touch: { left: sTouch.left, tiles: sTouch.tiles, at: [tA, tB] },
  shots: [shotBoot, shotPair, shotWin, shotStuck, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
