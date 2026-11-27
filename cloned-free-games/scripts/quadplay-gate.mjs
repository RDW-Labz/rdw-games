#!/usr/bin/env node
// Interaction gate for the Quadplay · HexFlipper port. Real CDP mouse clicks and touches on the hex
// field, every assertion read from the page's own state hook: an aim tap, a fire tap, the cpu's
// reply, the Fire button, a refused shot, a win and a loss reached by real input, the end sheet's
// own button, a whole clicked-out match, a 390x844 touch pass. Refuses console exceptions.
//
// usage: node quadplay-gate.mjs [site-root] [shot-prefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PREFIX = process.argv[3] || 'quadplay-gate';
const FILE = 'games/arcade/quadplay/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 180000);
    });
  }
}

const fails = [];
const checks = [];
const ok = (cond, msg, extra) => {
  checks.push(msg);
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.log(JSON.stringify({ gate: 'quadplay', fails: ['no chromium found'], shots: {}, checks: 0 })); console.log('FAIL — no chromium found'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/quadplay-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 90000);
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
const until = async (fn, ms = 30000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { server.close(); } catch {} };
process.on('unhandledRejection', (e) => { T('UNHANDLED ' + (e && e.message)); cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

const booted = await until(async () => (await ev('typeof window.__quadplay')) === 'function', 60000, 400);
T('boot hook after poll: ' + booted);
if (!booted) {
  const exc = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  T('page errors: ' + JSON.stringify(exc.map((e) => e.params.exceptionDetails.text).slice(0, 3)));
  console.log(JSON.stringify({ gate: 'quadplay', fails: ['the port never defined window.__quadplay'], shots: {}, checks: 1 }, null, 1));
  console.log('FAIL — the port never booted');
  cleanup(); process.exit(1);
}
await sleep(1000);

const click = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return pt;
};
const tap = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await sleep(80);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return pt;
};
const st = () => ev('window.__quadplay()');
const tilePoint = (i) => ev(`window.__quadplay.tilePoint(${i})`);
const clickIdx = async (i, wait = 300) => { const p = await tilePoint(i); await click(p); await sleep(wait); return p; };
const clickEl = async (id, wait = 350) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled};})()`);
  await click(b);
  await sleep(wait);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const SHOTS = {};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  SHOTS[name] = out;
  return out;
};
// one full turn of real play: aim-tap the hex a reader would pick, tap it again to fire, wait for the cpu
const playTurn = async (maxWait = 20000) => {
  const before = await st();
  const i = await ev('window.__quadplay.bestShot()');
  if (i === undefined || i < 0) return { fired: false, before };
  await clickIdx(i, 220);
  const aimed = await st();
  await clickIdx(i, 220);
  const fired = await st();
  const replied = await until(async () => { const s = await st(); return s.plies > aimed.plies && !s.cpuBusy && (s.over || s.turn === 0); }, maxWait, 200);
  return { fired: fired.plies > before.plies, aimed, firedState: fired, replied, i };
};

// ---------- 1) boot ----------
const s0 = await st();
const sheet0 = await sheet();
const shotBoot = await shot(`${PREFIX}-boot`);
T('boot ' + JSON.stringify({ cells: s0.cells, you: s0.you, cpu: s0.cpu, neutral: s0.neutral, turn: s0.turn, arrows: s0.arrows }));
const diagD = await ev(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); const vv = window.visualViewport;
  return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, vv: vv ? [vv.width, vv.height, vv.scale] : null, back: [c.width, c.height], css: [r.width, r.height, r.left, r.top] }; })()`);
