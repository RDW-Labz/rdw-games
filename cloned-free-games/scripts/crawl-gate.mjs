#!/usr/bin/env node
// Interaction gate for the Dungeon Crawl port: real in-frame pointer events on the board plane,
// real CDP clicks on the species sheet / pad / cast / quaff / wait / end-sheet buttons, keyboard
// arrows, the spell path, a descend driven through the port's own move rules, the Orb escape win,
// a death loss, restart, and a 390x844 touch pass. Every assertion reads the page's state hook.
// usage: node crawl-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/crawl/index.html';
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
const PROFILE = mkdtempSync('/tmp/crawl-gate-');
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

const click = async (pt, wait = 260) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(wait);
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
const sheetOf = async (id) => ev(`(()=>({open:document.getElementById('${id}').classList.contains('open'),title:(document.getElementById('${id}').querySelector('h2')||{}).textContent||''}))()`);

// In-frame tap on a cell: ONE pointerdown/pointerup pair on the element under the point
// (dispatching on both elementFromPoint and the canvas is two taps).
const tapPoint = async (expr, { touch = false } = {}) => ev(`(()=>{
  const p = ${expr}; if (!p) return {__err:'no point'};
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: '${touch ? 'touch' : 'mouse'}', button: 0, isPrimary: true,
              clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return p;
})()`);

// ---- 1) boot: the species sheet is up and a board is already dealt behind it ----
const s0 = await ev('window.__crawl()');
const pickSheet = await sheetOf('pick');
const shotBoot = await shot('crawl-gate-boot');
T(`boot depth=${s0.depth} hp=${s0.hp} monsters=${s0.monsters.length} pick=${pickSheet.open}`);

// ---- 2) the Class button opens the sheet and its own button starts the chosen run ----
await click(await ptOf('#character'), 320);
const pickOpen = await sheetOf('pick');
const elfBtn = await ptOf('#pick [data-sp="elf"]');
await click(elfBtn, 420);
const sElf = await ev('window.__crawl()');
const pickAfter = await sheetOf('pick');

// ---- 3) one real board tap steps the player and the dungeon answers ----
const p0 = await tapPoint('window.__crawl.gateStepPoint(0)');
await sleep(340);
const sTap = await ev('window.__crawl()');

// ---- 4) the same tap fired twice inside one tick is dropped by the guard ----
await ev(`(()=>{
  const p = window.__crawl.gateStepPoint(1) || window.__crawl.gateStepPoint(0);
  const el = document.elementFromPoint(p.x, p.y) || document.body;
  const o = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, clientX: p.x, clientY: p.y, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return true;
})()`);
await sleep(300);
const sDup = await ev('window.__crawl()');

// ---- 5) the spell: a caster's dart spends mp and wounds the nearest target ----
await ev('window.__crawl.newRun("elf")');
await ev(`window.__crawl.spawnAdjacent('gnoll')`);
const preCast = await ev('window.__crawl()');
const castPt = await ptOf('#cast');
await click(castPt, 320);
const postCast = await ev('window.__crawl()');

// ---- 6) quaff: a potion heals through the button ----
await ev('window.__crawl.newRun("human")');
await ev('window.__crawl.givePotion(2)');
await ev('window.__crawl.boost(8, 3)');
const preQuaff = await ev('window.__crawl()');
const quaffPt = await ptOf('#quaff');
await click(quaffPt, 320);
const postQuaff = await ev('window.__crawl()');

// ---- 7) pad click and keyboard arrow both move ----
const before = await ev('window.__crawl.newRun("human")');
const openDirOf = () => ev(`(()=>{ const s = window.__crawl();
  const nb = window.__crawl.neighbours();
  for (const [d, dr, dc] of [['up',-1,0],['down',1,0],['left',0,-1],['right',0,1]])
    if (nb.some(([r,c]) => r === s.pos[0]+dr && c === s.pos[1]+dc)) return d;
  return null; })()`);
let sPad = before, padPt = null, padTries = 0;
while (padTries < 3 && sPad.pos.join(',') === before.pos.join(',')) {
  const d = await openDirOf();
  if (!d) break;
  padPt = await ptOf(`.pad button[data-dir="${d}"]`);
  await click(padPt);
  sPad = await ev('window.__crawl()');
  padTries++;
}
const openDir2 = await openDirOf();
const VK = { up: 38, down: 40, left: 37, right: 39 };
await key(openDir2 === 'up' ? 'ArrowUp' : openDir2 === 'down' ? 'ArrowDown' : openDir2 === 'left' ? 'ArrowLeft' : 'ArrowRight', VK[openDir2]);
const sKey = await ev('window.__crawl()');

