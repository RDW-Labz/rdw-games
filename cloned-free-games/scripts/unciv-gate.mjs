#!/usr/bin/env node
// Interaction gate for the Unciv port. Real CDP input against the shipped page served from the
// site repo root (the port imports ./kit.js relatively):
//   picker round-trip on all 63 tiles, select the Settler and Found city from the HUD button,
//   open the city panel and queue a Warrior, Next-turn until it is built, a real two-click move,
//   an attack that visibly costs the defender hit points, the win sheet (take the rival capital),
//   the loss sheet (your capital falls), the age cap, restart from the sheet, the double-tap
//   guard, and a 390x844 touch pass.
// usage: node unciv-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PATH_ = 'games/arcade/unciv/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const ART = '/home/cluer/cloned-free-games/.queue/lib-art';
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
const PROFILE = mkdtempSync('/tmp/unciv-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m && !t._done) { t._done = true; clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('FAIL: no page target'); process.exit(1); }
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const events = () => pageCdp.events;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

const server = await serve();
const port = server.address().port;
const URL_ = `http://127.0.0.1:${port}/${PATH_}`;
T('serving ' + URL_);

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: URL_ });
await sleep(6000);

const click = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(180);
};
const elPoint = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const hook = () => ev('window.__unciv()');
const sheet = () => ev('window.__unciv.sheet()');
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const poll = async (fn, budgetMs, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  T('poll timeout: ' + label);
  return null;
};

// ---- 1) boot
const hookType = await ev('typeof window.__unciv');
const s0 = await hook();
const rules = await ev('window.__unciv.rules()');
const band0 = await ev('window.__unciv.band()');
const shotBoot = await shot('unciv-gate-boot');
T('boot ' + JSON.stringify({ hookType, turn: s0.turn, units: s0.units.length, cities: s0.cities.length, fog: s0.fog, band0 }));

// ---- 2) the picker round-trips on every tile
const picks = await ev(`(()=>{const R=window.__unciv.rules();const bad=[];for(let y=0;y<R.H;y++)for(let x=0;x<R.W;x++){const p=window.__unciv.tilePoint(x,y);const i=window.__unciv.cellAtPoint(p);if(i!==y*R.W+x)bad.push([x,y,i]);}return {bad:bad.slice(0,6),n:bad.length};})()`);

// ---- 3) select the Settler and settle from the HUD button
const settler = (await hook()).units.find((u) => u.kind === 'settler');
const settlerPt = await ev(`window.__unciv.unitPoint(${settler.id})`);
await click(settlerPt);
const afterSel = await hook();
const foundBtn = await elPoint('#b-found');
await click(foundBtn);
const afterFound = await hook();
const shotCity = await shot('unciv-gate-settle');
T('settle ' + JSON.stringify({ id: settler.id, pt: settlerPt, sel: afterSel.sel, cities: afterFound.cities.map((c) => ({ name: c.name, side: c.side, capital: c.capital })) }));

// ---- 4) city panel: queue a Warrior, then end turns until it is built
const city = afterFound.cities.find((c) => c.side === 0);
const cityPt = await ev(`window.__unciv.cityPoint(${city.id})`);
await click(cityPt);
const selCity = await hook();
const warBtn = await elPoint('#b-warrior');
await click(warBtn);
const queued = await hook();
const nextBtn = await elPoint('#b-next');
const army0 = queued.units.filter((u) => u.side === 0).length;
let built = null;
for (let i = 0; i < 14 && !built; i++) {
  await click(nextBtn);
  const s = await hook();
  if (s.units.filter((u) => u.side === 0).length > army0) built = s;
  if (s.over) break;
}
const shotTurns = await shot('unciv-gate-turns');
T('build ' + JSON.stringify({ selCity: selCity.sel, queue: queued.cities.find((c) => c.side === 0)?.queue, army0, built: built && built.units.filter((u) => u.side === 0).length, turn: built && built.turn }));

// ---- 5) a real two-click move
const mv = await ev(`(()=>{const R=window.__unciv.rules();const s=window.__unciv();const u=s.units.filter(v=>v.side===0&&v.kind!=='settler').sort((a,b)=>b.moves-a.moves)[0];if(!u||!u.moves)return null;const r=(window.__unciv.reach(u.id)||[]).filter(c=>c.c>0&&c.c<=u.moves).sort((a,b)=>b.c-a.c);if(!r.length)return null;const t=r[0];const x=t.i%R.W,y=Math.floor(t.i/R.W);return {id:u.id,from:{x:u.x,y:u.y},to:{x,y},cost:t.c,uPt:window.__unciv.unitPoint(u.id),tPt:window.__unciv.tilePoint(x,y)};})()`);
let moved = null;
if (mv) {
  await click(mv.uPt);
  await click(mv.tPt);
  const s = await hook();
  const u = s.units.find((v) => v.id === mv.id);
  moved = { from: mv.from, now: u && { x: u.x, y: u.y }, cost: mv.cost };
}
T('move ' + JSON.stringify(mv && moved));

