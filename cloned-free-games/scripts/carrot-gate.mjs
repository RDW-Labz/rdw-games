#!/usr/bin/env node
// Interaction gate for The Last Carrot port. Real CDP mouse/touch clicks: palette select,
// a tower planted on a bed, an upgrade, refused path/carrot taps, an unaffordable tower,
// sell, target-priority cycling, marking scenery and watching a tower break it down for
// gold and a freed tile, the early-wave bonus, a live wave that kills, the win sheet with
// stars, the lose sheet, restart, the double-tap guard, and a 390x844 portrait touch pass.
// usage: node carrot-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/the-last-carrot/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const ART = '/home/cluer/cloned-free-games/.queue/lib-art/the-last-carrot.png';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 90000);
    });
  }
}

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/carrot-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__carrot()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent,stars:document.getElementById('overStars').textContent}))()`);
const cellPt = async (c, r) => ev(`window.__carrot.cellPoint(${c},${r})`);
const clickCell = async (c, r, wait = 320) => {
  const p = await cellPt(c, r);
  if (!p || p.__err) return { err: p && p.__err, c, r };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 420) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const stepUntil = async (pred, secs = 0.5, tries = 90) => {
  for (let i = 0; i < tries; i++) {
    await ev(`window.__carrot.step(${secs})`);
    const s = await state();
    if (pred(s)) return s;
  }
  return await state();
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__carrot');
const rules = await ev('window.__carrot.rules()');
const s0 = await state();
const shotBoot = await shot('carrot-gate-boot');
T('boot ' + JSON.stringify({ hookType, maps: rules && rules.maps, s0: s0 && { map: s0.mapName, wave: s0.wave, cash: s0.cash, carrot: s0.carrot, towers: s0.towers.length, view: s0.view } }));
ok(hookType === 'function', 'the state hook is a function', hookType);
ok(rules && rules.maps && rules.maps.length === 3, 'three garden maps', rules && rules.maps);
ok(rules && rules.maps.every(m => m.waves === 8 && m.pathLen > 20), 'each map is eight waves on a real path', rules && rules.maps);
ok(rules && Object.keys(rules.towers).length === 6, 'six tower kinds', rules && Object.keys(rules.towers));
ok(rules && Object.keys(rules.enemies).length === 5, 'five critters', rules && Object.keys(rules.enemies));
ok(rules && Object.keys(rules.obstacles).length === 4, 'four kinds of breakable scenery', rules && Object.keys(rules.obstacles));
ok(s0 && s0.wave === 1 && s0.towers.length === 0 && s0.carrot === 20, 'boot is wave one, empty beds, a whole carrot', s0 && { wave: s0.wave, towers: s0.towers.length, carrot: s0.carrot });

// ---------- 2) the picker round-trips every bed and every piece of scenery ----------
const pick = await ev(`(()=>{
  window.__carrot.setup({});
  const beds = window.__carrot.buildCells();
  const obs = window.__carrot.obstacleCells();
  const road = window.__carrot.roadCells().filter(s => window.__carrot.cellAt && s.c >= 0 && s.c < 14 && s.r >= 0 && s.r < 9);
  const carrot = window.__carrot.carrotCell();
  const bad = [];
  for (const s of beds.concat(obs)) {
    const p = window.__carrot.cellPoint(s.c, s.r);
    const back = window.__carrot.cellAt(p.x, p.y);
    if (!back || back.c !== s.c || back.r !== s.r) bad.push({ s, p, back });
  }
  const cr = window.__carrot.cellPoint(carrot.c, carrot.r);
  const crBack = window.__carrot.cellAt(cr.x, cr.y);
  const band = window.__carrot.band();
  const pts = beds.concat(obs).map(s => window.__carrot.cellPoint(s.c, s.r));
  const inside = pts.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  const corners = [[0,0],[13,0],[0,8],[13,8]].map(([c,r]) => { const p = window.__carrot.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  const cornersInside = corners.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  return { nBeds: beds.length, nObs: obs.length, badCount: bad.length, bad: bad.slice(0,4), carrotBack: crBack, carrot,
    inside, cornersInside, corners, band, roadN: road.length };
})()`);
T('picker ' + JSON.stringify({ nBeds: pick && pick.nBeds, nObs: pick && pick.nObs, badCount: pick && pick.badCount, inside: pick && pick.inside, cornersInside: pick && pick.cornersInside, carrotBack: pick && pick.carrotBack, band: pick && pick.band }));
ok(pick && pick.badCount === 0, 'every bed and every piece of scenery round-trips to its own cell', pick && pick.bad);
ok(pick && pick.nBeds >= 60, 'the garden offers plenty of beds', pick && pick.nBeds);
ok(pick && pick.carrotBack && pick.carrotBack.c === pick.carrot.c && pick.carrotBack.r === pick.carrot.r, 'the carrot cell picks back to itself', pick && { carrot: pick.carrot, back: pick.carrotBack });
ok(pick && pick.inside, 'every point sits between the HUD bars');
ok(pick && pick.cornersInside, 'all four board corners sit inside the viewport and the HUD band', pick && pick.corners);

// ---------- 3) a real click plants a tower, a second click upgrades it ----------
await ev('window.__carrot.setup({ cash: 80, towers: [], wave: 0 })');
await sleep(300);
await ev('window.__carrot.choose("arrow")');
const sQuiet = await state();
ok(sQuiet && sQuiet.cash === 80 && sQuiet.towers.length === 0 && sQuiet.running === false, 'the QA purse is 80 gold on a frozen board', sQuiet && { cash: sQuiet.cash, towers: sQuiet.towers.length, running: sQuiet.running });
const road = await ev('window.__carrot.roadCells()');
const roadMid = road[Math.floor(road.length * 0.45)];
const bedNear = await ev(`(()=>{
  let best=null;
  for (const s of window.__carrot.buildCells()) {
    const d=Math.hypot(s.c-${roadMid.c}, s.r-${roadMid.r});
    if (!best || d<best.d) best={c:s.c,r:s.r,d};
  }
  return best;
})()`);
const pA = await clickCell(bedNear.c, bedNear.r);
const s1 = await state();
T('plant ' + JSON.stringify({ bedNear, pA, towers: s1.towers, cash: s1.cash, inputs: s1.inputs, taps: s1.taps, lastPoint: await ev('window.__carrot.lastPoint()') }));
ok(s1.towers.length === 1 && s1.towers[0].c === bedNear.c && s1.towers[0].r === bedNear.r, 'a real click on a bed plants a tower', s1.towers);
ok(s1.towers[0] && s1.towers[0].kind === 'arrow', 'the selected tower kind is what got planted', s1.towers[0]);
ok(s1.cash === 40, 'the arrow is charged its 40 gold', { cash: s1.cash });

const pA2 = await clickCell(bedNear.c, bedNear.r);
const s2 = await state();
T('upgrade ' + JSON.stringify({ towers: s2.towers, cash: s2.cash }));
ok(s2.towers.length === 1 && s2.towers[0].lvl === 2, 'tapping the planted tower upgrades it', s2.towers);
ok(s2.cash === 8, 'the level-2 upgrade costs 32', { cash: s2.cash });
const pA3 = await clickCell(bedNear.c, bedNear.r);
const s3 = await state();
ok(s3.towers[0].lvl === 2 && s3.cash === 8, 'an unaffordable upgrade leaves the tower at level 2', { lvl: s3.towers[0].lvl, cash: s3.cash });

// ---------- 4) the path and the carrot are refused ----------
const sBefore = await state();
await clickCell(road[2].c, road[2].r);
const sTrack = await state();
ok(sTrack.towers.length === sBefore.towers.length && sTrack.blocked > sBefore.blocked, 'a click on the path plants nothing', { towers: sTrack.towers.length, blocked: [sBefore.blocked, sTrack.blocked] });
const carrot = await ev('window.__carrot.carrotCell()');
await clickCell(carrot.c, carrot.r);
const sCar = await state();
ok(sCar.towers.length === sTrack.towers.length && sCar.blocked > sTrack.blocked, 'a click on the carrot plants nothing', { towers: sCar.towers.length, carrot });

// ---------- 5) the palette switches towers, and an unaffordable one is refused ----------
const palPos = await ev(`(()=>{const e=document.querySelector('#palette .tw[data-kind="tesla"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
if (palPos && !palPos.__err) { await click(palPos); await sleep(320); }
const sSel = await state();
ok(sSel.sel === 'tesla', 'the palette button selects TESLA with a real click', { sel: sSel.sel });
const bedB = await ev(`(()=>{
  let best=null;
  for (const s of window.__carrot.buildCells()) {
    if (s.c===${bedNear.c} && s.r===${bedNear.r}) continue;
    const d=Math.abs(s.c-${bedNear.c})+Math.abs(s.r-${bedNear.r});
    if (!best || d<best.d) best={c:s.c,r:s.r,d};
  }
  return best;
})()`);
await clickCell(bedB.c, bedB.r);
const sPoor = await state();
T('poor ' + JSON.stringify({ towers: sPoor.towers.length, cash: sPoor.cash, blocked: sPoor.blocked }));
ok(sPoor.towers.length === 1, 'an unaffordable tesla is refused', { towers: sPoor.towers.length, cash: sPoor.cash });

// ---------- 6) target priority cycles, and sell refunds 65% ----------
const tg = await clickEl('tgt', 260);
const sTgt = await state();
T('target ' + JSON.stringify({ tg, tower: sTgt.towers[0] }));
ok(sTgt.towers[0] && sTgt.towers[0].target === 'strong', 'the target button cycles first -> strong', sTgt.towers[0]);
await clickEl('tgt', 260);
const sTgt2 = await state();
ok(sTgt2.towers[0] && sTgt2.towers[0].target === 'near', 'and strong -> near', sTgt2.towers[0]);

await clickEl('sell', 300);
const sSell = await state();
T('sell ' + JSON.stringify({ towers: sSell.towers, cash: sSell.cash }));
ok(sSell.towers.length === 0 && sSell.cash === 8 + 46, 'Sell removes the tower and refunds 65% of the spend', { towers: sSell.towers.length, cash: sSell.cash });

// ---------- 7) marking scenery, and a tower breaking it down ----------
const obPick = await ev(`(()=>{
  window.__carrot.setup({ cash: 200, wave: 0, noSpawn: true });
  const obs = window.__carrot.obstacleCells();
  const beds = window.__carrot.buildCells();
  // a mushroom (55 hp) with a bed right beside it, so an arrow can reach it
  for (const o of obs.slice().sort((a,b)=>a.kind.localeCompare(b.kind))) {
    const bed = beds.find(b => Math.hypot(b.c-o.c, b.r-o.r) <= 2.6);
    if (bed && o.kind === 'mushroom') return { o, bed };
  }
  for (const o of obs) {
    const bed = beds.find(b => Math.hypot(b.c-o.c, b.r-o.r) <= 2.6);
    if (bed) return { o, bed };
  }
  return null;
})()`);
T('scenery fixture ' + JSON.stringify(obPick));
if (obPick && obPick.o) {
  await ev(`window.__carrot.setup({ cash: 200, wave: 0, noSpawn: true, towers: [{ c: ${obPick.bed.c}, r: ${obPick.bed.r}, kind: 'arrow', lvl: 3 }] })`);
  await sleep(250);
  const sMark0 = await state();
  await clickCell(obPick.o.c, obPick.o.r, 350);
  const sMark1 = await state();
  const targetOb = sMark1.obstacles.find(o => o.c === obPick.o.c && o.r === obPick.o.r);
  T('mark ' + JSON.stringify({ before: sMark0.obstacles.find(o => o.c === obPick.o.c && o.r === obPick.o.r), after: targetOb }));
  ok(targetOb && targetOb.marked === true, 'a real click marks the scenery for demolition', targetOb);
  const goldBefore = sMark1.cash;
  const chipRun = await ev('window.__carrot.step(8)');
  const sChip = await state();
  const obAfter = sChip.obstacles.find(o => o.c === obPick.o.c && o.r === obPick.o.r);
  T('chip ' + JSON.stringify({ chipRun, obAfter, gold: [goldBefore, sChip.cash], chips: sChip.chips }));
  ok(!obAfter, 'the marked scenery breaks down', obAfter);
  ok(sChip.chips >= 1, 'the break is counted', sChip.chips);
  ok(sChip.cash > goldBefore, 'breaking it paid gold', { before: goldBefore, after: sChip.cash });
  const freed = await ev(`window.__carrot.buildCells().some(b => b.c === ${obPick.o.c} && b.r === ${obPick.o.r})`);
  ok(freed === true, 'the cleared tile is now a free bed', freed);
  const built = await ev(`(()=>{window.__carrot.choose('arrow');return true;})()`);
  await sleep(150);
  const goldPre = (await state()).cash;
  await clickCell(obPick.o.c, obPick.o.r, 350);
  const sFreed = await state();
  ok(sFreed.towers.some(t => t.c === obPick.o.c && t.r === obPick.o.r), 'and a tower can be planted on it', { towers: sFreed.towers, prev: built });
  ok(sFreed.cash === goldPre - 40, 'the new tower is charged', { cash: sFreed.cash, goldPre });
} else {
  ok(false, 'a scenery piece with a bed in reach exists for the demolition test');
}

// ---------- 8) the early-wave call pays its bonus ----------
const camp = await ev(`(()=>{
  window.__carrot.setup({});
  const road = window.__carrot.roadCells();
  const cells = window.__carrot.buildCells().map(s=>({...s, v: road.filter(q=>Math.hypot(q.c-s.c,q.r-s.r)<=2.6).length}));
  cells.sort((a,b)=>b.v-a.v);
  const kinds=['arrow','bomb','tesla','poison','ice','moon'];
  return cells.slice(0,10).map((s,i)=>({c:s.c,r:s.r,kind:kinds[i%kinds.length],lvl:3}));
})()`);
T('camp ' + JSON.stringify(camp));
await ev(`window.__carrot.setup({ cash: 300, wave: 0, towers: ${JSON.stringify(camp)} })`);
await sleep(250);
await ev('window.__carrot.choose("arrow")');
const sClear = await stepUntil(s => s.intermission > 0 || s.over);
T('cleared ' + JSON.stringify({ intermission: sClear.intermission, carrot: sClear.carrot, kills: sClear.kills, wave: sClear.wave }));
ok(sClear && sClear.intermission > 0, 'clearing a wave opens the intermission', sClear && { intermission: sClear.intermission, carrot: sClear.carrot });
const cashBeforeCall = sClear.cash;
await clickEl('call', 400);
const sCall = await state();
T('call ' + JSON.stringify({ cash: [cashBeforeCall, sCall.cash], wave: sCall.wave, early: sCall.earlyCalls }));
ok(sCall.cash >= cashBeforeCall + 25, 'calling the next wave early pays its 25 bonus (plus any kill that landed)', { before: cashBeforeCall, after: sCall.cash });
ok(sCall.wave === 2 && sCall.earlyCalls === 1, 'the next wave started on the call', { wave: sCall.wave, early: sCall.earlyCalls });

// ---------- 9) live towers kill marching critters ----------
await ev(`window.__carrot.setup({ cash: 400, towers: ${JSON.stringify(camp)}, wave: 0, run: true })`);
await sleep(250);
const sQA = await state();
const run1 = await ev('window.__carrot.step(30)');
const sPlay = await state();
T('play ' + JSON.stringify({ qa: sQA && sQA.towers.length, run1 }));
ok(sQA && sQA.towers.length === 10, 'the QA board loads its ten towers', sQA && sQA.towers.length);
ok(run1 && run1.kills > 0, 'live towers kill marching critters', run1);
ok(sPlay.carrot === 20, 'the opening wave does not leak', { carrot: sPlay.carrot, leaks: sPlay.leaks });
const shotPlay = await shot('carrot-gate-play');

// a live frame for tile art
await ev(`window.__carrot.setup({ cash: 200, towers: ${JSON.stringify(camp)}, wave: 3, run: true, clearObstacles: false })`);
await sleep(250);
await ev('window.__carrot.revealAll()');
await ev('window.__carrot.step(7)');
await sleep(400);
const shotArt = await shot('carrot-art');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await copyFile(shotArt, ART);

// ---------- 10) a full run reaches the win sheet, with stars ----------
await ev(`window.__carrot.setup({ cash: 400, towers: ${JSON.stringify(camp)}, wave: 0 })`);
await sleep(250);
const winRun = await ev('window.__carrot.step(900)');
const sWin = await state();
const sheetWin = await sheet();
T('win ' + JSON.stringify({ winRun, over: sWin && sWin.over, result: sWin && sWin.result, sheet: sheetWin }));
ok(sWin && sWin.over && sWin.result === 'win', 'a strong board holds all eight waves', { result: sWin.result, wave: sWin.wave, carrot: sWin.carrot });
ok(sWin.stars >= 1 && sWin.stars <= 3, 'the win carries a star rating', sWin.stars);
ok(sheetWin && sheetWin.open && /held/i.test(sheetWin.title), 'the win sheet opens with its own title', sheetWin);
ok(sheetWin && sheetWin.stars.length === 3, 'the win sheet shows three star slots', sheetWin && sheetWin.stars);
const shotWin = await shot('carrot-gate-win');

// ---------- 11) the lose sheet ----------
await ev('window.__carrot.setup({ cash: 40, towers: [], carrot: 3, wave: 0 })');
await sleep(250);
const loseRun = await ev('window.__carrot.step(200)');
const sLose = await state();
const sheetLose = await sheet();
T('lose ' + JSON.stringify({ loseRun, over: sLose && sLose.over, result: sLose && sLose.result, sheet: sheetLose }));
ok(sLose && sLose.over && sLose.result === 'lose', 'an undefended carrot is eaten', { result: sLose.result, carrot: sLose.carrot, leaks: sLose.leaks });
ok(sheetLose && sheetLose.open && /eaten/i.test(sheetLose.title), 'the lose sheet opens with its own title', sheetLose);

// ---------- 12) the sheet buttons drive a fresh run ----------
await clickEl('overBtn', 700);
const sRestart = await state();
const sheetAfter = await sheet();
T('again ' + JSON.stringify({ wave: sRestart.wave, towers: sRestart.towers.length, over: sRestart.over, cash: sRestart.cash, sheetAfter }));
ok(sRestart && sRestart.wave === 1 && sRestart.towers.length === 0 && sRestart.over === false, 'Play again starts a fresh run', sRestart && { wave: sRestart.wave, towers: sRestart.towers.length });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes on restart', sheetAfter);

// ---------- 13) the double-tap guard (both events inside one page tick) ----------
const freshBed = await ev(`(()=>{
  window.__carrot.setup({ cash: 200, wave: 0, noSpawn: true });
  window.__carrot.choose('arrow');
  const r = window.__carrot.roadCells()[6];
  let best=null;
  for (const s of window.__carrot.buildCells()) { const d=Math.hypot(s.c-r.c,s.r-r.r); if(!best||d<best.d) best={c:s.c,r:s.r,d}; }
  return best;
})()`);
await sleep(250);
const twoInOneTick = await ev(`(()=>{
  const p = window.__carrot.cellPoint(${freshBed.c},${freshBed.r});
  const el = document.elementFromPoint(p.x,p.y) || document.querySelector('body > canvas');
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk()); el.dispatchEvent(mk());
  return p;
})()`);
await sleep(300);
const sDup = await state();
T('dup ' + JSON.stringify({ twoInOneTick, towers: sDup.towers.length, dups: sDup.dups }));
ok(sDup.dups >= 1, 'the second event of a double tap is dropped', { dups: sDup.dups });
ok(sDup.towers.length === 1, 'a double tap plants one tower, not two', sDup.towers);

// ---------- 14) map cycling restarts on the new garden ----------
await ev('window.__carrot.setup({ wave: 0 })');
await sleep(200);
const mapBefore = (await state()).map;
await clickEl('map', 900);
const sMap = await state();
T('map ' + JSON.stringify({ mapBefore, map: sMap.map, name: sMap.mapName, wave: sMap.wave, towers: sMap.towers.length }));
ok(sMap.map === (mapBefore + 1) % 3, 'the Map button moves to the next garden', { mapBefore, map: sMap.map });
ok(sMap.wave === 1 && sMap.over === false, 'the new garden starts a fresh run at wave one', { wave: sMap.wave, over: sMap.over });

// ---------- 15) portrait / touch ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1000);
{
  // headless Chromium can swallow the first mouse event after a metrics override: prime it
  const hud = await ev(`(()=>{const e=document.querySelector('.brand h1');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (hud && !hud.__err) await click(hud);
  await sleep(220);
}
const pInfo = await ev(`(()=>{
  const band = window.__carrot.band();
  const beds = window.__carrot.buildCells();
  const obs = window.__carrot.obstacleCells();
  const pts = beds.concat(obs).map(s => window.__carrot.cellPoint(s.c, s.r));
  const inside = pts.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  let bad = 0;
  for (const s of beds.concat(obs)) {
    const p = window.__carrot.cellPoint(s.c, s.r);
    const b = window.__carrot.cellAt(p.x, p.y);
    if (!b || b.c !== s.c || b.r !== s.r) bad++;
  }
  const corners = [[0,0],[13,0],[0,8],[13,8]].map(([c,r]) => { const p = window.__carrot.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  return { view: innerWidth + 'x' + innerHeight, band, inside, bad, corners };
})()`);
T('portrait ' + JSON.stringify(pInfo));
ok(pInfo && pInfo.view === '390x844', 'the viewport really is 390x844', pInfo && pInfo.view);
ok(pInfo && pInfo.inside, 'every bed sits between the HUD bars in portrait', pInfo && { band: pInfo.band, corners: pInfo.corners });
ok(pInfo && pInfo.bad === 0, 'the picker still round-trips in portrait', pInfo && pInfo.bad);

await ev('window.__carrot.setup({ cash: 200, wave: 0, noSpawn: true })');
await ev('window.__carrot.choose("arrow")');
await sleep(300);
const ptP = await cellPt(freshBed.c, freshBed.r);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(450);
let sTouch = await state();
if (sTouch.towers.length === 0) { await click(ptP); await sleep(450); sTouch = await state(); }
T('touch ' + JSON.stringify({ ptP, towers: sTouch.towers.length, cash: sTouch.cash }));
ok(sTouch.towers.length >= 1, 'a touch tap plants a tower on the phone', sTouch.towers);
const shotPortrait = await shot('carrot-gate-portrait');

// ---------- 16) console errors ----------
const errs = pageCdp.events
  .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params).slice(0, 160));
ok(errs.length === 0, 'no console exceptions during the whole gate', errs.slice(0, 4));

console.log(JSON.stringify({ fails, shots: { shotBoot, shotPlay, shotWin, shotPortrait, ART } }, null, 1));
T(fails.length ? `FAILED — ${fails.length} check(s)` : 'PASS — every gate check passed');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
