#!/usr/bin/env node
// Interaction gate for the Block World port (Minetest Game / Freeminer cards):
// real CDP mouse on the voxel island, state-hook assertions for dig / place /
// win / lose / restart, plus portrait touch. usage: node minetest-gate.mjs <dir>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/tmp/minetest-stage');
const FILE = 'games/arcade/minetest-game.html';
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
const PROFILE = mkdtempSync('/tmp/vox-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-30));
const cdp = await CDP.attach(endpoint);
T('cdp attached');
const server = await serve();
const port = server.address().port;
T('serving ' + port);
// Drive the page target directly: browser-level Target.createTarget hangs on this
// headless build, and page-level sessions need no session id.
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
T('page target ' + (pageTarget ? 'ok' : 'missing'));
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const cdpEvents = () => pageCdp.events;
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

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const tapAt = async (x, y, z) => {
  const p = await ev(`window.__blockworld.blockPoint(${x},${y},${z})`);
  if (!p || p.__err) return { p, err: p.__err };
  await click(p);
  await sleep(280);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot
const s0 = await ev('window.__blockworld()');
const hookType = await ev('typeof window.__blockworld');
const sites = await ev('window.__blockworld.sites()');
const shotBoot = await shot('minetest-gate-boot');

// ---- 2) mine down from a sand marker to the gold seam (2 real clicks)
const A = sites[0];
await tapAt(A.x, A.h, A.z);            // sand
const s1 = await ev('window.__blockworld()');
const pGold = await tapAt(A.x, A.goldY, A.z);  // gold
const s2 = await ev('window.__blockworld()');
const shotDig = await shot('minetest-gate-dig');
T('after dig ' + JSON.stringify([s1.digs, s2.digs, s2.gold, s2.blocks]));

// ---- 3) build mode puts a mined block back
await clickEl('mode');
const sMode = await ev('window.__blockworld()');
await ev(`(()=>{const b=document.querySelectorAll('#hotbar .hb')[3]; b.click(); return b.textContent;})()`);
const sSel = await ev('window.__blockworld()');
await tapAt(A.x, A.goldY, A.z);        // fill the shaft above the gold
const sPlace = await ev('window.__blockworld()');
const shotPlace = null;   // swiftshader screenshots are the slow part; four is enough
T('after place ' + JSON.stringify([sMode.mode, sSel.sel, sPlace.blocks, sPlace.inv]));

// ---- 4) lose: one dig left, gold still buried
await ev('window.__blockworld.setup({gold:1,digs:1,mode:"dig"})');
await sleep(200);
const B = sites[1];
await tapAt(B.x, B.h, B.z);
await sleep(300);
const sLose = await ev('window.__blockworld()');
const loseSheet = await sheet();
const shotLose = null;
T('after lose ' + JSON.stringify([sLose.over, sLose.gold, loseSheet.title]));

// ---- 5) win: four seams found, mine the fifth through the real board
await ev('window.__blockworld.setup({gold:4,digs:12,mode:"dig"})');
await sleep(200);
const C = sites[2];
await tapAt(C.x, C.h, C.z);
await tapAt(C.x, C.goldY, C.z);
await sleep(300);
const sWin = await ev('window.__blockworld()');
const winSheet = await sheet();
const shotWin = await shot('minetest-gate-win');
T('after win ' + JSON.stringify([sWin.over, sWin.gold, winSheet.title]));

// ---- 6) restart from the sheet, then the R key
await clickEl('overBtn');
await sleep(400);
const sNew = await ev('window.__blockworld()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sR = await ev('window.__blockworld()');
const shotEnd = null;

// ---- 7) orbit drag keeps the island framed
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 420, button: 'left', clickCount: 1, pointerType: 'mouse' });
for (let i = 1; i <= 6; i++) await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640 + i * 26, y: 420 + i * 4, button: 'left', pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 796, y: 444, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(600);
const sOrbit = await ev('window.__blockworld()');
const orbitCorner = await ev(`window.__blockworld.blockPoint(0, 4, 0)`);
const shotOrbit = null;

// ---- 8) portrait touch
const errors1 = cdpEvents().filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
const sites2 = await ev('window.__blockworld.sites()');
const D = sites2[3];
const tPts = [];
for (const [x, y, z] of [[D.x, D.h, D.z], [D.x, D.goldY, D.z]]) {
  const p = await ev(`window.__blockworld.blockPoint(${x},${y},${z})`);
  tPts.push(p);
  await tap(p);
}
await sleep(300);
const sTouch = await ev('window.__blockworld()');
const edge = await ev(`window.__blockworld.blockPoint(0,0,0)`);
const shotTouch = await shot('minetest-gate-touch');
T('after touch ' + JSON.stringify(sTouch));
const errors2 = cdpEvents().filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const checks = {
  boot: hookType === 'function' && s0 && s0.digs === 26 && s0.gold === 0 && s0.over === false && s0.blocks > 300,
  sandDug: s1.digs === 25 && s1.blocks === s0.blocks - 1 && s1.gold === 0,
  goldFound: s2.digs === 24 && s2.gold === 1 && s2.blocks === s0.blocks - 2,
  buildMode: sMode.mode === 'build' && sSel.mode === 'build' && sSel.sel === 5,
  placed: sPlace.blocks === s2.blocks + 1 && sPlace.inv[5] === s2.inv[5] - 1 && sPlace.gold === s2.gold,
  lost: sLose.over === true && sLose.won === false && sLose.gold === 1 && sLose.digs === 0 && loseSheet.open === true && /dull/i.test(loseSheet.title),
  won: sWin.over === true && sWin.won === true && sWin.gold === 5 && winSheet.open === true && /seam/i.test(winSheet.title),
  restarted: sNew.digs === 26 && sNew.gold === 0 && sNew.over === false && sNew.blocks === s0.blocks && sNew.mode === 'dig',
  keyRestart: sR.digs === 26 && sR.gold === 0 && sR.over === false,
  orbitKept: sOrbit && sOrbit.blocks === s0.blocks && orbitCorner && orbitCorner.x > 4 && orbitCorner.x < 1276 && orbitCorner.y > 4 && orbitCorner.y < 796,
  onScreen: pGold && pGold.x > 8 && pGold.x < 1272 && pGold.y > 8 && pGold.y < 792,
  touchDug: sTouch.digs === 24 && sTouch.gold === 1,
  touchOnScreen: edge && tPts.every((p) => p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  s0, s1: { digs: s1.digs, blocks: s1.blocks }, s2: { digs: s2.digs, gold: s2.gold, blocks: s2.blocks, inv: s2.inv },
  sMode: { mode: sMode.mode }, sSel: { mode: sSel.mode, sel: sSel.sel },
  sPlace: { blocks: sPlace.blocks, inv: sPlace.inv, gold: sPlace.gold },
  sLose: { over: sLose.over, won: sLose.won, gold: sLose.gold, digs: sLose.digs }, loseSheet,
  sWin: { over: sWin.over, won: sWin.won, gold: sWin.gold }, winSheet,
  sNew: { digs: sNew.digs, blocks: sNew.blocks, mode: sNew.mode }, sR: { digs: sR.digs },
  sOrbit: { blocks: sOrbit && sOrbit.blocks }, orbitCorner, pGold,
  sTouch: { digs: sTouch.digs, gold: sTouch.gold }, tPts, edge,
  sites: sites && sites.length, shots: [shotBoot, shotDig, shotPlace, shotLose, shotWin, shotOrbit, shotEnd, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
