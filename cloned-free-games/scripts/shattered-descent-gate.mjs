#!/usr/bin/env node
// Interaction gate for the Shattered Descent port: real in-frame pointer events on the board
// plane, real CDP clicks on the pad/wait/sheet buttons, keyboard arrows, a full descend driven
// through the port's own move rules, the amulet win, a death loss, restart, and a portrait
// touch pass. Every assertion reads the page's state hook — a canvas that exists is not proof.
// usage: node shattered-descent-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/shattered-descent/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/sd-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
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
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
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
  await sleep(260);
};
const ptOf = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const key = async (code, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Arrow', 'Arrow'), windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Arrow', 'Arrow'), windowsVirtualKeyCode: vk });
  await sleep(220);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// In-frame tap on a cell: ONE pointerdown/pointerup pair on the element under the point AND the
// canvas is two taps (the kit's raycaster sits on the canvas), so dispatch exactly once on
// elementFromPoint, and never twice.
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
const s0 = await ev('window.__spd()');
const shotBoot = await shot('shattered-descent-gate-boot');
T(`boot depth=${s0.depth} pos=${s0.pos} hp=${s0.hp} monsters=${s0.monsters.length}`);

// ---- 2) one real board tap steps the player and the dungeon answers ----
const p0 = await tapPoint('window.__spd.gateStepPoint(0)');
await sleep(320);
const sTap = await ev('window.__spd()');

// ---- 3) the same tap fired twice inside one tick is dropped by the guard ----
await ev(`(()=>{
  const p = window.__spd.gateStepPoint(1) || window.__spd.gateStepPoint(0);
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return true;
})()`);
await sleep(300);
const sDup = await ev('window.__spd()');

// ---- 4) a real click on the pad moves, a keyboard arrow moves ----
const openDirOf = () => ev(`(()=>{ const s = window.__spd();
  const nb = window.__spd.neighbours();
  for (const [d, dr, dc] of [['up',-1,0],['down',1,0],['left',0,-1],['right',0,1]])
    if (nb.some(([r,c]) => r === s.pos[0]+dr && c === s.pos[1]+dc)) return d;
  return null; })()`);
const before = await ev('window.__spd.newRun()');
let sPad = before, padPt = null, padTries = 0;
// fresh run: the start room's neighbours are open and monsters are >=5 away, so the pad click is
// measured as a move. A bump attack (monsters can close in within a few turns) still spends a
// turn, so re-measure on a clean floor rather than accepting "steps rose" as a move.
while (padTries < 3 && sPad.pos.join(',') === before.pos.join(',')) {
  const d = await openDirOf();
  if (!d) break;
  padPt = await ptOf(`.pad button[data-dir="${d}"]`);
  await click(padPt);
  sPad = await ev('window.__spd()');
  padTries++;
}
const openDir2 = await openDirOf();
const VK = { up: 38, down: 40, left: 37, right: 39 };
await key(openDir2 === 'up' ? 'ArrowUp' : openDir2 === 'down' ? 'ArrowDown' : openDir2 === 'left' ? 'ArrowLeft' : 'ArrowRight', VK[openDir2]);
const sKey = await ev('window.__spd()');

// ---- 5) Wait costs a turn; nothing else changes ----
const waitPt = await ptOf('#wait');
await click(waitPt);
const sWait = await ev('window.__spd()');

// ---- 6) descend a floor through the port's own rules (real taps on the stairs cell) ----
await ev('window.__spd.boost(400, 40)');
let descTries = 0;
let sDesc = await ev('window.__spd()');
while (sDesc.depth === 1 && descTries < 200) {
  await ev(`(()=>{ const s = window.__spd(); return window.__spd.tapCell(s.stairs[0], s.stairs[1]); })()`);
  descTries++;
  if (descTries % 20 === 0) await sleep(60);
  sDesc = await ev('window.__spd()');
}
const shotDesc = await shot('shattered-descent-gate-descent');
T(`descend tries=${descTries} depth=${sDesc.depth} kills=${sDesc.kills}`);

// ---- 7) win: load depth 10, walk onto the amulet ----
await ev('window.__spd.setup(10)');
await ev('window.__spd.boost(400, 40)');
let winTries = 0;
let sWin = await ev('window.__spd()');
while (!sWin.over && winTries < 220) {
  await ev(`(()=>{ const s = window.__spd(); const am = s.items.find(i => i.kind === 'amulet'); return window.__spd.tapCell(am.r, am.c); })()`);
  winTries++;
  if (winTries % 20 === 0) await sleep(60);
  sWin = await ev('window.__spd()');
}
const winSheet = await sheet();
const shotWin = await shot('shattered-descent-gate-win');
T(`win tries=${winTries} over=${sWin.over} won=${sWin.won} sheet=${winSheet.title}`);