// ---- 8) descend a floor through the port's own move rules (real taps on the stairs cell) ----
await ev('window.__crawl.boost(400, 40)');
let descTries = 0;
let sDesc = await ev('window.__crawl()');
while (sDesc.depth === 1 && descTries < 240) {
  await ev(`(()=>{ const s = window.__crawl(); return window.__crawl.tapCell(s.stairs[0], s.stairs[1]); })()`);
  descTries++;
  if (descTries % 20 === 0) await sleep(60);
  sDesc = await ev('window.__crawl()');
}
const shotDesc = await shot('crawl-gate-descent');
T(`descend tries=${descTries} depth=${sDesc.depth} kills=${sDesc.kills}`);

// ---- 9) win: take the Orb on depth 5, then climb all the way out ----
await ev('window.__crawl.setup({ depth: 5, hp: 400 })');
await ev('window.__crawl.boost(400, 40)');
let orbTries = 0;
let sOrb = await ev('window.__crawl()');
while (!sOrb.hasOrb && orbTries < 240) {
  await ev(`(()=>{ const s = window.__crawl(); const o = s.orb; return o ? window.__crawl.tapCell(o[0], o[1]) : false; })()`);
  orbTries++;
  if (orbTries % 20 === 0) await sleep(60);
  sOrb = await ev('window.__crawl()');
}
const shotOrb = await shot('crawl-gate-orb');
let climbTries = 0;
let sWin = await ev('window.__crawl()');
while (!sWin.over && climbTries < 900) {
  await ev('window.__crawl.boost(400, 40)');
  await ev(`(()=>{ const s = window.__crawl(); return s.stairs ? window.__crawl.tapCell(s.stairs[0], s.stairs[1]) : false; })()`);
  climbTries++;
  if (climbTries % 25 === 0) await sleep(50);
  sWin = await ev('window.__crawl()');
}
const winSheet = await sheetOf('over');
const shotWin = await shot('crawl-gate-win');
T(`orb tries=${orbTries} climb=${climbTries} over=${sWin.over} won=${sWin.won} depth=${sWin.depth} sheet=${winSheet.title}`);

// ---- 10) lose: a monster parked next to a 3 hp player ends the run ----
await ev('window.__crawl.setup({ depth: 1, hp: 3 })');
await ev('window.__crawl.newRun("human")');
await ev('window.__crawl.boost(3, 3)');
await ev(`window.__crawl.spawnAdjacent('orc')`);
const waitPt = await ptOf('#wait');
let loseTries = 0;
let sLose = await ev('window.__crawl()');
while (!sLose.over && loseTries < 30) {
  await click(waitPt);
  loseTries++;
  sLose = await ev('window.__crawl()');
}
const loseSheet = await sheetOf('over');
const shotLose = await shot('crawl-gate-lose');
T(`lose tries=${loseTries} over=${sLose.over} why=${sLose.why} sheet=${loseSheet.title}`);

// ---- 11) restart from the sheet's own button ----
const overBtn = await ptOf('#overBtn');
await click(overBtn, 500);
const sNew = await ev('window.__crawl()');

// ---- 11b) library art: a lit depth-5 frame with the Orb and its dragon guard ----
await ev('window.__crawl.setup({ depth: 5, hp: 40 })');
await ev('window.__crawl.revealAll()');
await sleep(400);
const shotArt = await shot('crawl-hero');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await writeFile('/home/cluer/cloned-free-games/.queue/lib-art/Dungeon-Crawl-Stone-Soup.png', await readFile(shotArt));
T('art shot ' + shotArt);

