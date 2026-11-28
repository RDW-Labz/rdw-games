#!/usr/bin/env node
// Interaction gate for the Colorful port (suve/LD25 card).
// Serves the site repo root (so ./kit.js resolves), drives headless Chromium with real CDP
// mouse/touch events, and asserts through the page's own state hook that the world actually
// reacts: steering, a pickup, a delivery, a kill, the loss, the win, restart, and a portrait
// touch pass. A canvas that merely exists is not proof.
//
// usage: node scripts/colorful-gate.mjs [rootDir] [shotDir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const SHOTS = process.argv[3] || '/home/cluer/cloned-free-games/.queue/playtest';
const URL_PATH = '/games/arcade/colorful/';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/col-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('unhandledRejection', (e) => { console.error('FATAL', e && e.message); kill(); process.exit(1); });
process.on('SIGTERM', () => { kill(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 120000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}${URL_PATH}`;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('no page target');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error').slice(0, 400) };
  return r.result?.value;
};
const poll = async (expr, want, budget = 25000, tag = '') => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < budget) {
    last = await ev(expr);
    if (want(last)) return { ok: true, v: last, ms: Date.now() - t0 };
    await sleep(120);
  }
  return { ok: false, v: last, ms: Date.now() - t0, tag };
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await S('Page.navigate', { url: base });
const boot = await poll(`typeof window.__colorful === 'function'`, (v) => v === true, 90000, 'boot');
if (!boot.ok) { console.error('FAIL: hook never booted: ' + JSON.stringify(boot.v)); kill(); process.exit(1); }
T('booted in ' + (Date.now() - t0) + ' ms');

let fails = 0, checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.log('  FAIL ' + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return false;
};
const st = () => ev('window.__colorful()');
const mouse = async (type, x, y, extra = {}) => S('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, pointerType: 'mouse', ...extra });
const down = (p) => mouse('mousePressed', p.x, p.y);
const up = (p) => mouse('mouseReleased', p.x, p.y);
const click = async (p) => { await down(p); await sleep(60); await up(p); };
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await click(b);
  await sleep(250);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name, dir = SHOTS) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(dir, { recursive: true });
  const out = join(dir, name);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1. boot state ---------------------------------------------------------------------
console.log('1. boot');
const s0 = await st();
ok(s0 && s0.hp === 3 && s0.lives === 3 && s0.delivered === 0 && !s0.over, 'starts whole at the altar', s0);
ok(JSON.stringify(s0.room) === '[3,3]', 'the run starts in the altar room', s0.room);
ok(s0.enemiesAlive > 60, 'the world is populated', s0.enemiesAlive);
ok((await ev('window.__colorful.fit()')).visH > 10, 'the camera is fitted');

// ---- 2. real steering ------------------------------------------------------------------
console.log('2. steering');
const pp0 = await ev('window.__colorful.playerPoint()');
ok(pp0 && pp0.x > 40 && pp0.y > 40 && pp0.x < 1240 && pp0.y < 760, 'the ship is on screen', pp0);
await down({ x: pp0.x + 150, y: pp0.y });
const steerR = await poll('window.__colorful().x', (v) => v > 1.6, 15000, 'steer-right');
await up({ x: pp0.x + 150, y: pp0.y });
await sleep(200);
ok(steerR.ok, 'holding the pointer to the right flies the ship right', steerR.v);
ok((await st()).facing === 1, 'the ship faces its heading');
const pp1 = await ev('window.__colorful.playerPoint()');
await down({ x: pp1.x - 190, y: pp1.y });
const steerL = await poll('window.__colorful().facing', (v) => v === -1, 12000, 'steer-left');
await up({ x: pp1.x - 190, y: pp1.y });
await sleep(200);
ok(steerL.ok, 'steering left turns the guns left', steerL.v);

// ---- 3. a real pickup ------------------------------------------------------------------
console.log('3. pickup');
const home = await ev('window.__colorful.artifactHome(0)');
await ev(`window.__colorful.setup(${JSON.stringify({ at: [home.x - 4, home.y], hp: 3, lives: 3, invuln: 999, clearBullets: true })})`);
await sleep(150);
const ap = await ev('window.__colorful.artifactPoint(0)');
await down(ap);
const pick = await poll('window.__colorful().carrying', (v) => v === 0, 25000, 'pickup');
await up(ap);
ok(pick.ok, 'flying onto a colour artifact picks it up', pick.v);
const sp = await st();
ok(sp.artifacts[0].state === 'carried', 'the artifact is carried, not delivered', sp.artifacts[0].state);
ok(sp.delivered === 0, 'a pickup is not a delivery', sp.delivered);

// ---- 4. a real delivery ----------------------------------------------------------------
console.log('4. delivery');
await ev(`window.__colorful.setup(${JSON.stringify({ carrying: 0, at: [5.0, 2.5], invuln: 999, clearBullets: true })})`);
await sleep(150);
const hub = await ev('window.__colorful.hubPoint()');
await down(hub);
const del = await poll('window.__colorful().delivered', (v) => v >= 1, 25000, 'deliver');
await up(hub);
ok(del.ok, 'carrying a colour into the altar ring delivers it', del.v);
const s4 = await st();
ok(s4.carrying === null && s4.artifacts[0].state === 'delivered', 'the altar claims the colour', { carry: s4.carrying, st: s4.artifacts[0].state });
ok(s4.score > 100, 'delivery scores', s4.score);

// ---- 5. guns kill ----------------------------------------------------------------------
console.log('5. kill');
let enemyId = -1, enemy = null;
for (let i = 0; i < 200 && enemyId < 0; i++) {
  const e = await ev(`window.__colorful.enemyWorld(${i})`);
  if (e && e.alive) { enemyId = i; enemy = e; }
}
ok(enemyId >= 0, 'found a live drone', enemyId);
const rc = await ev(`window.__colorful.roomWorld(${enemy.room[0]}, ${enemy.room[1]})`);
// Park the drone at the middle of its own room and the ship 5.5 units west of it, so neither
// spawn can land inside a wall and the only thing between them is open floor.
await ev(`window.__colorful.setup(${JSON.stringify({ at: [rc.x - 5.5, rc.y], invuln: 999, clearBullets: true, enemyAt: { id: enemyId, x: rc.x, y: rc.y, hp: 2 } })})`);
await sleep(800);   // let the camera settle on the teleported ship
const pp3 = await ev('window.__colorful.playerPoint()');
const ep = await ev(`window.__colorful.enemyPoint(${enemyId})`);
if (ep && pp3) {
  const aim = { x: Math.max(30, Math.min(1250, pp3.x + Math.max(90, (ep.x - pp3.x) * 0.7))), y: pp3.y };
  await down(aim);
  const kill = await poll('window.__colorful().kills', (v) => v >= 1, 30000, 'kill');
  await up(aim);
  ok(kill.ok, 'sideways fire kills a drone', { kills: kill.v, aim, pp3, ep, st: await st() });
  ok((await st()).enemiesAlive < s0.enemiesAlive, 'the drone population drops');
} else ok(false, 'drone had a screen point', { ep, pp3 });

// ---- 6. the loss -----------------------------------------------------------------------
console.log('6. loss');
await ev(`window.__colorful.setup(${JSON.stringify({ hp: 1, lives: 1, invuln: 0, at: [0, 0], clearBullets: true, bullet: { x: 2.4, y: 0, vx: -6, vy: 0 } })})`);
const lose = await poll('JSON.stringify({r:window.__colorful().result,over:window.__colorful().over})', (v) => v && v.includes('"lose"'), 30000, 'lose');
await sleep(400);
ok(lose.ok, 'the last hit ends the run', lose.v);
const sh6 = await sheet();
ok(sh6.open && /Out of lives/.test(sh6.title), 'the loss sheet opens', sh6);
await shot('colorful-lose.png');

// ---- 7. restart ------------------------------------------------------------------------
console.log('7. restart');
await clickEl('overBtn');
await sleep(400);
const s7 = await st();
ok(!s7.over && s7.delivered === 0 && s7.lives === 3 && s7.hp === 3, 'Play again deals a fresh run', s7);
ok(!(await sheet()).open, 'the sheet closes on restart');

// ---- 8. the win ------------------------------------------------------------------------
console.log('8. win');
await ev(`window.__colorful.setup(${JSON.stringify({ delivered: 7, carrying: 7, at: [4.2, 2.6], invuln: 999, clearBullets: true })})`);
await sleep(200);
const hub2 = await ev('window.__colorful.hubPoint()');
await down(hub2);
const win = await poll('JSON.stringify({d:window.__colorful().delivered,r:window.__colorful().result})', (v) => v && v.includes('"win"'), 30000, 'win');
await up(hub2);
await sleep(400);   // the HUD syncs every few frames; give the sheet a beat to open
ok(win.ok, 'the eighth colour wins the run', win.v);
const sh8 = await sheet();
ok(sh8.open && /Every colour is home/.test(sh8.title), 'the win sheet opens', sh8);
await shot('colorful-win.png');

// ---- 9. tile art -----------------------------------------------------------------------
console.log('9. art');
await ev('window.__colorful.restart(7)');
await sleep(300);
const home2 = await ev('window.__colorful.artifactHome(3)');
await ev(`window.__colorful.setup(${JSON.stringify({ at: [home2.x - 4.5, home2.y + 1.6], invuln: 999, clearBullets: true })})`);
await down({ x: 900, y: 300 });
await sleep(1400);
await up({ x: 900, y: 300 });
await shot('colorful-play.png');
const artPath = await shot('Colorful.png', '/home/cluer/cloned-free-games/.queue/lib-art');
T('art shot ' + artPath);

// ---- 10. portrait touch ----------------------------------------------------------------
console.log('10. portrait touch');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(400);
await ev('window.__colorful.restart(11)');
await sleep(400);
// prime the override with one neutral press (headless can swallow the first event after a resize)
await click({ x: 195, y: 430 });
await sleep(200);
const p0 = await st();
const pt = await ev('window.__colorful.playerPoint()');
ok(pt && pt.x > 20 && pt.x < 370 && pt.y > 80 && pt.y < 790, 'the ship frames inside a 390x844 phone', pt);
const touch = async (type, x, y, id = 1) => S('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), id, radiusX: 6, radiusY: 6, force: 1 }],
});
await touch('touchStart', pt.x + 90, pt.y);
await sleep(90);
const touchMove = await poll('window.__colorful().x', (v) => v > 0.8, 15000, 'touch-steer');
await touch('touchEnd', pt.x + 90, pt.y);
ok(touchMove.ok, 'a finger flies the ship on a phone', touchMove.v);
const pt2 = await ev('window.__colorful.playerPoint()');
ok(pt2 && pt2.x > 10 && pt2.x < 380, 'the ship is still in frame after flying', pt2);
await shot('colorful-portrait.png');

// ---- 11. console errors ----------------------------------------------------------------
console.log('11. console');
const bad = pageCdp.events.filter((m) => (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') ||
  m.method === 'Runtime.exceptionThrown');
ok(bad.length === 0, 'no console errors or exceptions', bad.slice(0, 3).map((m) => JSON.stringify(m.params).slice(0, 220)));

console.log(fails === 0 ? `PASS ${checks} checks` : `FAIL ${fails}/${checks} checks`);
kill();
server.close();
process.exit(fails === 0 ? 0 : 1);
