#!/usr/bin/env node
// Interaction gate for the Infra Arcana port: real in-frame pointer events on the board plane, real
// CDP clicks on the pad/Reload/Pray/class/sheet buttons, keyboard arrows, a gunshot at a horror in
// line of sight, a descend driven through the port's own move rules, the Trapezohedron win, a death,
// the class control, restart, and a portrait touch pass. Every assertion reads the state hook.
// usage: node scripts/infra-arcana-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/infra-arcana/index.html';
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
    ws.onmessage = (mm) => {
      const msg = JSON.parse(mm.data);
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/ia-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: PROFILE } });
const killAll = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { killAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { T('unhandled ' + e); killAll(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 60000);
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
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
// poll for the boot hook instead of a fixed sleep
let bootMs = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const okHook = await ev(`typeof window.__ia === 'function'`);
    if (okHook === true) { bootMs = Date.now() - t0; break; }
    await sleep(400);
  }
}
T('page loaded hook=' + bootMs + 'ms');

const errorsOf = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  if (!pt) return false;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(280);
  return true;
};
const ptOf = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code, windowsVirtualKeyCode: vk });
  await sleep(240);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// In-frame tap on a cell: exactly ONE pointerdown/pointerup pair. The port listens on body and
// hit-tests the floor plane, so the down goes to the element under the point and the up to body.
const tapPoint = async (expr, { touch = false } = {}) => ev(`(()=>{
  const p = ${expr}; if (!p) return {__err:'no point'};
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: '${touch ? 'touch' : 'mouse'}', button: 0, isPrimary: true,
              clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return p;
})()`);

// ---- 1) boot ----
const s0 = await ev('window.__ia()');
const shotBoot = await shot('infra-arcana-gate-boot');
T(`boot depth=${s0.depth} cls=${s0.cls} hp=${s0.hp} san=${s0.san} monsters=${s0.monsters.length}`);

// ---- 2) one real board tap steps the investigator; the lair answers ----
const p0 = await tapPoint('window.__ia.gateStepPoint(0)');
await sleep(340);
const sTap = await ev('window.__ia()');

// ---- 3) the same tap fired twice inside one tick is dropped by the guard ----
await ev(`(()=>{
  const p = window.__ia.gateStepPoint(1) || window.__ia.gateStepPoint(0);
  if (!p) return false;
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return true;
})()`);
await sleep(320);
const sDup = await ev('window.__ia()');

// ---- 4) pad click and keyboard arrow both move ----
const openDirOf = () => ev(`(()=>{ const s = window.__ia();
  const nb = window.__ia.neighbours();
  for (const [d, dr, dc] of [['up',-1,0],['down',1,0],['left',0,-1],['right',0,1]])
    if (nb.some(([r,c]) => r === s.pos[0]+dr && c === s.pos[1]+dc)) return d;
  return null; })()`);
const before = await ev('window.__ia.newRun()');
let sPad = before, padPt = null, padTries = 0;
while (padTries < 3 && sPad.pos.join(',') === before.pos.join(',')) {
  const d = await openDirOf();
  if (!d) break;
  padPt = await ptOf(`.pad button[data-dir="${d}"]`);
  await click(padPt);
  sPad = await ev('window.__ia()');
  padTries++;
}
const openDir2 = await openDirOf();
const VK = { up: 38, down: 40, left: 37, right: 39 };
if (openDir2) await key(openDir2 === 'up' ? 'ArrowUp' : openDir2 === 'down' ? 'ArrowDown' : openDir2 === 'left' ? 'ArrowLeft' : 'ArrowRight', VK[openDir2]);
const sKey = await ev('window.__ia()');

// ---- 5) Pray restores spirit (a real click on a real button) ----
await ev('window.__ia.boost(null, 10)');
const prayPt = await ptOf('#pray');
await click(prayPt);
const sPray = await ev('window.__ia()');

// ---- 6) a gunshot: a horror in clear line of sight, tapped for real ----
await ev('window.__ia.setup(2)');
await ev('window.__ia.boost(60, 40)');
const spawned = await ev(`window.__ia.spawnLOS('cultist', 4)`);
await sleep(200);
const sPre = await ev('window.__ia()');
const tapFired = spawned && spawned.point ? await tapPoint(`(${JSON.stringify(spawned.point)})`) : null;
await sleep(340);
const sFire = await ev('window.__ia()');
const shotFire = await shot('infra-arcana-gate-gun');