// ---- 6) double-tap guard: two pointerups inside ONE page tick
const dup = await ev(`(()=>{const s=window.__unciv();const u=s.units.filter(v=>v.side===0&&v.kind!=='settler')[0];
  const p=window.__unciv.unitPoint(u.id);const c=document.querySelector('body > canvas');
  const mk=()=>new PointerEvent('pointerup',{clientX:p.x,clientY:p.y,bubbles:true,pointerId:11,pointerType:'touch'});
  const before=window.__unciv().inputs;c.dispatchEvent(mk());c.dispatchEvent(mk());const after=window.__unciv();
  return {before, after: after.inputs, dups: after.dups, sel: after.sel};})()`);

// ---- a small fixture map: pairs of adjacent open tiles, taken from the live board so no QA
// position ever lands on a mountain or the coast
const QA = await ev(`(()=>{const R=window.__unciv.rules();const W=R.W,H=R.H;
  const open=(i)=>{const t=R.map[i].t;return t!=='water'&&t!=='mount';};
  const pairs=[];
  for(let y=0;y<H;y++)for(let x=0;x<W-1;x++){const a=y*W+x;if(open(a)&&open(a+1))pairs.push([{x,y},{x:x+1,y}]);}
  if(pairs.length<3)return null;
  return {a:pairs[0], m:pairs[Math.floor(pairs.length/2)], z:pairs[pairs.length-1], n:pairs.length};})()`);
T('fixture pairs ' + JSON.stringify(QA));

// ---- 7) an attack that costs the defender hit points (QA position with a player capital)
const atkSetup = await ev(`window.__unciv.setup({turn:14,techs:[],gold:0,
  cities:[{side:0,x:${QA.a[0].x},y:${QA.a[0].y},capital:true,pop:2},{side:1,x:${QA.z[0].x},y:${QA.z[0].y},capital:true,pop:2}],
  units:[{side:0,kind:'warrior',x:${QA.m[0].x},y:${QA.m[0].y},hp:20,moves:2},{side:1,kind:'warrior',x:${QA.m[1].x},y:${QA.m[1].y},hp:20,moves:2}]})`);
const atk0 = await hook();
const atkMy = atk0.units.find((u) => u.side === 0);
const atkFoe = atk0.units.find((u) => u.side === 1);
await click(await ev(`window.__unciv.unitPoint(${atkMy.id})`));
await click(await ev(`window.__unciv.unitPoint(${atkFoe.id})`));
const atk1 = await hook();
const foeAfter = atk1.units.find((u) => u.id === atkFoe.id);
T('attack ' + JSON.stringify({ setup: atkSetup, foeHp0: atkFoe.hp, foeHp1: foeAfter && foeAfter.hp, news: atk1.news }));

// ---- 8) the win sheet: take a broken rival capital through the board
const winSetup = await ev(`window.__unciv.setup({turn:22,
  cities:[{side:0,x:${QA.a[0].x},y:${QA.a[0].y},capital:true,pop:2},{side:1,x:${QA.m[0].x},y:${QA.m[0].y},capital:true,pop:1,hp:3}],
  units:[{side:0,kind:'warrior',x:${QA.m[1].x},y:${QA.m[1].y},hp:20,moves:2}]})`);
const win0 = await hook();
const winU = win0.units.find((u) => u.side === 0);
const winC = win0.cities.find((c) => c.side === 1);
await click(await ev(`window.__unciv.unitPoint(${winU.id})`));
await click(await ev(`window.__unciv.cityPoint(${winC.id})`));
const winState = await hook();
const winSheet = await sheet();
const shotWin = await shot('unciv-gate-win');
T('win ' + JSON.stringify({ winSetup, over: winState.over, result: winState.result, cities: winState.cities.map((c) => c.side), winSheet }));

// ---- 9) restart from the sheet's own Play again button
await click(await elPoint('#overBtn'));
const restarted = await hook();

// ---- 10) the loss sheet: your capital falls to the rival on Next turn
const loseSetup = await ev(`window.__unciv.setup({turn:18,
  cities:[{side:0,x:${QA.a[0].x},y:${QA.a[0].y},capital:true,pop:1,hp:3},{side:1,x:${QA.z[0].x},y:${QA.z[0].y},capital:true,pop:2}],
  units:[{side:1,kind:'warrior',x:${QA.a[1].x},y:${QA.a[1].y},hp:20,moves:2}]})`);
const loseNext = await elPoint('#b-next');
await click(loseNext);
const loseState = await hook();
const loseSheet = await sheet();
const shotLose = await shot('unciv-gate-lose');
T('lose ' + JSON.stringify({ loseSetup, over: loseState.over, result: loseState.result, why: loseState.why, loseSheet }));

// ---- 11) the age cap
const ageSetup = await ev(`window.__unciv.setup({turn:40,
  cities:[{side:0,x:${QA.a[0].x},y:${QA.a[0].y},capital:true,pop:2},{side:1,x:${QA.z[0].x},y:${QA.z[0].y},capital:true,pop:2}],units:[]})`);
