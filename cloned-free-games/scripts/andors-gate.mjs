#!/usr/bin/env node
// Interaction gate for the Andor's Trail port: real in-frame pointer events on the board plane, real
// CDP clicks on the pad/buttons/sheets, keyboard, a full quest (accept from Elara → cave → shade →
// stone → back to Elara → win) driven through the port's own move rules, a death loss, restart, a
// quaff, and a portrait touch pass. Every assertion reads the page's state hook — a canvas that
// exists is not proof.
// usage: node andors-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/andors-trail/index.html';
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
const PROFILE = mkdtempSync('/tmp/at-gate-');
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
const dlg = async () => ev(`(()=>({open:document.getElementById('dlg').classList.contains('open'),title:document.getElementById('dlgT').textContent,body:document.getElementById('dlgP').textContent}))()`);

// In-frame tap: one pointerdown on the element under the point and one pointerup on the body (the
// port listens on the body for taps) — never twice, or the duplicate guard eats a real move.
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
const s0 = await ev('window.__andors()');
const shotBoot = await shot('andors-gate-boot');
T(`boot map=${s0.map} pos=${s0.pos} hp=${s0.hp} quest=${s0.quest} mobs=${s0.mobs.length} grid=${s0.cols}x${s0.rows} cam=${s0.camera}`);

// ---- 2) one real board tap steps the traveller and the trail answers ----
const p0 = await tapPoint('window.__andors.gateStepPoint(0)');
await sleep(320);
const sTap = await ev('window.__andors()');

// ---- 3) the same tap fired twice inside one tick is dropped by the guard ----
await ev(`(()=>{
  const p = window.__andors.gateStepPoint(1) || window.__andors.gateStepPoint(0);
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return true;
})()`);
await sleep(300);
const sDup = await ev('window.__andors()');

// ---- 4) a real click on the pad moves, a keyboard arrow moves ----
const openDirOf = () => ev(`(()=>{ const s = window.__andors();
  const nb = window.__andors.neighbours();
  for (const [d, dr, dc] of [['up',-1,0],['down',1,0],['left',0,-1],['right',0,1]])
    if (nb.some(([r,c]) => r === s.pos[0]+dr && c === s.pos[1]+dc)) return d;
  return null; })()`);
const before = await ev('window.__andors.newRun()');
let sPad = before, padPt = null, padTries = 0;
while (padTries < 3 && sPad.pos.join(',') === before.pos.join(',')) {
  const d = await openDirOf();
  if (!d) break;
  padPt = await ptOf(`.pad button[data-dir="${d}"]`);
  await click(padPt);
  sPad = await ev('window.__andors()');
  padTries++;
}
const openDir2 = await openDirOf();
const VK = { up: 38, down: 40, left: 37, right: 39 };
await key(openDir2 === 'up' ? 'ArrowUp' : openDir2 === 'down' ? 'ArrowDown' : openDir2 === 'left' ? 'ArrowLeft' : 'ArrowRight', VK[openDir2]);
const sKey = await ev('window.__andors()');

// ---- 5) Wait costs a turn; Quaff spends a draught and heals ----
const waitPt = await ptOf('#wait');
await click(waitPt);
const sWait = await ev('window.__andors()');
await ev('window.__andors.boost(10, 5)');
const preQ = await ev('window.__andors()');
const quaffPt = await ptOf('#quaff');
await click(quaffPt);
const sQuaff = await ev('window.__andors()');

// ---- 6) accept the quest with real input: walk to Elara, tap her, click Take the task ----
const nearElder = await ev(`(()=>{ let n = 0;
  while (n++ < 40) {
    const s = window.__andors();
    if (s.over) break;
    if (Math.abs(s.pos[0]-s.elder[0]) + Math.abs(s.pos[1]-s.elder[1]) === 1) break;
    window.__andors.tapCell(s.elder[0], s.elder[1]);
  }
  return window.__andors(); })()`);
const elderPt = await ev(`window.__andors.cellPoint(${nearElder.elder[0]}, ${nearElder.elder[1]})`);
const talkTap = await tapPoint(`window.__andors.cellPoint(${nearElder.elder[0]}, ${nearElder.elder[1]})`);
await sleep(320);
const dlgOpen = await dlg();
const dlgOkPt = await ptOf('#dlgOk');
await click(dlgOkPt);
await sleep(200);
const dlgAfter = await dlg();
const sQuest = await ev('window.__andors()');
const shotQuest = await shot('andors-gate-quest');
T(`quest accept: pos=${nearElder.pos} dlg=${dlgOpen.open}/${JSON.stringify(dlgOpen.body).slice(0, 48)} stage=${sQuest.quest} closed=${!dlgAfter.open}`);

