#!/usr/bin/env node
// Interaction gate for the Idle Fantasy port. Real CDP mouse on the forge and the plots, the
// picker round-trip, the double-tap guard, both terminal states (sacked treasury, starved coffers,
// five raids held), restart from the sheet, and a 390x844 touch pass.
// usage: node idle-fantasy-gate.mjs [site-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/idle-fantasy/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = normalize(join(ROOT, p));
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
const PROFILE = mkdtempSync('/tmp/idle-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-24));
const server = await serve();
const port = server.address().port;
T('serving ' + port + ' root ' + ROOT);
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
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(200);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(260);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const st = () => ev('window.__idle()');
const errorsSince = (from) => pageCdp.events.slice(from)
  .filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---------- 1) boot
const hookType = await ev('typeof window.__idle');
const s0 = await st();
const render0 = await ev('window.__idle.render()');
const cam0 = await ev('window.__idle.camera()');
const roundTrip = await ev(`(()=>{const o=[];for(let i=0;i<8;i++){const p=window.__idle.plotPoint(i);o.push({i,p,hit:window.__idle.cellAt(p)});}return o;})()`);
const forgeRT = await ev(`(()=>{const p=window.__idle.forgePoint();return {p,hit:window.__idle.cellAt(p)};})()`);
const shotBoot = await shot('idle-fantasy-gate-boot');
T('boot ' + JSON.stringify({ gold: s0.gold, plots: s0.plots.length, calls: render0.calls, dist: cam0.dist }));

// ---------- 2) real click on the forge
const fp = await ev('window.__idle.forgePoint()');
const g0 = (await st()).gold;
await click(fp);
const s1 = await st();
T('forge click ' + JSON.stringify({ before: g0, after: s1.gold, taps: s1.taps }));

// ---------- 3) pick Barracks, then raise one on plot 0 (real clicks)
await ev('window.__idle.setup({gold:600, raids:0, raidIn:60})');
await clickEl('p-barracks');
const sSel = await st();
const p0 = await ev('window.__idle.plotPoint(0)');
await click(p0);
const s2 = await st();
T('barracks ' + JSON.stringify({ chosen: sSel.chosen, plot0: s2.plots[0], might: s2.might, gold: s2.gold }));

// upgrade the same plot with a second click
await click(p0);
const s3 = await st();
T('upgrade ' + JSON.stringify({ plot0: s3.plots[0], might: s3.might }));

// ---------- 4) mine through the pad on a different plot
await clickEl('p-mine');
const p1 = await ev('window.__idle.plotPoint(1)');
await click(p1);
const s4 = await st();
T('mine ' + JSON.stringify({ plot1: s4.plots[1], income: s4.income }));

// an occupied plot refuses a different kind
await clickEl('p-market');
await click(p0);
const s5 = await st();
T('refusal ' + JSON.stringify({ plot0: s5.plots[0], blocked: s5.blocked, notes: s5.notes }));

// ---------- 4b) the tile-art frame: a realm with buildings standing
await ev('window.__idle.setup({plots:[["mine",2],["barracks",3],null,["market",2],["mine",1],null,["barracks",1],null], gold:340, raids:2, raidIn:14})');
await sleep(400);
const shotArt = await shot('idle-fantasy-art');
const sArt = await st();
T('art board ' + JSON.stringify({ plots: sArt.plots.filter(Boolean).length, might: sArt.might, income: sArt.income }));

// ---------- 5) the double-tap guard, both events in one page tick
const dupRun = await ev(`(()=>{
  window.__idle.setup({gold:600, raids:0, raidIn:60});
  window.__idle.select('mine');
  const before = window.__idle();
  const p = window.__idle.plotPoint(2);
  const fire = () => document.body.dispatchEvent(new PointerEvent('pointerup', {clientX:p.x, clientY:p.y, bubbles:true}));
  fire(); fire();
  const s = window.__idle();
  return {plot2: s.plots[2], dups: s.dups - before.dups, taps: s.taps - before.taps, inputs: s.inputs - before.inputs};
})()`);
T('double dispatch ' + JSON.stringify(dupRun));