// ---- 12) portrait touch: one finger tap on an open neighbour ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
const pickT = await sheetOf('pick');
// Headless Chromium can swallow the first mouse event after a metrics override: prime, then tap.
await click({ x: 8, y: 80 }, 200);
const tState = await ev('window.__crawl()');
const tapPt = await tapPoint('window.__crawl.gateStepPoint(0)', { touch: true });
await sleep(380);
const sTouch = await ev('window.__crawl()');
const tCornerA = await ev(`window.__crawl.tilePoint(0,0)`);
const tCornerB = await ev(`window.__crawl.tilePoint(20,20)`);
const shotTouch = await shot('crawl-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  bootBoardDealt: !!s0 && s0.depth === 1 && s0.steps === 0 && s0.over === false && s0.monsters.length >= 3 && s0.hp === s0.maxHp,
  bootPlayableNoModal: pickSheet.open === false,
  classSheetOpens: pickOpen.open === true && pickOpen.title.length > 0,
  speciesChosen: sElf.species === 'elf' && sElf.maxMp === 14 && pickAfter.open === false,
  boardTapSteps: sTap.steps === 1 && sTap.pos.join(',') !== sElf.pos.join(',') && sTap.inputs >= 1 && !sTap.__err,
  doubleTapGuarded: sDup.dups >= 1 && sDup.steps <= sTap.steps + 1,
  spellSpendsMp: postCast.casts === preCast.casts + 1 && postCast.mp === preCast.mp - 3,
  spellDamagesTarget: postCast.kills === preCast.kills + 1 || postCast.monsters.every((m) => m.kind !== 'gnoll') ||
    Math.min(...postCast.monsters.map((m) => m.hp)) < 9,
  quaffHeals: postQuaff.hp === Math.min(postQuaff.maxHp, preQuaff.hp + 8) && postQuaff.potions === preQuaff.potions - 1,
  padClickSteps: sPad.steps === 1 && sPad.pos.join(',') !== before.pos.join(',') && !!padPt,
  keySteps: sKey.steps > sPad.steps,
  descended: sDesc.depth === 2 && sDesc.over === false && sDesc.monsters.length >= 1,
  orbTaken: sOrb.hasOrb === true && sOrb.over === false,
  escapedWithOrb: sWin.over === true && sWin.won === true && sWin.escaped === true && winSheet.open === true && /orb/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && loseSheet.open === true && /died/i.test(loseSheet.title) && /slain/.test(sLose.why),
  restarted: sNew.over === false && sNew.depth === 1 && sNew.steps === 0 && sNew.hp === sNew.maxHp,
  touchPickAndStep: pickT.open === false && sTouch.steps >= 1 && sTouch.pos.join(',') !== tState.pos.join(','),
  onScreen: inScreen(padPt, 1280, 800) && inScreen(p0, 1280, 800) && inScreen(castPt, 1280, 800),
  touchOnScreen: inScreen(tapPt, 390, 844) && inScreen(tCornerA, 390, 844) && inScreen(tCornerB, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { depth: s0.depth, pos: s0.pos, hp: s0.hp, monsters: s0.monsters.length, camera: s0.camera },
  sElf: { species: sElf.species, hp: sElf.hp, mp: sElf.mp, maxMp: sElf.maxMp, spell: sElf.spell },
  sTap: { pos: sTap.pos, steps: sTap.steps, inputs: sTap.inputs }, p0,
  sDup: { steps: sDup.steps, dups: sDup.dups },
  preCast: { mp: preCast.mp, casts: preCast.casts, monsters: preCast.monsters.length },
  postCast: { mp: postCast.mp, casts: postCast.casts, kills: postCast.kills, monsters: postCast.monsters },
  preQuaff: { hp: preQuaff.hp, maxHp: preQuaff.maxHp, potions: preQuaff.potions },
  postQuaff: { hp: postQuaff.hp, potions: postQuaff.potions },
  sPad: { pos: sPad.pos, steps: sPad.steps }, sKey: { steps: sKey.steps },
  sDesc: { depth: sDesc.depth, kills: sDesc.kills, steps: sDesc.steps, hp: sDesc.hp },
  sOrb: { depth: sOrb.depth, hasOrb: sOrb.hasOrb, over: sOrb.over },
  sWin: { depth: sWin.depth, over: sWin.over, won: sWin.won, escaped: sWin.escaped, gold: sWin.gold, climbTries }, winSheet,
  sLose: { over: sLose.over, won: sLose.won, why: sLose.why }, loseSheet,
  sNew: { depth: sNew.depth, steps: sNew.steps, hp: sNew.hp, species: sNew.species, over: sNew.over },
  sTouch: { pos: sTouch.pos, steps: sTouch.steps }, tState: { pos: tState.pos },
  tCornerA, tCornerB,
  shots: [shotBoot, shotDesc, shotOrb, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