// ---- 7) run the quest through the port's own move rule: cave → shade → stone → Elara ----
await ev('window.__andors.boost(80, 14)');
const drive = (targetExpr, doneExpr, limit) => ev(`(()=>{ let n = 0;
  while (n++ < ${limit}) {
    const s = window.__andors();
    if (!(${doneExpr})) break;
    const t = ${targetExpr};
    if (!t) break;
    window.__andors.tapCell(t[0], t[1]);
  }
  return window.__andors(); })()`);
const toCave = await drive('s.caveMouth', "s.map === 'world'", 200);
const inCave = await ev('window.__andors()');
const shotCave = await shot('andors-gate-cave');
T(`into cave: map=${inCave.map} pos=${inCave.pos} entry=${inCave.caveEntry} shade=${
  JSON.stringify(inCave.mobs.filter((m) => m.kind === 'shade'))}`);
const fight = await ev(`(()=>{ let n = 0;
  while (n++ < 60) {
    const s = window.__andors();
    if (s.over) break;
    const sh = s.mobs.find((m) => m.kind === 'shade');
    if (!sh) break;
    if (window.__andors().hp <= 12) { window.__andors.quaff(); continue; }
    window.__andors.tapCell(sh.r, sh.c);
  }
  return window.__andors(); })()`);
const stoneRun = await drive('s.relic', "s.map === 'cave' && !s.stone", 60);
const sStone = await ev('window.__andors()');
T(`stone: shadeAlive=${fight.mobs.some((m) => m.kind === 'shade')} stone=${sStone.stone} stage=${sStone.quest} hp=${sStone.hp}`);
const back = await ev(`(()=>{ let n = 0;
  while (n++ < 60 && window.__andors().map === 'cave' && !window.__andors().over) {
    const s = window.__andors(); window.__andors.tapCell(s.caveExit[0], s.caveExit[1]);
  }
  return window.__andors(); })()`);
const home = await ev(`(()=>{ let n = 0;
  while (n++ < 220) {
    const s = window.__andors();
    if (s.over || s.map !== 'world') break;
    if (Math.abs(s.pos[0]-s.elder[0]) + Math.abs(s.pos[1]-s.elder[1]) <= 1) {
      window.__andors.tapCell(s.elder[0], s.elder[1]);
      if (window.__andors().quest === 3) break;
      continue;
    }
    window.__andors.tapCell(s.elder[0], s.elder[1]);
  }
  return window.__andors(); })()`);
const winSheet = await sheet();
const shotWin = await shot('andors-gate-win');
T(`win: map=${home.map} stage=${home.quest} stone=${home.stone} over=${home.over} won=${home.won} sheet=${winSheet.title}`);

// ---- 8) lose: a wolf parked next to a 3 hp traveller ends the run ----
await ev('window.__andors.setup(1)');
await ev('window.__andors.boost(3, 3)');
await ev(`window.__andors.spawnAdjacent('wolf')`);
let loseTries = 0;
let sLose = await ev('window.__andors()');
while (!sLose.over && loseTries < 30) {
  await click(waitPt);
  loseTries++;
  sLose = await ev('window.__andors()');
}
const loseSheet = await sheet();
const shotLose = await shot('andors-gate-lose');
T(`lose tries=${loseTries} over=${sLose.over} why=${sLose.why} sheet=${loseSheet.title}`);

// ---- 9) restart from the sheet's own button ----
const overBtn = await ptOf('#overBtn');
await click(overBtn);
await sleep(400);
const sNew = await ev('window.__andors()');

// ---- 9b) library art: the trail lit up, a wolf in the frame, torches on ----
await ev('window.__andors.setup(20261124)');
await ev('window.__andors.revealAll()');
await ev(`window.__andors.spawnAdjacent('wolf')`);
await ev(`(()=>{ const s = window.__andors();
  const m = s.mobs.slice().sort((a,b)=>Math.hypot(a.r-s.pos[0],a.c-s.pos[1])-Math.hypot(b.r-s.pos[0],b.c-s.pos[1]))[0];
  if (m) window.__andors.tapCell(m.r, m.c);
  return window.__andors(); })()`);
await sleep(500);
const shotArt = await shot('andors-trail-hero');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await writeFile("/home/cluer/cloned-free-games/.queue/lib-art/Andor's Trail.png", await readFile(shotArt));
T('art shot ' + shotArt);