// ---------- 6) lose: the treasury cannot pay the tribute
await ev('window.__idle.setup({plots:[], gold:4, raids:0, raidIn:0.4})');
let sLoss = null;
for (let i = 0; i < 24; i++) { await sleep(250); sLoss = await st(); if (sLoss.over) break; }
const shotLose = await shot('idle-fantasy-gate-sacked');
T('sacked ' + JSON.stringify({ over: sLoss.over, result: sLoss.result, why: sLoss.why, title: sLoss.sheetTitle }));

// restart from the sheet's own button
await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ gold: sNew.gold, raids: sNew.raids, over: sNew.over, plots: sNew.plots.filter(Boolean).length }));

// ---------- 7) lose: the barracks wages outrun a mine-less vault
await ev('window.__idle.setup({plots:[["barracks",2]], gold:2, raids:0, raidIn:120})');
let sCof = null;
for (let i = 0; i < 32; i++) { await sleep(250); sCof = await st(); if (sCof.over) break; }
T('coffers ' + JSON.stringify({ over: sCof.over, result: sCof.result, why: sCof.why, title: sCof.sheetTitle }));

// ---------- 8) win: the fifth raid breaks on a manned wall
await ev('window.__idle.setup({plots:[["barracks",3],["barracks",3],["mine",4]], gold:120, raids:4, raidIn:0.6})');
let sWin = null;
for (let i = 0; i < 32; i++) { await sleep(250); sWin = await st(); if (sWin.over) break; }
const shotWin = await shot('idle-fantasy-gate-win');
T('win ' + JSON.stringify({ over: sWin.over, result: sWin.result, raids: sWin.raids, title: sWin.sheetTitle }));

// ---------- 9) a played raid: keep might above the ladder and the loot is not taken
await clickEl('backBtn');
await ev('window.__idle.setup({plots:[["barracks",1]], gold:200, raids:0, raidIn:0.6})');
let sRaid = null;
for (let i = 0; i < 20; i++) { await sleep(250); sRaid = await st(); if (sRaid.raids >= 1) break; }
T('raid held ' + JSON.stringify({ raids: sRaid.raids, over: sRaid.over, need: sRaid.need, might: sRaid.might }));
const errors1 = errorsSince(0);

// ---------- 10) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
const t0 = await st();
const tForge = await ev('window.__idle.forgePoint()');
const tPlot = await ev('window.__idle.plotPoint(4)');
const tPad = await ev(`window.__idle.padPoint('barracks')`);
await tap(tForge);
const t1 = await st();
await ev(`window.__idle.select('barracks')`);
await tap(tPlot);
const t2 = await st();
const tRT = await ev(`(()=>{const o=[];for(let i=0;i<8;i++){const p=window.__idle.plotPoint(i);o.push(window.__idle.cellAt(p));}return o;})()`);
const camT = await ev('window.__idle.camera()');
const shotTouch = await shot('idle-fantasy-gate-touch');
const errors2 = errorsSince(pageCdp.events.length - 40);
T('touch ' + JSON.stringify({ gold0: t0.gold, gold1: t1.gold, plot4: t2.plots[4], pad: tPad, rt: tRT }));

