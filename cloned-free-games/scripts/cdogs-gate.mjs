#!/usr/bin/env node
// Interaction gate for the C-Dogs SDL port (F-Droid card cdogs-sdl, GPL-2.0): real CDP mouse
// presses on the SHIPPED page, every assertion read back from window.__cdogs(). A canvas that
// merely exists is not a pass — the dog has to move, a hostile has to die, the hatch has to open.
//
// usage: node cdogs-gate.mjs [site-root]      (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
let PHASE = 'start';
const WATCH = setTimeout(() => { T('WATCHDOG stalled in phase: ' + PHASE); process.exit(3); }, 1500000);
WATCH.unref?.();
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = 'games/arcade/cdogs-sdl/index.html';
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
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) { T('  TIMEOUT ' + method); bad(new Error('timeout ' + method)); } }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cdogs-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const killAll = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { killAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { T('unhandled ' + e); killAll(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 180000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S2 = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
await S2('Runtime.enable'); await S2('Page.enable'); await S2('Log.enable');
await S2('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S2('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${PAGE}`;
await S2('Page.navigate', { url });

const click = async (pt) => {
  await S2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return null;
  await click(b);
  await sleep(420);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S2('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S2('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(220);
};
const st = () => ev('window.__cdogs()');
const poll = async (fn, ms = 20000, step = 140) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const shot = async (name) => {
  const s = await S2('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const consoleErrors = () => pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const report = { legs: [], fails: [] };
const check = (cond, label, data) => {
  report.legs.push({ label, ok: !!cond, data });
  if (!cond) report.fails.push(label + (data !== undefined ? ' — ' + JSON.stringify(data) : ''));
  T(`${cond ? 'ok  ' : 'FAIL'} ${label}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);
  return !!cond;
};

// ---- 1) boot: hook live, clock running, a real floor dealt
PHASE = 'boot';
await poll(async () => ((await ev('typeof window.__cdogs')) === 'function' ? true : null), 90000, 400);
const hookType = await ev('typeof window.__cdogs');
const s0 = await st();
await sleep(800);
const s1 = await st();
const shotBoot = await shot('cdogs-gate-boot');
T('bootShot ' + shotBoot);
check(hookType === 'function', 'debug hook is live', hookType);
check(s0 && s0.level === 1 && s0.hostiles >= 4, 'mission 1 deals a populated floor', s0 && { level: s0.level, hostiles: s0.hostiles });
check(s0 && s0.hp === 100 && !s0.over, 'the dog starts intact and alive', s0 && { hp: s0.hp, over: s0.over });
check(s1 && s1.t > s0.t, 'the fixed-step clock advances', s0 && s1 && [s0.t, s1.t]);
const hudText = await ev('document.getElementById("foes").textContent + "|" + document.getElementById("lvl").textContent');
check(/^\d+\|1\/3$/.test(hudText || ''), 'the HUD shows the mission and hostile count', hudText);

// ---- 2) a real pointer press walks the dog to a tapped floor cell
PHASE = 'action';
await ev('window.__cdogs.restart(1, 7)');
await sleep(5200);
const actionState = await st();
const shotAction = await shot('cdogs-gate-action');
check(actionState.hostiles >= 3, 'a live floor keeps hostiles converging', { hostiles: actionState.hostiles, shots: actionState.shots, hp: actionState.hp });

PHASE = 'walk';
await ev('window.__cdogs.setup({ player: [6, 2], exit: [6, 16], enemies: [], hp: 100 })');
await sleep(260);
const before = await st();
const far = await ev('window.__cdogs.cellPoint(6, 9)');
check(far && far.x > 0 && far.x < 1280 && far.y > 0 && far.y < 800, 'the tapped cell projects on screen', far);
await click(far);
const walked = await poll(async () => { const s = await st(); return s && s.pos.c >= 8 ? s : null; }, 24000) || await st();
check(walked.pos.c > before.pos.c, 'tapping a floor cell walks the dog there', { from: before.pos, to: walked.pos });
const shotWalk = await shot('cdogs-gate-walk');

// ---- 3) the dog's rifle removes a hostile it can see
PHASE = 'gunfight';
await ev('window.__cdogs.setup({ player: [6, 2], exit: [6, 16], enemies: [[6, 11, 44]], hp: 100 })');
await sleep(240);
const g0 = await st();
const foePt = await ev('window.__cdogs.enemyPoint(0)');
await click(foePt);
const killed = await poll(async () => {
  const s = await st();
  return s && s.kills >= 1 ? s : null;
}, 40000);
const shotFight = await shot('cdogs-gate-fight');
check(killed && killed.kills >= 1, 'a hostile on the line is shot down', { shots: killed && killed.shots, hits: killed && killed.hits, kills: killed && killed.kills, hostiles: killed && killed.hostiles });
check(killed && killed.armed === true, 'clearing the deck opens the hatch', killed && { armed: killed.armed, hostiles: killed.hostiles });
check(g0.hostiles >= 1, 'the fight started with a hostile on the floor', g0.hostiles);

// ---- 4) the hatch clears the mission
PHASE = 'hatch';
const exitPt = await ev('window.__cdogs.exitPoint()');
await click(exitPt);
const cleared = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 40000) || await st();
const sheetText = await ev('document.getElementById("title").textContent');
const shotClear = await shot('cdogs-gate-clear');
check(cleared.over === true && cleared.result === 'clear', 'stepping on the armed hatch clears the mission', { result: cleared.result, level: cleared.level });
check(cleared.sheet === 'clear' && /clear/i.test(sheetText || ''), 'the end-of-mission sheet shows', { sheet: cleared.sheet, title: sheetText });

// ---- 5) mission 3 + hatch = the campaign is won
PHASE = 'campaign';
await ev('window.__cdogs.setup({ level: 3, player: [6, 2], exit: [6, 4], enemies: [[6, 6, 12]], hp: 100 })');
await sleep(240);
await click(await ev('window.__cdogs.enemyPoint(0)'));
const m3down = await poll(async () => { const s = await st(); return s && s.kills >= 1 ? s : null; }, 40000) || await st();
await click(await ev('window.__cdogs.exitPoint()'));
const won = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 40000) || await st();
const wonTitle = await ev('document.getElementById("title").textContent');
const shotWon = await shot('cdogs-gate-won');
check(m3down.kills >= 1, 'the last hostile falls', { kills: m3down.kills });
check(won.over === true && won.gameWon === true, 'the campaign ends in a win on mission 3', { result: won.result, gameWon: won.gameWon, level: won.level });
check(/clear|won|surviv/i.test(wonTitle || ''), 'the victory sheet names the win', wonTitle);

