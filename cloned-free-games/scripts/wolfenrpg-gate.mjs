#!/usr/bin/env node
// Interaction gate for the Wolfenstein RPG port (the Doom / Wolfenstein RPG card).
// Serves the site repo root so the port loads its own kit.js, drives headless Chromium
// with real mouse/touch events, and asserts state-hook changes for shoot / turn / step /
// win / lose / restart plus a 390x844 touch pass.
//
// usage: node scripts/wolfenrpg-gate.mjs [rootDir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/wolfenstein-rpg/index.html';
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
const PROFILE = mkdtempSync('/tmp/wolf-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
T('serving ' + ROOT + ' on ' + port);
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5500);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return b;
  await click(b);
  return b;
};
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: vk });
  await sleep(260);
};
const st = () => ev('window.__wolfen()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot: a corridor with a monster at the end of it
const hookType = await ev('typeof window.__wolfen');
const s0 = await st();
const pt0 = await ev('window.__wolfen.enemyPoint(0)');
const title = await ev('document.title');
const shotBoot = await shot('wolfenrpg-gate-boot');

// ---- 2) shoot the opening grunt with a real canvas click
let s1 = s0, s2 = s0;
if (pt0 && !pt0.__err) {
  await click(pt0);
  s1 = await st();
  await click(pt0);
  s2 = await st();
}
const shotKill = await shot('wolfenrpg-gate-kill');

// ---- 3) turn with the on-screen button, then bump a wall with the step button
const dBefore = s2.dir;
await clickEl('turnR');
const sTurn = await st();
await clickEl('turnL');
const sTurn2 = await st();
// walk until a bump registers (or 8 steps), through the step button
let sWalk = sTurn2, bumps = 0;
const hall = await ev('window.__wolfen.hall()');
for (let i = 0; i < 6; i++) {
  await clickEl('stepBtn');
  sWalk = await st();
  if (sWalk.over) break;
}
const shotWalk = await shot('wolfenrpg-gate-walk');

// ---- 4) win: step onto the way down on the last floor
await ev('window.__wolfen.setup({floor:3, preExit:true})');
await sleep(500);
const sPre = await st();
await clickEl('stepBtn');
await sleep(400);
const sWin = await st();
const winSheet = await sheet();
const shotWin = await shot('wolfenrpg-gate-win');

// ---- 5) lose: a brute in your face with 8 health left
await ev('window.__wolfen.setup({floor:1, enemies:"ambush", hp:8})');
await sleep(500);
const sPreLose = await st();
await clickEl('turnR');
await sleep(400);
const sLose = await st();
const loseSheet = await sheet();
const shotLose = await shot('wolfenrpg-gate-lose');

// ---- 6) restart from the sheet, then with R
const restartPt = await clickEl('overBtn');
await sleep(500);
const sNew = await st();
const newSheet = await sheet();
await ev('window.__wolfen.setup({floor:2, preExit:true})');
await sleep(300);
await key('KeyR', 82);
const sR = await st();

// ---- 7) 390x844 portrait: a finger tap on the opening monster must fire
const errors1 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5500);
const sT0 = await st();
const ptT = await ev('window.__wolfen.enemyPoint(0)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
if (ptT && !ptT.__err) await tap(ptT);
const sT1 = await st();
const nextBtn = await ev(`(()=>{const e=document.getElementById('fireBtn');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};})()`);
if (nextBtn && !nextBtn.__err) await tap(nextBtn);
const sT2 = await st();
const shotTouch = await shot('wolfenrpg-gate-touch');
const errors2 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 3).join(' | ');

const inView = (p) => p && !p.__err && p.x > 4 && p.x < 1276 && p.y > 4 && p.y < 796;

const checks = {
  boot: hookType === 'function' && /wolfenstein/i.test(title || '') && s0.floor === 1 && s0.hp === 100 && s0.ammo === 24 && s0.alive === 5 && s0.over === false,
  targetVisible: inView(pt0) && pt0.z < 1,
  shotLands: s1.shots === s0.shots + 1 && s1.ammo === s0.ammo - 1 && s1.hits === s0.hits + 1 && s1.kills === 1 && s1.alive === s0.alive - 1,
  secondTapIsHonest: s2.shots === s1.shots + 1 && s2.ammo === s1.ammo - 1,
  turns: sTurn.dir === ((dBefore + 1) & 3) && sTurn2.dir === dBefore,
  walked: sWalk.steps >= 1 && (sWalk.r !== sTurn2.r || sWalk.c !== sTurn2.c || sWalk.blocked >= 1),
  preExit: sPre.floor === 3 && Math.abs(sPre.r - sPre.exit.r) + Math.abs(sPre.c - sPre.exit.c) === 1 && sPre.over === false,
  won: sWin.over === true && sWin.won === true && winSheet.open === true && /vault cleared/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && sLose.hp === 0 && loseSheet.open === true && /died/i.test(loseSheet.title),
  restarted: sNew.over === false && sNew.won === false && sNew.floor === 1 && sNew.hp === 100 && sNew.kills === 0 && newSheet.open === false,
  keyRestart: sR.floor === 1 && sR.over === false && sR.hp === 100,
  touchFires: sT1.shots >= sT0.shots + 1 && sT1.kills >= 1 && sT1.alive === sT0.alive - 1,
  touchButton: sT2.shots === sT1.shots + 1,
  touchInView: ptT && !ptT.__err && ptT.x > 4 && ptT.x < 386 && ptT.y > 4 && ptT.y < 840,
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks,
  errors1, errors2, title,
  s0: { floor: s0.floor, hp: s0.hp, ammo: s0.ammo, alive: s0.alive, dir: s0.dir, r: s0.r, c: s0.c },
  pt0,
  s1: { shots: s1.shots, ammo: s1.ammo, hits: s1.hits, kills: s1.kills, alive: s1.alive },
  s2: { shots: s2.shots, ammo: s2.ammo },
  sTurn: { dir: sTurn.dir, dBefore }, sTurn2: { dir: sTurn2.dir },
  sWalk: { r: sWalk.r, c: sWalk.c, steps: sWalk.steps, blocked: sWalk.blocked, over: sWalk.over },
  sPre: { floor: sPre.floor, r: sPre.r, c: sPre.c, exit: sPre.exit },
  sWin: { over: sWin.over, won: sWin.won, kills: sWin.kills }, winSheet,
  sLose: { over: sLose.over, won: sLose.won, hp: sLose.hp }, loseSheet,
  sNew: { floor: sNew.floor, hp: sNew.hp, kills: sNew.kills }, newSheet,
  sR: { floor: sR.floor, hp: sR.hp, over: sR.over },
  sT0: { shots: sT0.shots, alive: sT0.alive }, sT1: { shots: sT1.shots, kills: sT1.kills, alive: sT1.alive }, sT2: { shots: sT2.shots },
  ptT, hall,
  shots: [shotBoot, shotKill, shotWalk, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