T('desktop viewport ' + JSON.stringify(diagD));
ok((await ev('typeof window.__quadplay')) === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', booted);
const cells0 = await ev('window.__quadplay.cells().length');
ok(cells0 === 61, 'the comb carries 61 hexes', cells0);
ok(s0 && s0.you === 1 && s0.cpu === 1 && s0.neutral === 59, 'a fresh comb is 1 / 1 / 59 neutral', [s0.you, s0.cpu, s0.neutral]);
ok(s0 && s0.turn === 0 && s0.over === false, 'the visitor moves first', { turn: s0.turn, over: s0.over });
ok(s0 && s0.plies === 0, 'no plies played yet', s0.plies);
ok(s0 && s0.arrows >= 1 && s0.arrows <= 6, 'the first hand holds 1-6 arrows', s0.arrows);
ok(s0 && s0.hud.you === '1' && s0.hud.cpu === '1' && s0.hud.info === '59', 'the HUD reads the same numbers', s0.hud);
ok(s0 && s0.fireBtn.disabled === false, 'the Fire button is live on the visitor\'s turn');
ok(sheet0 && sheet0.open === false, 'no end sheet at boot', sheet0);
ok(s0 && s0.canvas.x > 300 && s0.canvas.y > 300, 'the canvas has real size', s0.canvas);

// ---------- 2) the picker ----------
const roundTrip = await ev(`(() => {
  const n = window.__quadplay.cells().length;
  let good = 0, seen = 0;
  for (let i = 0; i < n; i++) {
    const p = window.__quadplay.tilePoint(i);
    if (!p) continue;
    seen++;
    if (window.__quadplay.pickAt(p.x, p.y) === i) good++;
  }
  return { n, seen, good };
})()`);
ok(roundTrip && roundTrip.seen === 61 && roundTrip.good === 61, 'every hex picks back to itself (screen point -> hex)', roundTrip);

// ---------- 3) a real click aims, a second click fires, the cpu answers ----------
const myStart = await ev('window.__quadplay.index(9, 1)');
const neutral = await ev('window.__quadplay.index(5, 5)');
await clickIdx(neutral, 260);
const sCursor = await st();
ok(sCursor.cursor === neutral && sCursor.plies === 0, 'a real click on neutral ground only aims (nothing fires)', { cursor: sCursor.cursor, plies: sCursor.plies });
ok(sCursor.inputs >= 1, 'the click was counted as input', sCursor.inputs);
await clickIdx(myStart, 260);
const sAim = await st();
ok(sAim.cursor === myStart && sAim.plies === 0, 'a click on a hex you hold aims from it', { cursor: sAim.cursor, plies: sAim.plies });
ok(sAim.arrows >= 1 && sAim.arrowsOn >= 1, 'the 3D arrow markers are on screen for the aimed hex', { arrows: sAim.arrows, on: sAim.arrowsOn });
const shotAim = await shot(`${PREFIX}-aim`);
await clickIdx(myStart, 260);
const sFire = await st();
ok(sFire.plies >= 1, 'the second click fires (a ply is played)', sFire.plies);
ok(sFire.you + sFire.cpu + sFire.neutral === 61, 'the comb still carries 61 hexes after a shot', [sFire.you, sFire.cpu, sFire.neutral]);
ok(sFire.turn === 1 || sFire.cpuBusy === true, 'the cpu takes the turn after your shot', { turn: sFire.turn, busy: sFire.cpuBusy });
const shotFire = await shot(`${PREFIX}-fire`);
const replied = await until(async () => { const s = await st(); return s.turn === 0 && !s.cpuBusy; }, 20000, 200);
const sReply = await st();
ok(!!replied, 'the cpu answers on its own within a few seconds', { turn: sReply.turn, busy: sReply.cpuBusy, plies: sReply.plies });
ok(sReply.plies === 2, 'one shot each', sReply.plies);
ok(sReply.cpu >= 1, 'the cpu holds ground after its answer', sReply.cpu);
ok(sReply.hud.you === String(sReply.you) && sReply.hud.cpu === String(sReply.cpu), 'the HUD follows the board', sReply.hud);

// ---------- 4) the Fire button, and a refused shot ----------
const beforeBtn = await st();
const best = await ev('window.__quadplay.bestShot()');
ok(best >= 0, 'a firing hex exists for the next turn', best);
await clickIdx(best, 260);
const aimed2 = await st();
await clickEl('fire', 300);
const afterBtn = await st();
ok(aimed2.cursor === best, 'the aim followed the click', { cursor: aimed2.cursor, best });
ok(afterBtn.plies > beforeBtn.plies, 'the Fire button fires from the aimed hex', { before: beforeBtn.plies, after: afterBtn.plies });
await until(async () => { const s = await st(); return s.turn === 0 && !s.cpuBusy; }, 20000, 200);

const beforeRefuse = await st();
const freeHex = await ev(`(() => {
  const cs = window.__quadplay.cells();
  for (let i = 0; i < cs.length; i++) if (cs[i].owner === -1) return i;
  return -1;
})()`);
await clickIdx(freeHex, 260);
const errsBefore = (await st()).errors;
await clickEl('fire', 400);
const afterRefuse = await st();
ok(afterRefuse.plies === beforeRefuse.plies, 'firing from neutral ground does not play a ply', { before: beforeRefuse.plies, after: afterRefuse.plies });
ok(afterRefuse.errors > errsBefore, 'the refused shot is counted as an error', { before: errsBefore, after: afterRefuse.errors });
ok(afterRefuse.turn === 0, 'a refused shot keeps the turn', afterRefuse.turn);

// ---------- 5) a win reached by real clicks ----------
// the cpu down to one hex, ringed by the visitor, holding a super arrow pointed at it
const winTry = await ev(`(() => {
  const centre = window.__quadplay.index(5, 5);
  const N = window.__quadplay.neighbours(centre);
  const ring = [];
  let from = -1, dir = -1;
  for (let i = 0; i < N.length; i++) {
    const j = N[i];
    if (j < 0) continue;
    const c = window.__quadplay.cells()[j];
    ring.push([c.q, c.r]);
    if (from < 0) {
      const d = window.__quadplay.neighbours(j).indexOf(centre);
      if (d >= 0) { from = j; dir = d; }
    }
  }
  return { ring, from, dir };
})()`);
await ev(`window.__quadplay.setup({ mine: ${JSON.stringify(winTry.ring)}, theirs: [[5, 5]], turn: 0, move: ${(1 << winTry.dir) | (1 << (winTry.dir + 6))}, cursor: -1 })`);
await sleep(300);
const sWinFix = await st();
T('win fixture ' + JSON.stringify({ mine: sWinFix.you, theirs: sWinFix.cpu, neutral: sWinFix.neutral, dir: winTry.dir, from: winTry.from }));
ok(sWinFix.you === 6 && sWinFix.cpu === 1 && sWinFix.neutral === 54, 'the fixture leaves the cpu one ringed hex',
  { you: sWinFix.you, cpu: sWinFix.cpu, neutral: sWinFix.neutral });
const shotPreWin = await shot(`${PREFIX}-prewin`);
await clickIdx(winTry.from, 240);
await clickIdx(winTry.from, 500);
const sWin = await st();
const sheetWin = await sheet();
ok(sWin.over === true, 'taking their last hex ends the match', { over: sWin.over, result: sWin.result });
ok(sWin.result === 'win', 'and it is a win for the visitor', sWin.result);
ok(sWin.cpu === 0, 'the cpu holds nothing', sWin.cpu);
ok(sheetWin.open === true && /comb is yours/i.test(sheetWin.title), 'the win sheet opens', sheetWin);
const shotWin = await shot(`${PREFIX}-win`);
await clickEl('overBtn', 600);
const sAgain = await st();
const sheetAgain = await sheet();
ok(sAgain.over === false && sAgain.you === 1 && sAgain.cpu === 1 && sAgain.neutral === 59, 'Play again deals a fresh comb', { you: sAgain.you, cpu: sAgain.cpu, neutral: sAgain.neutral });
ok(sheetAgain.open === false, 'the sheet closes on Play again', sheetAgain);

// ---------- 6) a loss reached by play ----------
// the cpu one shot from wiping the visitor: one of their hexes has a super arrow on our last hex
const lossTry = await ev(`(() => {
  const N = window.__quadplay.neighbours(window.__quadplay.index(5, 5));
  const centre = window.__quadplay.index(5, 5);
  for (let i = 0; i < N.length; i++) if (N[i] >= 0) { const d = window.__quadplay.neighbours(N[i]).indexOf(centre); if (d >= 0) return { from: N[i], dir: d }; }
  return { from: -1, dir: -1 };
})()`);
const lossFrom = await ev(`(() => { const c = window.__quadplay.cells()[${lossTry.from}]; return [c.q, c.r]; })()`);
await ev(`window.__quadplay.setup({ mine: [[5, 5]], theirs: ${JSON.stringify([lossFrom])}, turn: 1, move: ${(1 << lossTry.dir) | (1 << (lossTry.dir + 6))} })`);
await sleep(400);
const sLossFix = await st();
T('loss fixture ' + JSON.stringify({ you: sLossFix.you, cpu: sLossFix.cpu, turn: sLossFix.turn, busy: sLossFix.cpuBusy }));
ok(sLossFix.cpu === 1, 'the fixture gives the cpu one hex on its own turn', sLossFix.cpu);
const lost = await until(async () => { const s = await st(); return s.over === true; }, 20000, 200);
const sLoss = await st();
const sheetLoss = await sheet();
ok(!!lost, 'the cpu wipes the visitor out', { over: sLoss.over, result: sLoss.result, you: sLoss.you });
ok(sLoss.result === 'lose', 'and the match reads as a loss', sLoss.result);
ok(sheetLoss.open === true && /comb is theirs/i.test(sheetLoss.title), 'the loss sheet opens', sheetLoss);
const shotLose = await shot(`${PREFIX}-lose`);
await clickEl('overBtn', 600);

// ---------- 7) a whole match, clicked out ----------
await ev('window.__quadplay.restart(20261127)');
await sleep(400);
const startWhole = await st();
let turns = 0, whole = null;
while (turns < 120) {
  const s = await st();
  if (s.over) { whole = s; break; }
  const r = await playTurn();
  if (!r.fired) break;
  turns++;
}
const sWhole = await st();
ok(sWhole.over === true, 'a match clicked out from the first move settles', { over: sWhole.over, result: sWhole.result, plies: sWhole.plies, turns });
ok(sWhole.plies > 4, 'and it took real play to settle', sWhole.plies);
ok(['win', 'lose', 'draw'].includes(sWhole.result), 'the whole match has a verdict', sWhole.result);
ok(sWhole.you + sWhole.cpu + sWhole.neutral === 61, 'the comb still carries 61 hexes at the end', [sWhole.you, sWhole.cpu, sWhole.neutral]);
const shotWhole = await shot(`${PREFIX}-whole`);
T('whole match: ' + JSON.stringify({ result: sWhole.result, plies: sWhole.plies, you: sWhole.you, cpu: sWhole.cpu, neutral: sWhole.neutral, turns }));

// ---------- 8) console cleanliness ----------
const exc = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const logErr = pageCdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/.test(e.params.entry.url || ''));
ok(exc.length === 0, 'no uncaught exceptions in the page', exc.map((e) => e.params.exceptionDetails.text).slice(0, 3));
ok(logErr.length === 0, 'no console errors in the page', logErr.map((e) => e.params.entry.text).slice(0, 3));