// ---- 6) a dog that gets shot goes down, and Again restarts the run
PHASE = 'down';
await ev('window.__cdogs.setup({ level: 1, player: [6, 2], exit: [6, 16], enemies: [[6, 10, 400]], hp: 16 })');
await sleep(240);
const downed = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 60000) || await st();
const downSheet = await ev('document.getElementById("title").textContent');
const shotDown = await shot('cdogs-gate-down');
check(downed.over === true && downed.result === 'down', 'a dog that takes fire goes down', { result: downed.result, hp: downed.hp });
check(downed.sheet === 'down' && /fail|down/i.test(downSheet || ''), 'the failure sheet shows', downSheet);
const againPt = await clickEl('overBtn');
const restarted = await poll(async () => { const s = await st(); return s && !s.over && s.hp === 100 && s.level === 1 ? s : null; }, 20000) || await st();
check(againPt && restarted.over === false && restarted.hp === 100, 'Again restarts a fresh run at full health', { over: restarted.over, hp: restarted.hp, level: restarted.level });

// ---- 7) keyboard steers with the same words as the buttons
PHASE = 'keys';
await ev('window.__cdogs.setup({ player: [6, 2], exit: [6, 16], enemies: [], hp: 100 })');
await sleep(240);
const k0 = await st();
await S2('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
await sleep(900);
await S2('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
const k1 = await st();
check(k1.pos.c > k0.pos.c, 'holding D walks the dog east', { from: k0.pos.c, to: k1.pos.c });

// ---- 8) portrait phone pass: the board still fits and still takes a tap
PHASE = 'portrait';
await S2('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(700);
await ev('window.__cdogs.setup({ player: [6, 2], exit: [6, 16], enemies: [], hp: 100 })');
await sleep(300);
const corner = { a: await ev('window.__cdogs.cellPoint(1, 1)'), b: await ev('window.__cdogs.cellPoint(11, 17)') };
const inside = corner.a && corner.b && corner.a.x > 0 && corner.b.x < 390 && corner.a.y > 0 && corner.b.y < 844;
const pc = await ev('window.__cdogs.cellPoint(9, 8)');
await click(pc);
const pmoved = await poll(async () => { const s = await st(); return s && s.pos.r === 9 && s.pos.c === 8 ? s : null; }, 26000, 160) || await st();
const shotPortrait = await shot('cdogs-gate-portrait');
check(inside, 'the whole board stays inside a 390x844 portrait viewport', { a: corner.a, b: corner.b });
check(pmoved.pos.r === 9 && pmoved.pos.c === 8, 'a touch-target tap lands the dog on the tapped cell', { from: [6, 2], to: pmoved.pos, pt: pc });

// ---- 9) no console noise
PHASE = 'console';
const cerr = consoleErrors();
check(!cerr, 'no page errors or console errors', cerr);

await S2('Emulation.clearDeviceMetricsOverride').catch(() => {});
killAll();
server.close();

const pass = report.fails.length === 0;
console.log(JSON.stringify({ pass, checks: report.legs.length, fails: report.fails, legs: report.legs,
  shots: { boot: shotBoot, action: shotAction, walk: shotWalk, fight: shotFight, clear: shotClear, won: shotWon, down: shotDown, portrait: shotPortrait } }, null, 2));
process.exit(pass ? 0 : 1);