await click(await elPoint('#b-next'));
const ageState = await hook();
const ageSheet = await sheet();
T('age ' + JSON.stringify({ ageSetup, over: ageState.over, why: ageState.why, ageSheet }));

const errors1 = events().filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => t && !/favicon/i.test(t))
  .slice(0, 4).join(' | ');

// ---- 12) portrait touch pass
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: URL_ });
await sleep(6000);
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
const tap = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
await click({ x: 20, y: 10 });                 // prime the metrics override
await sleep(600);
const tBand = await ev('window.__unciv.band()');
const tPicks = await ev(`(()=>{const R=window.__unciv.rules();let bad=0;for(let y=0;y<R.H;y++)for(let x=0;x<R.W;x++){const p=window.__unciv.tilePoint(x,y);if(window.__unciv.cellAtPoint(p)!==y*R.W+x)bad++;}return bad;})()`);
const tSet0 = await ev(`(()=>{const s=window.__unciv();const u=s.units.find(v=>v.kind==='settler');return {id:u.id,pt:window.__unciv.unitPoint(u.id)};})()`);
await tap(tSet0.pt);
let tSel = (await hook()).sel;
if (!tSel) { await tap(tSet0.pt); tSel = (await hook()).sel; }
const tFoundBtn = await elPoint('#b-found');
if (tFoundBtn) await tap(tFoundBtn);
const tState = await hook();
const shotTouch = await shot('unciv-gate-touch');
T('touch ' + JSON.stringify({ tBand, tPicks, tSel, cities: tState.cities.length, view: tState.view }));

const errors2 = events().filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .filter((t) => t && !/favicon/i.test(t))
  .slice(0, 3).join(' | ');

const checks = {
  hook: hookType === 'function' && !!s0,
  shipped: rules && rules.W === 9 && rules.H === 7 && rules.MAX_TURNS === 40 && rules.TECHS.length === 3,
  boot: s0 && s0.turn === 1 && s0.units.filter((u) => u.side === 0).length === 2
    && s0.units.some((u) => u.side === 0 && u.kind === 'settler') && s0.cities.filter((c) => c.side === 0).length === 0
    && s0.cities.filter((c) => c.side === 1 && c.capital).length === 1 && s0.fog > 30,
  picker: picks && picks.n === 0,
  framed: band0 && band0.inBand,
  selectUnit: afterSel.sel && afterSel.sel.kind === 'unit',
  settled: afterFound.cities.filter((c) => c.side === 0).length === 1 && afterFound.cities.find((c) => c.side === 0).capital === true,
  cityPanel: selCity.sel && selCity.sel.kind === 'city',
  queued: queued.cities.find((c) => c.side === 0)?.queue === 'warrior',
  produced: !!built,
  moved: mv && moved && (moved.now.x !== moved.from.x || moved.now.y !== moved.from.y),
  doubleTapGuarded: dup && dup.dups >= 1 && dup.after === dup.before + 1,
  attacked: foeAfter && foeAfter.hp < atkFoe.hp,
  won: winState.over === true && winState.result === 'win' && winSheet && winSheet.open && /capital/i.test(winSheet.title),
  restarted: restarted && restarted.turn === 1 && restarted.cities.filter((c) => c.side === 0).length === 0
    && restarted.units.filter((u) => u.side === 0).length === 2 && restarted.over === false,
  lost: loseState.over === true && loseState.result === 'lose' && /capital/i.test(loseState.why || '') && loseSheet && loseSheet.open,
  ageCapped: ageState.over === true && /age/i.test(ageState.why || '') && ageSheet && ageSheet.open,
  touchPicks: tPicks === 0,
  touchSelect: tSel && tSel.kind === 'unit',
  touchSettled: tState.cities.filter((c) => c.side === 0).length === 1 && tState.view === '390x844',
  touchFramed: tBand && tBand.inBand,
  noErrors: !errors1 && !errors2,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  checks, errors1, errors2,
  s0: s0 && { turn: s0.turn, units: s0.units.map((u) => `${u.kind}@${u.x},${u.y}`), fog: s0.fog, view: s0.view },
  picks, settle: { sel: afterSel.sel, cities: afterFound.cities.map((c) => `${c.name}:${c.side}:cap${c.capital}`) },
  build: { queue: queued.cities[0]?.queue, army0, built: built && built.units.length, turn: built && built.turn },
  move: moved, dup, atk: { foeHp0: atkFoe.hp, foeHp1: foeAfter && foeAfter.hp },
  win: { result: winState.result, sheet: winSheet }, restarted: { turn: restarted.turn, cities: restarted.cities.length },
  lose: { result: loseState.result, why: loseState.why, sheet: loseSheet, open: loseSheet.open },
  age: { why: ageState.why, open: ageSheet.open },
  touch: { band: tBand, bad: tPicks, sel: tSel, cities: tState.cities.length, view: tState.view },
  shots: [shotBoot, shotCity, shotTurns, shotWin, shotLose, shotTouch],
}, null, 0));
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