// ---------- 9) portrait touch ----------
await ev('window.__quadplay.restart(20261127)');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1000);
const fitP = await ev('window.__quadplay.refit()');
const diagP = await ev(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); const vv = window.visualViewport;
  const pts = []; for (let i = 0; i < 61; i++) { const p = window.__quadplay.tilePoint(i); if (p) pts.push(p); }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { inner: [innerWidth, innerHeight], dpr: devicePixelRatio, vv: vv ? [vv.width, vv.height, vv.scale] : null,
    back: [c.width, c.height], css: [r.width, r.height, r.left, r.top],
    bbox: [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))] }; })()`);
T('portrait viewport ' + JSON.stringify(diagP));
ok(diagP && diagP.bbox[0] >= 0 && diagP.bbox[2] <= diagP.inner[0] && diagP.bbox[1] >= 0 && diagP.bbox[3] <= diagP.inner[1],
  'the whole comb is inside the phone screen', diagP && diagP.bbox);
ok(diagP && Math.abs((diagP.bbox[0] + diagP.bbox[2]) / 2 - diagP.inner[0] / 2) < diagP.inner[0] * 0.06,
  'the comb is centred across the phone', diagP && { bbox: diagP.bbox, centre: diagP.inner[0] / 2 });
const sP = await st();
ok(sP.canvas.x === 390 && sP.canvas.y === 844, 'the canvas takes the phone viewport', sP.canvas);
ok(fitP && fitP.extent && fitP.extent.mx > 0.72, 'the comb is refitted to fill the phone width', fitP && fitP.extent);
ok(fitP && fitP.extent.maxY <= fitP.band.top + 0.02 && fitP.extent.minY >= fitP.band.bottom - 0.02,
  'the comb sits inside the free band between the phone HUD bars', fitP && { e: fitP.extent, band: fitP.band });
const bestP = await ev('window.__quadplay.bestShot()');
const shotPortraitAim = await shot(`${PREFIX}-portrait`);
const pP = await tilePoint(bestP);
await tap(pP);
await sleep(320);
const sPTap1 = await st();
ok(sPTap1.cursor === bestP, 'a portrait touch aims from that hex', { cursor: sPTap1.cursor, best: bestP });
await tap(pP);
await sleep(320);
const sPTap2 = await st();
ok(sPTap2.plies >= 1, 'a second portrait touch fires', sPTap2.plies);
const shotPortrait = await shot(`${PREFIX}-portrait-fired`);
const diagAfter = await ev('window.__quadplay.diag()');
T('portrait after taps ' + JSON.stringify(diagAfter));
T('portrait ' + JSON.stringify({ arrows: sP.arrows, plies: sPTap2.plies, canvas: sPTap2.canvas }));

// ---------- report ----------
T('shots ' + JSON.stringify(SHOTS));
console.log(JSON.stringify({ gate: 'quadplay', fails, shots: SHOTS, checks: checks.length }, null, 1));
console.log(fails.length === 0 ? 'PASS — quadplay gate' : 'FAIL — ' + fails.length + ' assertion(s) failed');
cleanup();
process.exit(fails.length === 0 ? 0 : 1);