// ---- 7) reload fills the magazine from the reserve ----
const magBefore = sFire.mag, reserveBefore = sFire.reserve;
const reloadPt = await ptOf('#reload');
await click(reloadPt);
const sReload = await ev('window.__ia()');

// ---- 8) descend a floor through the port's own rules (taps on the stairs cell) ----
await ev('window.__ia.setup(1)');
await ev('window.__ia.boost(400, 400)');
let descTries = 0;
let sDesc = await ev('window.__ia()');
while (sDesc.depth === 1 && descTries < 220) {
  await ev(`(()=>{ const s = window.__ia(); const st = s.stairs; if (!st) return false; return window.__ia.tapCell(st[0], st[1]); })()`);
  descTries++;
  if (descTries % 20 === 0) await sleep(60);
  sDesc = await ev('window.__ia()');
}
const shotDesc = await shot('infra-arcana-gate-descent');
T(`descend tries=${descTries} depth=${sDesc.depth} kills=${sDesc.kills}`);

// ---- 9) win: bottom floor, walk onto the Trapezohedron ----
await ev('window.__ia.setup(6)');
await ev('window.__ia.boost(400, 400)');
let winTries = 0;
let sWin = await ev('window.__ia()');
while (!sWin.over && winTries < 260) {
  const step = await ev(`(()=>{ const s = window.__ia(); const rel = s.items.find(i => i.kind === 'relic'); if (!rel) return null; return window.__ia.tapCell(rel.r, rel.c); })()`);
  if (step === null) break;
  winTries++;
  if (winTries % 20 === 0) await sleep(60);
  sWin = await ev('window.__ia()');
}
const winSheet = await sheet();
const shotWin = await shot('infra-arcana-gate-win');
T(`win tries=${winTries} over=${sWin.over} won=${sWin.won} sheet=${winSheet.title}`);

// ---- 10) lose: a ghoul parked next to a 1 hp investigator; wait turns (real Space keydowns) ----
await ev('window.__ia.setup(1)');
await ev('window.__ia.boost(1, 60)');
const adj = await ev(`window.__ia.spawnAdjacent('ghoul')`);
let loseTries = 0;
let sLose = await ev('window.__ia()');
while (!sLose.over && loseTries < 12 && adj) {
  await key('Space', 32);
  loseTries++;
  sLose = await ev('window.__ia()');
}
const loseSheet = await sheet();
const shotLose = await shot('infra-arcana-gate-lose');
T(`lose tries=${loseTries} over=${sLose.over} why=${sLose.why} sheet=${loseSheet.title}`);

// ---- 11) restart from the sheet's own button, then the class control ----
const overBtn = await ptOf('#overBtn');
await click(overBtn);
await sleep(400);
const sNew = await ev('window.__ia()');
const clsPt = await ptOf('#clsBtn');
await click(clsPt);
await sleep(300);
const sClass = await ev('window.__ia()');
const clsLabel = await ev(`document.getElementById('clsBtn').textContent`);

// ---- 12) library art: a mid-fight frame with the pedestal in view ----
await ev('window.__ia.setup(6)');
await ev('window.__ia.boost(26, 30)');
await ev(`window.__ia.spawnLOS('shoggoth', 4)`);
await ev('window.__ia.revealAll()');
await sleep(500);
const shotArt = await shot('infra-arcana-hero');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await writeFile('/home/cluer/cloned-free-games/.queue/lib-art/infra-arcana.png', await readFile(shotArt));
T('art shot ' + shotArt);