// ---- 10) portrait touch: one finger tap on an open neighbour ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
const tState = await ev('window.__andors()');
const tapPt = await tapPoint('window.__andors.gateStepPoint(0)', { touch: true });
await sleep(340);
const sTouch = await ev('window.__andors()');
const tCornerA = await ev('window.__andors.cellPoint(0,0)');
const tCornerB = await ev(`window.__andors.cellPoint(${tState.rows - 1}, ${tState.cols - 1})`);
const shotTouch = await shot('andors-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  boot: !!s0 && s0.map === 'world' && s0.steps === 0 && s0.over === false && s0.hp === s0.maxHp &&
        s0.mobs.length >= 8 && s0.quest === 0 && s0.cols === 25 && s0.rows === 15 &&
        Math.hypot(...s0.camera) > 2 && s0.seen > 20,
  boardTapSteps: sTap.steps === 1 && sTap.pos.join(',') !== s0.pos.join(',') && sTap.inputs >= 1 && !sTap.__err,
  doubleTapGuarded: sDup.dups >= 1 && sDup.steps <= sTap.steps + 1,
  padClickSteps: sPad.steps === 1 && sPad.pos.join(',') !== before.pos.join(',') && !!padPt,
  keySteps: sKey.steps > sPad.steps,
  waitCostsTurn: sWait.steps > sKey.steps,
  quaffHeals: sQuaff.potions === preQ.potions - 1 && sQuaff.hp > preQ.hp,
  questAccepted: dlgOpen.open === true && /elara/i.test(dlgOpen.title) && !dlgAfter.open && sQuest.quest === 1,
  enteredCave: inCave.map === 'cave' && inCave.pos.join(',') === inCave.caveEntry.join(',') &&
               inCave.mobs.some((m) => m.kind === 'shade'),
  shadeFought: fight.mobs.some((m) => m.kind === 'shade') === false || fight.over,
  stoneTaken: sStone.stone === true && sStone.quest === 2,
  returned: back.map === 'world',
  won: home.over === true && home.won === true && home.quest === 3 && winSheet.open === true && /ember stone/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && loseSheet.open === true && /died/i.test(loseSheet.title) && /slain/.test(sLose.why),
  restarted: sNew.over === false && sNew.steps === 0 && sNew.hp === 24 && sNew.quest === 0 && sNew.map === 'world',
  touchSteps: sTouch.steps >= 1 && sTouch.pos.join(',') !== tState.pos.join(','),
  onScreen: inScreen(padPt, 1280, 800) && inScreen(p0, 1280, 800) && inScreen(elderPt, 1280, 800),
  touchOnScreen: inScreen(tapPt, 390, 844) && inScreen(tCornerA, 390, 844) && inScreen(tCornerB, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { map: s0.map, pos: s0.pos, hp: s0.hp, maxHp: s0.maxHp, mobs: s0.mobs.length, quest: s0.quest, camera: s0.camera, seen: s0.seen },
  sTap: { pos: sTap.pos, steps: sTap.steps, inputs: sTap.inputs }, p0,
  sDup: { steps: sDup.steps, dups: sDup.dups },
  sPad: { pos: sPad.pos, steps: sPad.steps }, sKey: { steps: sKey.steps }, sWait: { steps: sWait.steps },
  quaff: { before: { hp: preQ.hp, potions: preQ.potions }, after: { hp: sQuaff.hp, potions: sQuaff.potions } },
  talk: { nearElder: nearElder.pos, dlg: dlgOpen, stage: sQuest.quest },
  cave: { map: inCave.map, pos: inCave.pos, entry: inCave.caveEntry, exit: inCave.caveExit, relic: inCave.relic, shadeHp: (inCave.mobs.find((m) => m.kind === 'shade') || {}).hp },
  stone: { stone: sStone.stone, stage: sStone.quest, hp: sStone.hp, kills: sStone.kills },
  win: { over: home.over, won: home.won, stage: home.quest, gold: home.gold, level: home.level, sheet: winSheet },
  lose: { over: sLose.over, won: sLose.won, why: sLose.why, sheet: loseSheet },
  restart: { map: sNew.map, steps: sNew.steps, hp: sNew.hp, quest: sNew.quest },
  touch: { steps: sTouch.steps, pos: sTouch.pos, from: tState.pos }, tCornerA, tCornerB,
  shots: [shotBoot, shotQuest, shotCave, shotWin, shotLose, shotTouch, shotArt],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
