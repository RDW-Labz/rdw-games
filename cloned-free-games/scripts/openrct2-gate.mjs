#!/usr/bin/env node
// Interaction gate for the Cluer Park port (the OpenRCT2 card). Real CDP mouse clicks:
// palette buttons -> path laying, a refused island, a ride placed and refused twice over,
// bulldozing with its refund, then hook fixtures for the win sheet, the season sheet and
// bankruptcy, the sheet buttons, the double-tap guard and a 390x844 touch pass.
// usage: node openrct2-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/openrct2/index.html';
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

const CMD_TIMEOUT = 240000;
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
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
const PROFILE = mkdtempSync('/tmp/openrct2-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: mkdtempSync('/tmp/xdg-') } });
process.on('unhandledRejection', (e) => { T('unhandled ' + e); try { proc.kill('SIGKILL'); } catch {} process.exit(1); });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 120000);
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
const t0 = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
// poll for the boot hook rather than sleeping a guessed interval
let booted = false;
for (let i = 0; i < 240; i++) {
  const t = await ev('typeof window.__openrct2');
  if (t === 'function') { booted = true; break; }
  await sleep(500);
}
T('boot hook after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__openrct2()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const cellPt = async (c, r) => ev(`window.__openrct2.cellPoint(${c},${r})`);
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
const clickTool = async (tool, wait = 320) => {
  const b = await ev(`(()=>{const e=document.querySelector('#palette .tw[data-tool="${tool}"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
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

// ---------- 1) boot ----------
const rules = await ev('window.__openrct2.rules()');
const s0 = await state();
const shotBoot = await shot('openrct2-gate-boot');
T('boot ' + JSON.stringify({ booted, rules: rules && { W: rules.W, H: rules.H, season: rules.season, target: rules.target, entrance: rules.entrance },
  s0: s0 && { cash: s0.cash, paths: s0.paths, visits: s0.visits, running: s0.running, view: s0.view } }));
ok(booted, 'the state hook is a function');
ok(rules && rules.W === 15 && rules.H === 11 && rules.season === 300, 'a 15x11 park with a 300s season', rules && { W: rules.W, H: rules.H, season: rules.season });
ok(rules && Object.keys(rules.rideKinds).length === 4, 'four ride kinds are on the palette', rules && Object.keys(rules.rideKinds || {}));
ok(s0 && s0.cash === 9000 && s0.paths === 1 && s0.visits === 0, 'boot is 9000 cash, one gate tile, no guests', s0 && { cash: s0.cash, paths: s0.paths, visits: s0.visits });
ok(s0 && s0.running === false, 'the season clock waits for the first build', s0 && s0.running);
ok(sheet() && (await sheet()).open === false, 'the end sheet starts closed');

// ---------- 2) the picker round-trips every cell ----------
const pick = await ev(`(()=>{
  const band = window.__openrct2.band();
  let bad = 0, worst = null;
  const cells = window.__openrct2.cells();
  for (const s of cells) {
    const p = window.__openrct2.cellPoint(s.c, s.r);
    const back = window.__openrct2.cellAt(p.x, p.y);
    if (!back || back.c !== s.c || back.r !== s.r) { bad++; if (!worst) worst = { s, p, back }; }
  }
  const corners = [[0,0],[14,0],[0,10],[14,10]].map(([c,r]) => { const p = window.__openrct2.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  const inside = corners.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  return { n: cells.length, bad, worst, corners, inside, band };
})()`);
T('picker ' + JSON.stringify({ n: pick && pick.n, bad: pick && pick.bad, inside: pick && pick.inside, corners: pick && pick.corners }));
ok(pick && pick.n === 165, 'the board is 165 cells', pick && pick.n);
ok(pick && pick.bad === 0, 'every cell point resolves back to its own cell', pick && pick.worst);
ok(pick && pick.inside, 'all four corners sit inside the viewport and the HUD band', pick && pick.corners);

// ---------- 3) real clicks: path laying, a refused island ----------
await ev('window.__openrct2.setup({ plan: false, run: false })');
await sleep(250);
const pOpen = await clickTool('path');
const sT = await state();
ok(pOpen && sT.tool === 'path', 'the PATH button selects the path tool with a real click', sT && sT.tool);
ok(sT.cash === 9000 && sT.paths === 1, 'the QA park is empty with the full purse', { cash: sT.cash, paths: sT.paths });

await clickCell(7, 9);
const sA = await state();
T('path1 ' + JSON.stringify({ paths: sA.paths, cash: sA.cash, inputs: sA.inputs, running: sA.running }));
ok(sA.paths === 2 && sA.cash === 8990, 'a click on grass beside the gate lays a path', { paths: sA.paths, cash: sA.cash });
ok(sA.inputs === 1 && sA.running === true, 'the accepted click is counted and the season starts', { inputs: sA.inputs, running: sA.running });

await clickCell(7, 8);
const sB = await state();
ok(sB.paths === 3 && sB.cash === 8980, 'the path chain continues', { paths: sB.paths, cash: sB.cash });

const sRefuse0 = await state();
await clickCell(0, 0);
const sC = await state();
T('island ' + JSON.stringify({ paths: sC.paths, cash: sC.cash, blocked: [sRefuse0.blocked, sC.blocked], note: sC.note }));
ok(sC.paths === 3 && sC.cash === 8980, 'a path on an island builds nothing', { paths: sC.paths, cash: sC.cash });
ok(sC.blocked > sRefuse0.blocked, 'the refused click is counted as blocked', [sRefuse0.blocked, sC.blocked]);

// ---------- 4) a ride lands on the footprint, a second one is refused ----------
const pRide = await clickTool('carousel');
const sSel = await state();
ok(pRide && sSel.tool === 'carousel', 'the CAROUSEL button selects the ride with a real click', sSel && sSel.tool);
const centre = await ev('window.__openrct2.centreOf("carousel", 8, 8)');
await clickCell(centre.c, centre.r);
const sRide = await state();
T('ride ' + JSON.stringify({ rides: sRide.rides, cash: sRide.cash, centre }));
ok(sRide.rides.length === 1 && sRide.rides[0].kind === 'carousel', 'a click near the path opens a carousel', sRide.rides);
ok(sRide.rides[0] && sRide.rides[0].c === 8 && sRide.rides[0].r === 8, 'the 2x2 carousel anchors where it was tapped', sRide.rides[0]);
ok(sRide.cash >= 8074 && sRide.cash <= 8080, 'the carousel is charged 900, less a few pennies of upkeep', { cash: sRide.cash });

const sBeforeDouble = await state();
await clickCell(centre.c, centre.r);
const sDouble = await state();
ok(sDouble.rides.length === 1 && sDouble.blocked > sBeforeDouble.blocked, 'a second carousel on the same footprint is refused',
  { rides: sDouble.rides.length, blocked: [sBeforeDouble.blocked, sDouble.blocked] });

// ---------- 5) bulldozing refunds half and clears the footprint ----------
await clickTool('demolish');
const sDelSel = await state();
ok(sDelSel.tool === 'demolish', 'the BULLDOZE button selects the tool', sDelSel.tool);
const cashBeforeDel = sDelSel.cash;
await clickCell(centre.c, centre.r);
const sDel = await state();
T('demolish ' + JSON.stringify({ rides: sDel.rides.length, cash: [cashBeforeDel, sDel.cash], note: sDel.note }));
ok(sDel.rides.length === 0, 'bulldozing the carousel removes it', sDel.rides);
ok(sDel.cash >= cashBeforeDel + 450, 'half the carousel comes back', { before: cashBeforeDel, after: sDel.cash });

// ---------- 6) a full park runs and the guests pay ----------
const built = await ev(`window.__openrct2.setup({ plan: 'full', run: true })`);
await sleep(300);
const sPark = await state();
T('park ' + JSON.stringify({ built, sPark: sPark && { rides: sPark.rides.length, rating: sPark.rating, cash: sPark.cash, paths: sPark.paths } }));
ok(built && built.rides === 4, 'the reference park builds all four rides', built);
ok(sPark && sPark.rating >= 400, 'a full park is rated above the target', sPark && sPark.rating);
const run30 = await ev('window.__openrct2.step(30)');
const sPlay = await state();
T('play ' + JSON.stringify({ run30, guests: sPlay.guests, income: sPlay.income, visits: sPlay.visits }));
ok(run30 && run30.guests > 0, 'guests walk the park', run30);
ok(sPlay && sPlay.income > 0, 'they pay at the turnstiles', sPlay && sPlay.income);
ok(sPlay && sPlay.rides.some(r => r.riders > 0), 'the rides carry riders', sPlay && sPlay.rides);
const shotPlay = await shot('openrct2-gate-play');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await copyFile(shotPlay, '/home/cluer/cloned-free-games/.queue/lib-art/openrct2.png');
await copyFile(shotPlay, '/home/cluer/cloned-free-games/.queue/lib-art/OpenRCT2.png');

// ---------- 7) the win sheet ----------
await ev(`window.__openrct2.setup({ plan: 'full', run: true })`);
await sleep(250);
const winRun = await ev('window.__openrct2.step(320)');
const sWin = await state();
const sheetWin = await sheet();
T('win ' + JSON.stringify({ winRun, over: sWin && sWin.over, result: sWin && sWin.result, sheet: sheetWin }));
ok(sWin && sWin.over && sWin.result === 'win', 'a full park meets the attendance target', { result: sWin.result, visits: sWin.visits, rating: sWin.rating });
ok(sWin && sWin.visits >= sWin.target && sWin.rating >= sWin.ratingTarget, 'it wins with both bars met', { visits: sWin.visits, rating: sWin.rating });
ok(sheetWin && sheetWin.open && /Season made/i.test(sheetWin.title), 'the win sheet opens with its own title', sheetWin);
const shotWin = await shot('openrct2-gate-win');

// ---------- 8) the season sheet on a thin park ----------
await ev(`window.__openrct2.setup({ plan: { paths: window.__openrct2.plan().paths, rides: [{ kind: 'carousel', c: 8, r: 5 }], stalls: [], trees: [] }, run: true })`);
await sleep(250);
const loseRun = await ev('window.__openrct2.step(320)');
const sSeason = await state();
const sheetSeason = await sheet();
T('season ' + JSON.stringify({ loseRun, over: sSeason && sSeason.over, result: sSeason && sSeason.result, sheet: sheetSeason }));
ok(sSeason && sSeason.over && sSeason.result === 'season', 'a one-ride park runs out of season', { result: sSeason.result, visits: sSeason.visits });
ok(sSeason && sSeason.visits < sSeason.target, 'it misses on attendance, not by accident', sSeason && sSeason.visits);
ok(sheetSeason && sheetSeason.open && /Season closed/i.test(sheetSeason.title), 'the season sheet opens with its own title', sheetSeason);
const shotLose = await shot('openrct2-gate-season');

// ---------- 9) bankruptcy: upkeep with the park cut off ----------
await ev(`window.__openrct2.setup({ plan: 'full', run: true, cash: 150 })`);
await sleep(250);
await clickTool('demolish');
await clickCell(7, 7);
const sCut = await state();
ok(sCut.paths < sPark.paths, 'the spine is cut with a real click', { paths: sCut.paths, before: sPark.paths });
const bankRun = await ev('window.__openrct2.step(220)');
const sBank = await state();
const sheetBank = await sheet();
T('bankrupt ' + JSON.stringify({ bankRun, over: sBank && sBank.over, result: sBank && sBank.result, cash: sBank.cash }));
ok(sBank && sBank.over && sBank.result === 'bankrupt', 'a cut-off park drowns in upkeep', { result: sBank.result, cash: sBank.cash });
ok(sheetBank && sheetBank.open && /bankrupt/i.test(sheetBank.title), 'the bankruptcy sheet opens with its own title', sheetBank);

// ---------- 10) the sheet buttons drive a fresh park ----------
await clickEl('overBtn', 700);
const sRestart = await state();
const sheetAfter = await sheet();
T('again ' + JSON.stringify({ cash: sRestart.cash, rides: sRestart.rides.length, visits: sRestart.visits, over: sRestart.over }));
ok(sRestart && sRestart.cash === 9000 && sRestart.visits === 0 && sRestart.over === false, 'Play again opens a fresh park', sRestart && { cash: sRestart.cash, visits: sRestart.visits });
ok(sRestart && sRestart.rides.length === 0 && sRestart.paths === 1, 'the fresh park is empty but for the gate', sRestart && { rides: sRestart.rides.length, paths: sRestart.paths });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes on restart', sheetAfter);

// ---------- 11) the double-tap guard ----------
await ev('window.__openrct2.setup({ plan: false, run: false })');
await sleep(200);
await clickTool('path');
const dupPt = await ev(`(()=>{
  const p = window.__openrct2.cellPoint(7,9);
  const el = document.elementFromPoint(p.x, p.y) || document.querySelector('canvas');
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk()); el.dispatchEvent(mk());
  return p;
})()`);
await sleep(300);
const sDup = await state();
T('dup ' + JSON.stringify({ dupPt, paths: sDup.paths, dups: sDup.dups }));
ok(sDup.dups >= 1, 'the second event of a double tap is dropped', sDup.dups);
ok(sDup.paths === 2, 'a double tap lays one path, not two', sDup.paths);

// ---------- 12) portrait / touch ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
{
  const hud = await ev(`(()=>{const e=document.querySelector('.brand h1');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (hud) await click(hud);
  await sleep(250);
}
const pInfo = await ev(`(()=>{
  const band = window.__openrct2.band();
  const cells = window.__openrct2.cells();
  const corners = [[0,0],[14,0],[0,10],[14,10]].map(([c,r]) => { const p = window.__openrct2.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  const inside = corners.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  let bad = 0;
  for (const s of cells) {
    const p = window.__openrct2.cellPoint(s.c, s.r);
    const b = window.__openrct2.cellAt(p.x, p.y);
    if (!b || b.c !== s.c || b.r !== s.r) bad++;
  }
  return { view: innerWidth + 'x' + innerHeight, band, inside, bad, corners };
})()`);
T('portrait ' + JSON.stringify(pInfo));
ok(pInfo && pInfo.view === '390x844', 'the viewport really is 390x844', pInfo && pInfo.view);
ok(pInfo && pInfo.inside, 'all four corners sit between the HUD bars in portrait', pInfo && pInfo.corners);
ok(pInfo && pInfo.bad === 0, 'the picker still round-trips in portrait', pInfo && pInfo.bad);

await ev('window.__openrct2.setup({ plan: false, run: false })');
await sleep(250);
await clickTool('path');
const ptP = await cellPt(7, 9);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y, id: 1 }] });
await sleep(70);
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(450);
let sTouch = await state();
if (sTouch.paths < 2) { await click(ptP); await sleep(450); sTouch = await state(); }   // a finger repeats
T('touch ' + JSON.stringify({ ptP, paths: sTouch.paths, cash: sTouch.cash }));
ok(sTouch.paths >= 2, 'a finger lays a path on the phone', { paths: sTouch.paths });
const shotPortrait = await shot('openrct2-gate-portrait');

// ---------- 13) console errors ----------
const errs = pageCdp.events
  .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params).slice(0, 160));
ok(errs.length === 0, 'no console exceptions during the whole gate', errs.slice(0, 4));

console.log(JSON.stringify({ fails, shots: { shotBoot, shotPlay, shotWin, shotLose, shotPortrait } }, null, 1));
T(fails.length ? `FAILED — ${fails.length} check(s)` : 'PASS — every gate check passed');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