const onScreen = (p, w, h) => p && typeof p.x === 'number' && p.x > 2 && p.x < w - 2 && p.y > 2 && p.y < h - 2;
const checks = {
  hook: hookType === 'function',
  renders: render0.calls > 0 && render0.tris > 500,
  bootState: s0.gold === 55 && s0.plots.length === 8 && s0.plots.every((p) => p === null) && s0.over === false && s0.might === 0,
  pickerRoundTrip: Array.isArray(roundTrip) && roundTrip.every((r) => r.hit === r.i) && roundTrip.every((r) => onScreen(r.p, 1280, 800)),
  forgePicked: forgeRT && forgeRT.hit === 'forge',
  forgeTap: s1.gold >= g0 + 3 && s1.taps >= 1 && s1.forgeTaps >= 1,
  padSelect: sSel.chosen === 'barracks',
  built: s2.plots[0] && s2.plots[0].type === 'barracks' && s2.plots[0].lvl === 1 && s2.might === 2 && s2.gold < 600,
  upgraded: s3.plots[0] && s3.plots[0].lvl === 2 && s3.might === 4,
  mineBuilt: s4.plots[1] && s4.plots[1].type === 'mine' && s4.income > 0,
  refused: s5.plots[0].type === 'barracks' && s5.blocked >= 1,
  dupGuard: dupRun && dupRun.plot2 && dupRun.plot2.type === 'mine' && dupRun.plot2.lvl === 1 && dupRun.dups === 1 && dupRun.taps === 2,
  sacked: sLoss && sLoss.over === true && sLoss.result === 'lose' && sLoss.why === 'sacked' && sLoss.sheet === true && /sacked/i.test(sLoss.sheetTitle),
  restarted: sNew.gold === 55 && sNew.raids === 0 && sNew.over === false && sNew.plots.filter(Boolean).length === 0,
  coffers: sCof && sCof.over === true && sCof.result === 'lose' && sCof.why === 'coffers' && /coffers/i.test(sCof.sheetTitle),
  won: sWin && sWin.over === true && sWin.result === 'win' && sWin.raids === 5 && sWin.sheet === true && /stands/i.test(sWin.sheetTitle),
  raidHeld: sRaid && sRaid.raids >= 1 && sRaid.over === false,
  touchForge: t1.gold >= t0.gold + 3,
  touchBuild: t2.plots[4] && t2.plots[4].type === 'barracks' && t2.plots[4].lvl === 1,
  touchPoints: tRT && tRT.every((h, i) => h === i) && tForge && onScreen(tForge, 390, 844) && tPlot && onScreen(tPlot, 390, 844) && tPad && onScreen(tPad, 390, 844),
  portraitFit: camT && camT.band && camT.dist > 0,
  artBoard: sArt && sArt.plots.filter((p) => p && p.lvl > 0).length === 5 && sArt.might === 8,
  noErrors: !errors1 && !errors2,
};

console.log(JSON.stringify({
  checks, errors1, errors2,
  boot: { gold: s0.gold, plots: s0.plots.length, calls: render0.calls, tris: render0.tris, dist: cam0.dist, band: cam0.band },
  roundTrip, forgeRT,
  s1: { gold: s1.gold, taps: s1.taps, forgeTaps: s1.forgeTaps },
  sSel: { chosen: sSel.chosen }, s2: { plot0: s2.plots[0], might: s2.might, gold: s2.gold },
  s3: { plot0: s3.plots[0], might: s3.might }, s4: { plot1: s4.plots[1], income: s4.income },
  s5: { plot0: s5.plots[0], blocked: s5.blocked, notes: s5.notes }, dupRun,
  sLoss: { over: sLoss?.over, result: sLoss?.result, why: sLoss?.why, title: sLoss?.sheetTitle },
  sNew: { gold: sNew.gold, raids: sNew.raids },
  sCof: { over: sCof?.over, why: sCof?.why, title: sCof?.sheetTitle },
  sWin: { over: sWin?.over, raids: sWin?.raids, title: sWin?.sheetTitle },
  sRaid: { raids: sRaid?.raids, over: sRaid?.over, might: sRaid?.might },
  touch: { gold0: t0.gold, gold1: t1.gold, plot4: t2.plots[4], pad: tPad, rt: tRT, cam: camT },
  shots: [shotBoot, shotArt, shotLose, shotWin, shotTouch],
}, null, 0));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
