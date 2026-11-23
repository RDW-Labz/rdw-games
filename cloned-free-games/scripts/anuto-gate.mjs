#!/usr/bin/env node
// Interaction gate for the Anuto TD port. Real CDP mouse clicks: palette -> plot placement,
// upgrade, a refused road click, a refused far-ground click, an unaffordable tower, sell,
// the early-wave bonus, a live wave that kills, the win sheet, the lose sheet, restart,
// the double-tap guard, and a 390x844 portrait touch pass.
// usage: node anuto-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/anuto-td/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
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
const PROFILE = mkdtempSync('/tmp/anuto-gate-');
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
const state = () => ev('window.__anuto()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const cellPt = async (c, r) => ev(`window.__anuto.cellPoint(${c},${r})`);
const clickCell = async (c, r, wait = 320) => {
  const p = await cellPt(c, r);
  if (!p || p.__err) return { err: p && p.__err, c, r };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 420) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
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
// advance the sim in small beats and stop the moment the state says so — a big step(40)
// blows straight through an intermission and auto-starts the next wave
const stepUntil = async (pred, secs = 0.5, tries = 90) => {
  for (let i = 0; i < tries; i++) {
    await ev(`window.__anuto.step(${secs})`);
    const s = await state();
    if (pred(s)) return s;
  }
  return await state();
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__anuto');
const rules = await ev('window.__anuto.rules()');
const s0 = await state();
const shotBoot = await shot('anuto-gate-boot');
T('boot ' + JSON.stringify({ hookType, rules: rules && { W: rules.W, H: rules.H, waves: rules.waves, plots: rules.plots, pathLen: rules.pathLen }, s0: s0 && { wave: s0.wave, cash: s0.cash, base: s0.base, towers: s0.towers.length, view: s0.view } }));
ok(hookType === 'function', 'the state hook is a function', hookType);
ok(rules && rules.waves === 12 && rules.W === 14 && rules.H === 9, 'a 14x9 map with 12 waves', rules && { W: rules.W, H: rules.H, waves: rules.waves });
ok(rules && rules.pathLen > 20, 'the road is a real march', rules && rules.pathLen);
ok(rules && rules.plots > 30, 'plots line the road', rules && rules.plots);
ok(s0 && s0.wave === 1 && s0.towers.length === 0 && s0.base === 20, 'boot is wave one, empty plots, full base', s0 && { wave: s0.wave, towers: s0.towers.length, base: s0.base });

// ---------- 2) the picker round-trips every plot ----------
const pick = await ev(`(()=>{
  const plots = window.__anuto.plotCells();
  let bad = [];
  for (const s of plots) {
    const p = window.__anuto.cellPoint(s.c, s.r);
    const back = window.__anuto.cellAt(p.x, p.y);
    if (!back || back.c !== s.c || back.r !== s.r) bad.push({ s, p, back });
  }
  const band = window.__anuto.band();
  const inside = plots.every(s => { const p = window.__anuto.cellPoint(s.c, s.r); return p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx; });
  const corners = [[0,0],[13,0],[0,8],[13,8]].map(([c,r]) => { const p = window.__anuto.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  const cornersInside = corners.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  return { bad: bad.slice(0, 5), badCount: bad.length, inside, cornersInside, corners, band, n: plots.length };
})()`);
T('picker ' + JSON.stringify({ n: pick && pick.n, badCount: pick && pick.badCount, inside: pick && pick.inside, cornersInside: pick && pick.cornersInside, band: pick && pick.band }));
ok(pick && pick.badCount === 0, 'every plot point resolves back to its own cell', pick && pick.bad);
ok(pick && pick.inside, 'every plot sits between the HUD bars');
ok(pick && pick.cornersInside, 'all four board corners sit inside the viewport and the HUD band', pick && pick.corners);

// ---------- 3) a real click places a tower, a second click upgrades it ----------
// a frozen QA purse: no live wave, so a kill cannot top the cash up between clicks
await ev('window.__anuto.setup({ cash: 80, towers: [], wave: 0 })');
await sleep(300);
const sQuiet = await state();
ok(sQuiet && sQuiet.cash === 80 && sQuiet.towers.length === 0 && sQuiet.running === false, 'the QA purse is 80 cash on a frozen board', sQuiet && { cash: sQuiet.cash, towers: sQuiet.towers.length, running: sQuiet.running });
const road = await ev('window.__anuto.roadCells()');
const roadMid = road[Math.floor(road.length * 0.45)];
const plotNear = await ev(`(()=>{
  let best=null;
  for (const s of window.__anuto.plotCells()) {
    const d=Math.hypot(s.c-${roadMid.c}, s.r-${roadMid.r});
    if (!best || d<best.d) best={c:s.c,r:s.r,d};
  }
  return best;
})()`);
const pA = await clickCell(plotNear.c, plotNear.r);
const s1 = await state();
T('place ' + JSON.stringify({ plotNear, pA, towers: s1.towers, cash: s1.cash, inputs: s1.inputs, taps: s1.taps, lastPoint: await ev('window.__anuto.lastPoint()') }));
ok(s1.towers.length === 1 && s1.towers[0].c === plotNear.c && s1.towers[0].r === plotNear.r, 'a real click on a plot places a tower', s1.towers);
ok(s1.towers[0] && s1.towers[0].kind === 'gun', 'the selected tower kind is what got built', s1.towers[0]);
ok(s1.cash === 80 - 40, 'the gun is charged its 40 cash', { cash: s1.cash });

const pA2 = await clickCell(plotNear.c, plotNear.r);
const s2 = await state();
T('upgrade ' + JSON.stringify({ towers: s2.towers, cash: s2.cash, inputs: s2.inputs }));
ok(s2.towers.length === 1 && s2.towers[0].lvl === 2, 'tapping the built tower upgrades it', s2.towers);
ok(s2.cash === 8, 'the upgrade is charged', { cash: s2.cash });

// ---------- 4) the road and bare ground are refused ----------
const sBefore = await state();
await clickCell(road[2].c, road[2].r);
const sTrack = await state();
ok(sTrack.towers.length === sBefore.towers.length && sTrack.blocked > sBefore.blocked, 'a click on the road places nothing', { towers: sTrack.towers.length, blocked: [sBefore.blocked, sTrack.blocked] });
const far = await ev(`(()=>{
  for (let r=0;r<9;r++) for (let c=0;c<14;c++) {
    const p = window.__anuto.plotCells().some(s=>s.c===c&&s.r===r);
    const road = window.__anuto.roadCells().some(s=>s.c===c&&s.r===r);
    if (!p && !road && c>0 && c<13 && r>0 && r<8) return {c,r};
  }
  return null;
})()`);
await clickCell(far.c, far.r);
const sFar = await state();
ok(sFar.towers.length === sTrack.towers.length && sFar.blocked > sTrack.blocked, 'bare ground away from the road is refused', { towers: sFar.towers.length, far });

// ---------- 5) the palette switches towers, and an unaffordable one is refused ----------
const palPos = await ev(`(()=>{const e=document.querySelector('#palette .tw[data-kind="cannon"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
if (palPos) { await click(palPos); await sleep(320); }
const sSel = await state();
ok(sSel.sel === 'cannon', 'the palette button selects CANNON with a real click', { sel: sSel.sel });
const plotB = await ev(`(()=>{
  let best=null;
  for (const s of window.__anuto.plotCells()) {
    if (s.c===${plotNear.c} && s.r===${plotNear.r}) continue;
    const d=Math.abs(s.c-${plotNear.c})+Math.abs(s.r-${plotNear.r});
    if (!best || d<best.d) best={c:s.c,r:s.r,d};
  }
  return best;
})()`);
await clickCell(plotB.c, plotB.r);
const sPoor = await state();
T('poor ' + JSON.stringify({ towers: sPoor.towers.length, cash: sPoor.cash, blocked: sPoor.blocked }));
ok(sPoor.towers.length === 1, 'an unaffordable cannon is refused', { towers: sPoor.towers.length, cash: sPoor.cash });

// ---------- 6) sell refunds half ----------
await clickEl('sell', 300);
const sSell = await state();
T('sell ' + JSON.stringify({ towers: sSell.towers, cash: sSell.cash }));
ok(sSell.towers.length === 0 && sSell.cash === 8 + 36, 'Sell removes the tower and refunds half its spend', { towers: sSell.towers.length, cash: sSell.cash });

// ---------- 7) the early-wave call pays its bonus ----------
await ev(`window.__anuto.setup({ cash: 300, wave: 0, towers: [
  { c: ${plotNear.c}, r: ${plotNear.r}, kind: 'cannon', lvl: 3 }
] })`);
await sleep(250);
const sClear = await stepUntil(s => s.intermission > 0 || s.over);
T('cleared ' + JSON.stringify({ intermission: sClear.intermission, base: sClear.base, kills: sClear.kills, wave: sClear.wave }));
ok(sClear && sClear.intermission > 0, 'clearing a wave opens the intermission', sClear && { intermission: sClear.intermission, base: sClear.base });
const cashBeforeCall = sClear.cash;
await clickEl('call', 400);
const sCall = await state();
T('call ' + JSON.stringify({ cash: [cashBeforeCall, sCall.cash], wave: sCall.wave, early: sCall.earlyCalls }));
ok(sCall.cash === cashBeforeCall + 25, 'calling the next wave early pays 25', { before: cashBeforeCall, after: sCall.cash });
ok(sCall.wave === 2 && sCall.earlyCalls === 1, 'the next wave started on the call', { wave: sCall.wave, early: sCall.earlyCalls });

// ---------- 8) live towers kill marching machines ----------
const camp = await ev(`(()=>{
  const road = window.__anuto.roadCells();
  const plots = window.__anuto.plotCells().map(s=>({...s, v: road.filter(q=>Math.hypot(q.c-s.c,q.r-s.r)<=2.4).length}));
  plots.sort((a,b)=>b.v-a.v);
  return plots.slice(0,10).map(s=>({c:s.c,r:s.r,kind:'cannon',lvl:3}));
})()`);
await ev(`window.__anuto.setup({ cash: 400, towers: ${JSON.stringify(camp)}, wave: 0, run: true })`);
await sleep(250);
const sQA = await state();
const run1 = await ev('window.__anuto.step(30)');
const sPlay = await state();
T('play ' + JSON.stringify({ qa: sQA && sQA.towers.length, run1 }));
ok(sQA && sQA.towers.length === 10, 'the QA board loads its ten towers', sQA && sQA.towers.length);
ok(run1 && run1.kills > 0, 'live towers kill marching machines', run1);
ok(sPlay.base === 20, 'the opening wave does not leak', { base: sPlay.base, leaks: sPlay.leaks });
const shotPlay = await shot('anuto-gate-play');

// a live frame for tile art (the art phase reattaches shots already in .queue/lib-art)
await ev(`window.__anuto.setup({ cash: 200, towers: ${JSON.stringify(camp)}, wave: 2, run: true })`);
await sleep(250);
await ev('window.__anuto.step(9)');
await sleep(400);
const shotArt = await shot('anuto-art');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await copyFile(shotArt, '/home/cluer/cloned-free-games/.queue/lib-art/anuto-td.png');

// ---------- 9) a full run reaches the win sheet ----------
await ev(`window.__anuto.setup({ cash: 400, towers: ${JSON.stringify(camp)}, wave: 0 })`);
await sleep(250);
const winRun = await ev('window.__anuto.step(800)');
const sWin = await state();
const sheetWin = await sheet();
T('win ' + JSON.stringify({ winRun, over: sWin && sWin.over, result: sWin && sWin.result, sheet: sheetWin }));
ok(sWin && sWin.over && sWin.result === 'win', 'a strong board holds all twelve waves', { result: sWin.result, wave: sWin.wave, base: sWin.base });
ok(sheetWin && sheetWin.open && /held/i.test(sheetWin.title), 'the win sheet opens with its own title', sheetWin);
const shotWin = await shot('anuto-gate-win');

// ---------- 10) the lose sheet ----------
await ev('window.__anuto.setup({ cash: 40, towers: [], base: 3, wave: 0 })');
await sleep(250);
const loseRun = await ev('window.__anuto.step(200)');
const sLose = await state();
const sheetLose = await sheet();
T('lose ' + JSON.stringify({ loseRun, over: sLose && sLose.over, result: sLose && sLose.result, sheet: sheetLose }));
ok(sLose && sLose.over && sLose.result === 'lose', 'an empty base is overrun', { result: sLose.result, base: sLose.base, leaks: sLose.leaks });
ok(sheetLose && sheetLose.open && /overrun/i.test(sheetLose.title), 'the lose sheet opens with its own title', sheetLose);

// ---------- 11) the sheet buttons drive a fresh run ----------
await clickEl('overBtn', 700);
const sRestart = await state();
const sheetAfter = await sheet();
T('again ' + JSON.stringify({ wave: sRestart.wave, towers: sRestart.towers.length, over: sRestart.over, cash: sRestart.cash, sheetAfter }));
ok(sRestart && sRestart.wave === 1 && sRestart.towers.length === 0 && sRestart.over === false, 'Play again starts a fresh run', sRestart && { wave: sRestart.wave, towers: sRestart.towers.length });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes on restart', sheetAfter);

// ---------- 12) the double-tap guard ----------
await ev('window.__anuto.setup({ cash: 200, wave: 0 })');
await sleep(200);
const twoInOneTick = await ev(`(()=>{
  const p = window.__anuto.cellPoint(${plotNear.c},${plotNear.r});
  const el = document.elementFromPoint(p.x,p.y) || document.querySelector('canvas');
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk()); el.dispatchEvent(mk());
  return p;
})()`);
await sleep(300);
const sDup = await state();
T('dup ' + JSON.stringify({ twoInOneTick, towers: sDup.towers.length, dups: sDup.dups }));
ok(sDup.dups >= 1, 'the second event of a double tap is dropped', { dups: sDup.dups });
ok(sDup.towers.length === 1, 'a double tap places one tower, not two', sDup.towers);

// ---------- 13) portrait / touch ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
{
  const hud = await ev(`(()=>{const e=document.querySelector('.brand h1');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (hud) await click(hud);
  await sleep(200);
}
const pInfo = await ev(`(()=>{
  const band = window.__anuto.band();
  const plots = window.__anuto.plotCells();
  const pts = plots.map(s => window.__anuto.cellPoint(s.c, s.r));
  const inside = pts.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  let bad = 0;
  for (const s of plots) {
    const p = window.__anuto.cellPoint(s.c, s.r);
    const b = window.__anuto.cellAt(p.x, p.y);
    if (!b || b.c !== s.c || b.r !== s.r) bad++;
  }
  const corners = [[0,0],[13,0],[0,8],[13,8]].map(([c,r]) => { const p = window.__anuto.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  return { view: innerWidth + 'x' + innerHeight, band, inside, bad, corners };
})()`);
T('portrait ' + JSON.stringify(pInfo));
ok(pInfo && pInfo.view === '390x844', 'the viewport really is 390x844', pInfo && pInfo.view);
ok(pInfo && pInfo.inside, 'every plot sits between the HUD bars in portrait', pInfo && { band: pInfo.band, corners: pInfo.corners });
ok(pInfo && pInfo.bad === 0, 'the picker still round-trips in portrait', pInfo && pInfo.bad);

await ev('window.__anuto.setup({ cash: 200, wave: 0 })');
await sleep(250);
const ptP = await cellPt(plotNear.c, plotNear.r);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
let sTouch = await state();
if (sTouch.towers.length === 0) {  // a finger repeats; retry once
  await click(ptP); await sleep(400);
  sTouch = await state();
}
T('touch ' + JSON.stringify({ ptP, towers: sTouch.towers.length, cash: sTouch.cash }));
ok(sTouch.towers.length >= 1, 'a touch tap places a tower on the phone', sTouch.towers);
const shotPortrait = await shot('anuto-gate-portrait');

// ---------- 14) console errors ----------
const errs = pageCdp.events
  .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params).slice(0, 160));
ok(errs.length === 0, 'no console exceptions during the whole gate', errs.slice(0, 4));

console.log(JSON.stringify({ fails, shots: { shotBoot, shotPlay, shotWin, shotPortrait } }, null, 1));
T(fails.length ? `FAILED — ${fails.length} check(s)` : 'PASS — every gate check passed');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