// ---- 13) portrait touch: one finger tap on an open neighbour ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
{
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const okHook = await ev(`typeof window.__ia === 'function'`);
    if (okHook === true) break;
    await sleep(400);
  }
}
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
// a neutral prime press on the HUD (headless can swallow the first event after a metrics override)
await click(await ptOf('#restart'));
const tState = await ev('window.__ia()');
const tapPt = await tapPoint('window.__ia.gateStepPoint(0)', { touch: true });
await sleep(380);
const sTouch = await ev('window.__ia()');
const tCornerA = await ev(`window.__ia.tilePoint(0,0)`);
const tCornerB = await ev(`window.__ia.tilePoint(20,20)`);
const shotTouch = await shot('infra-arcana-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  boot: !!s0 && s0.depth === 1 && s0.cls === 'exorcist' && s0.steps === 0 && s0.over === false &&
        s0.monsters.length >= 2 && s0.hp === s0.maxHp && s0.san <= s0.maxSan && s0.mag === s0.magSize,
  boardTapSteps: !sTap.__err && sTap.steps === 1 && sTap.pos.join(',') !== s0.pos.join(',') && sTap.inputs >= 1,
  doubleTapGuarded: sDup.dups >= 1 && sDup.steps === sTap.steps + 1,
  padClickSteps: !!padPt && sPad.steps === 1 && sPad.pos.join(',') !== before.pos.join(','),
  keySteps: sKey.steps > sPad.steps,
  prayRestoresSpirit: !sPray.__err && sPray.san > 10 && sPray.steps > sKey.steps,
  gunFires: !!spawned && !!spawned.point && sFire.mag === sPre.mag - 1 && sFire.turns > sPre.turns &&
            (sFire.kills > sPre.kills || (sFire.lastFire && sFire.lastFire.ok === true)),
  reloadFills: !sReload.__err && sReload.mag === sReload.magSize && sReload.reserve < reserveBefore,
  descended: sDesc.depth === 2 && sDesc.monsters.length >= 1 && sDesc.over === false,
  won: sWin.over === true && sWin.won === true && winSheet.open === true && /trapezohedron/i.test(winSheet.title) && sWin.why === 'trapezohedron',
  lost: sLose.over === true && sLose.won === false && loseSheet.open === true && /died/i.test(loseSheet.title) && /slain/.test(sLose.why),
  restarted: sNew.over === false && sNew.depth === 1 && sNew.steps === 0,
  classControl: sClass.cls !== sNew.cls && sClass.steps === 0 && sClass.over === false && clsLabel.toLowerCase() !== 'exorcist',
  touchSteps: !sTouch.__err && sTouch.steps >= 1 && sTouch.pos.join(',') !== tState.pos.join(','),
  onScreen: inScreen(padPt, 1280, 800) && inScreen(p0, 1280, 800) && inScreen(spawned && spawned.point, 1280, 800),
  touchOnScreen: inScreen(tapPt, 390, 844) && inScreen(tCornerA, 390, 844) && inScreen(tCornerB, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, bootMs,
  s0: { depth: s0.depth, cls: s0.cls, pos: s0.pos, hp: s0.hp, san: s0.san, mag: s0.mag, monsters: s0.monsters.length, stairs: s0.stairs },
  sTap: { pos: sTap.pos, steps: sTap.steps, inputs: sTap.inputs }, p0,
  sDup: { steps: sDup.steps, dups: sDup.dups },
  sPad: { pos: sPad.pos, steps: sPad.steps }, sKey: { steps: sKey.steps },
  sPray: { san: sPray.san, steps: sPray.steps },
  spawned, sPre: { mag: sPre.mag, kills: sPre.kills, turns: sPre.turns },
  sFire: { mag: sFire.mag, kills: sFire.kills, turns: sFire.turns, lastFire: sFire.lastFire },
  sReload: { mag: sReload.mag, reserve: sReload.reserve }, magBefore, reserveBefore,
  sDesc: { depth: sDesc.depth, kills: sDesc.kills, steps: sDesc.steps, hp: sDesc.hp },
  sWin: { depth: sWin.depth, over: sWin.over, won: sWin.won, why: sWin.why, kills: sWin.kills }, winSheet,
  sLose: { over: sLose.over, won: sLose.won, why: sLose.why }, loseSheet,
  sNew: { depth: sNew.depth, steps: sNew.steps, cls: sNew.cls },
  sClass: { cls: sClass.cls, steps: sClass.steps, label: clsLabel },
  sTouch: { pos: sTouch.pos, steps: sTouch.steps }, tState: { pos: tState.pos },
  tCornerA, tCornerB,
  shots: [shotBoot, shotFire, shotDesc, shotWin, shotLose, shotTouch, shotArt],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
killAll(); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