// ---- 8) lose: a monster parked next to a 3 hp player ends the run ----
await ev('window.__spd.setup(1)');
await ev('window.__spd.boost(3, 3)');
await ev(`window.__spd.spawnAdjacent('slime')`);
let loseTries = 0;
let sLose = await ev('window.__spd()');
while (!sLose.over && loseTries < 30) {
  await click(waitPt);
  loseTries++;
  sLose = await ev('window.__spd()');
}
const loseSheet = await sheet();
const shotLose = await shot('shattered-descent-gate-lose');
T(`lose tries=${loseTries} over=${sLose.over} why=${sLose.why} sheet=${loseSheet.title}`);

// ---- 9) restart from the sheet's own button ----
const overBtn = await ptOf('#overBtn');
await click(overBtn);
await sleep(400);
const sNew = await ev('window.__spd()');

// ---- 9b) library art: a mid-fight frame on depth 3 (monster + HP bar + torch-lit room) ----
await ev('window.__spd.setup(3)');
await ev('window.__spd.boost(40, 4)');
await ev(`window.__spd.spawnAdjacent('wraith')`);
await ev(`(()=>{ const s = window.__spd();
  const m = s.monsters.slice().sort((a,b)=>Math.hypot(a.r-s.pos[0],a.c-s.pos[1])-Math.hypot(b.r-s.pos[0],b.c-s.pos[1]))[0];
  window.__spd.revealAll();
  return window.__spd.tapCell(m.r, m.c); })()`);
await sleep(500);
const shotArt = await shot('shattered-descent-hero');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await writeFile('/home/cluer/cloned-free-games/.queue/lib-art/Shattered Pixel Dungeon.png', await readFile(shotArt));
T('art shot ' + shotArt);

// ---- 10) portrait touch: one finger tap on an open neighbour ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
const tState = await ev('window.__spd()');
const tapPt = await tapPoint('window.__spd.gateStepPoint(0)', { touch: true });
await sleep(340);
const sTouch = await ev('window.__spd()');
const tCornerA = await ev(`window.__spd.tilePoint(0,0)`);
const tCornerB = await ev(`window.__spd.tilePoint(18,18)`);
const shotTouch = await shot('shattered-descent-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  boot: !!s0 && s0.depth === 1 && s0.steps === 0 && s0.over === false && s0.monsters.length >= 2 && s0.hp === s0.maxHp,
  boardTapSteps: sTap.steps === 1 && sTap.pos.join(',') !== s0.pos.join(',') && sTap.inputs >= 1 && !sTap.__err,
  doubleTapGuarded: sDup.dups >= 1 && sDup.steps <= sTap.steps + 1,
  padClickSteps: sPad.steps === 1 && sPad.pos.join(',') !== before.pos.join(',') && !!padPt,
  keySteps: sKey.steps > sPad.steps,
  waitCostsTurn: sWait.steps > sKey.steps,
  descended: sDesc.depth === 2 && sDesc.monsters.length >= 1 && sDesc.over === false,
  won: sWin.over === true && sWin.won === true && winSheet.open === true && /amulet/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && loseSheet.open === true && /died/i.test(loseSheet.title) && /slain/.test(sLose.why),
  restarted: sNew.over === false && sNew.depth === 1 && sNew.steps === 0 && sNew.hp === 20,
  touchSteps: sTouch.steps >= 1 && sTouch.pos.join(',') !== tState.pos.join(','),
  onScreen: inScreen(padPt, 1280, 800) && inScreen(p0, 1280, 800),
  touchOnScreen: inScreen(tapPt, 390, 844) && inScreen(tCornerA, 390, 844) && inScreen(tCornerB, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { depth: s0.depth, pos: s0.pos, hp: s0.hp, monsters: s0.monsters.length, stairs: s0.stairs, camera: s0.camera },
  sTap: { pos: sTap.pos, steps: sTap.steps, inputs: sTap.inputs }, p0,
  sDup: { steps: sDup.steps, dups: sDup.dups, inputs: sDup.inputs },
  sPad: { pos: sPad.pos, steps: sPad.steps }, sKey: { steps: sKey.steps }, sWait: { steps: sWait.steps },
  sDesc: { depth: sDesc.depth, kills: sDesc.kills, steps: sDesc.steps, hp: sDesc.hp },
  sWin: { depth: sWin.depth, over: sWin.over, won: sWin.won, gold: sWin.gold }, winSheet,
  sLose: { over: sLose.over, won: sLose.won, why: sLose.why }, loseSheet,
  sNew: { depth: sNew.depth, steps: sNew.steps, hp: sNew.hp, over: sNew.over },
  sTouch: { pos: sTouch.pos, steps: sTouch.steps }, tState: { pos: tState.pos },
  tCornerA, tCornerB,
  shots: [shotBoot, shotDesc, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
