#!/usr/bin/env node
// Interaction gate for the Bim! port. Real CDP mouse clicks/taps: step-to-cell, bomb underfoot,
// blast destroying a crate, the double-tap guard, win + lose + stand-off sheets, restart, a full
// 3-round run, and a 390x844 touch pass.
// usage: node bim-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/bim/index.html';
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
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(await readFile(f));
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
const PROFILE = mkdtempSync('/tmp/bim-gate-');
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
const state = () => ev('window.__bim()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const cellPt = (c, r) => ev(`window.__bim.cellPoint(${c},${r})`);
const clickCell = async (c, r, wait = 340) => {
  const p = await cellPt(c, r);
  if (!p || p.__err) return { err: p && p.__err, c, r };
  await click(p);
  await sleep(wait);
  return p;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__bim');
const rules = await ev('window.__bim.rules()');
const s0 = await state();
T('boot ' + JSON.stringify({ hookType, rules: rules && { W: rules.W, H: rules.H, FUSE: rules.FUSE, spawns: rules.SPAWNS }, s0: s0 && { c: s0.c, r: s0.r, rounds: s0.rounds, foes: s0.foes.length, view: s0.view } }));
ok(hookType === 'function', 'the state hook is a function', hookType);
ok(rules && rules.W === 11 && rules.H === 9 && rules.SPAWNS.length === 4, 'an 11x9 arena with four spawn corners', rules && { W: rules.W, H: rules.H, spawns: rules.SPAWNS });
ok(s0 && s0.c === 1 && s0.r === 1 && s0.foes.length === 1, 'boot places you in a corner opposite one rival', s0 && { c: s0.c, r: s0.r, foes: s0.foes.length });

// ---------- 2) the picker round-trips every cell ----------
const pick = await ev(`(()=>{
  let bad=[], onCanvas=true;
  for (let r=0;r<9;r++) for (let c=0;c<11;c++) {
    const p=window.__bim.cellPoint(c,r);
    if (!p || p.x<0 || p.x>innerWidth || p.y<0 || p.y>innerHeight) { onCanvas=false; continue; }
    const back=window.__bim.cellAt(p.x,p.y);
    if (!back || back.c!==c || back.r!==r) bad.push({c,r,p,back});
  }
  return { bad: bad.slice(0,5), badCount: bad.length, onCanvas, band: window.__bim.band() };
})()`);
T('picker ' + JSON.stringify(pick));
ok(pick && pick.badCount === 0, 'every cell point resolves back to its own cell', pick && pick.bad);
ok(pick && pick.onCanvas, 'every cell projects inside the viewport');

// ---------- 3) a real click walks the bomber ----------
await ev('window.__bim.setup({ clearCrates: true, seed: 5 })');
await sleep(300);
const sQ = await state();
ok(sQ && sQ.c === 1 && sQ.r === 1, 'the QA arena starts the bomber in the corner', sQ && { c: sQ.c, r: sQ.r });
const pStep = await clickCell(3, 1);
const s1 = await state();
T('walk ' + JSON.stringify({ pStep, c: s1.c, r: s1.r, inputs: s1.inputs, taps: s1.taps }));
ok(s1.c > sQ.c && s1.r === 1, 'a click three cells away walks the bomber one cell toward it', { before: [sQ.c, sQ.r], after: [s1.c, s1.r] });
ok(s1.inputs > sQ.inputs, 'the accepted tap is counted', { before: sQ.inputs, after: s1.inputs });

// ---------- 4) tapping yourself drops a bomb ----------
const pSelf = await clickCell(s1.c, s1.r);
await sleep(200);
const s2 = await state();
T('bomb ' + JSON.stringify({ pSelf, bombs: s2.bombs, bombsMax: s2.bombsMax }));
ok(s2.bombs.length === 1 && s2.bombs[0].c === s1.c && s2.bombs[0].r === s1.r, 'a tap on your own cell drops a bomb', s2.bombs);
ok(s2.bombs[0].t > 0.2 && s2.bombs[0].t <= rules.FUSE, 'the fuse is burning', s2.bombs[0].t);

// ---------- 5) the blast destroys a crate, and a bomber that clears the blast lives ----------
// fixture: you at (5,3) with a range-2 bomb, a crate two cells away, and a clear lane down the
// column to walk out of. A rival parked in the far corner keeps the round from ending early.
await ev('window.__bim.setup({ clearCrates: true, seed: 5, crates: [[7,3]], players: [{ i: 0, c: 5, r: 3, blast: 2 }, { i: 1, c: 9, r: 7 }] })');
await sleep(300);
const ct0 = await state();
await clickCell(5, 3);                                   // a real tap on your own cell lights the fuse
const lit = await state();
await ev("window.__bim.step(0.15); window.__bim.move('down'); window.__bim.step(0.15); window.__bim.move('down'); window.__bim.step(0.15); window.__bim.move('down')");
const st = await ev('window.__bim.step(1.4)');
const s3 = await state();
T('blast ' + JSON.stringify({ lit: lit.bombs.length, at: [lit.c, lit.r], cratesBefore: ct0.crates, cratesAfter: s3.crates, st, at2: [s3.c, s3.r], alive: s3.alive, over: s3.over }));
ok(lit.bombs.length === 1, 'the tap lit exactly one bomb', lit.bombs.length);
ok(ct0.crates === 1 && s3.crates === 0, 'the blast eats the crate', { before: ct0.crates, after: s3.crates });
ok(s3.c === 5 && s3.r === 6, 'three steps down the lane put the bomber clear', { c: s3.c, r: s3.r });
ok(s3.over === false, 'the bomber that clears the blast lives', { over: s3.over, alive: s3.alive });

// ---------- 6) a bomb underfoot loses the run ----------
await ev('window.__bim.setup({ clearCrates: true, seed: 5 })');
await sleep(250);
const sBomb = await state();
await clickCell(sBomb.c, sBomb.r);           // bomb under yourself, stand still
await ev('window.__bim.step(2.2)');
const s4 = await state();
const sheetLose = await sheet();
T('lose ' + JSON.stringify({ over: s4.over, result: s4.result, why: s4.why, sheet: sheetLose }));
ok(s4.over && s4.result === 'lose', 'standing on your own bomb loses the run', { result: s4.result, why: s4.why });
ok(sheetLose && sheetLose.open && /blew/i.test(sheetLose.title), 'the lose sheet opens with its own title', sheetLose);

// ---------- 7) the sheet button restarts with real clicks ----------
const overBtn = await ev(`(()=>{const e=document.getElementById('overBtn');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(overBtn); await sleep(600);
const s5 = await state();
const sheetAfter = await sheet();
T('again ' + JSON.stringify({ s5: s5 && { c: s5.c, r: s5.r, over: s5.over, bombs: s5.bombs.length }, sheetAfter }));
ok(s5 && s5.over === false && s5.c === 1 && s5.r === 1, 'Play again deals a fresh arena', s5 && { c: s5.c, r: s5.r, over: s5.over });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes', sheetAfter);

// ---------- 8) win a round, then the match ----------
await ev('window.__bim.setup({ clearCrates: true, seed: 5, rounds: 2, noFoes: true })');
await sleep(250);
const stWin = await ev('window.__bim.step(1.0)');
const sWin = await state();
const sheetWin = await sheet();
T('win ' + JSON.stringify({ stWin, result: sWin && sWin.result, rounds: sWin && sWin.rounds, sheet: sheetWin }));
ok(sWin && sWin.result === 'win', 'clearing the third arena wins the match', { result: sWin.result, rounds: sWin.rounds });
ok(sheetWin && sheetWin.open && /champion/i.test(sheetWin.title), 'the champion sheet opens', sheetWin);
const shotWin = await shot('bim-gate-win');

// ---------- 9) a round win advances the arena ----------
await ev('window.__bim.setup({ clearCrates: true, seed: 5, noFoes: true })');
await sleep(250);
await ev('window.__bim.step(1.0)');
const sRound = await state();
T('round ' + JSON.stringify({ result: sRound.result, rounds: sRound.rounds, c: sRound.c, r: sRound.r, crates: sRound.crates, foes: sRound.foes.length }));
ok(sRound.rounds === 1 && sRound.result === null, 'a won round deals the next arena at one round up', { rounds: sRound.rounds, result: sRound.result });
ok(sRound.foes.length === 1, 'with a fresh rival back in the ring', sRound.foes.length);

// ---------- 10) the double-tap guard ----------
await ev('window.__bim.setup({ clearCrates: true, seed: 5 })');
await sleep(250);
const dup = await ev(`(()=>{
  const p = window.__bim.cellPoint(1,1);
  const el = document.elementFromPoint(p.x,p.y) || document.querySelector('canvas');
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk()); el.dispatchEvent(mk());
  return p;
})()`);
await sleep(350);
const sDup = await state();
T('dup ' + JSON.stringify({ dup, dups: sDup.dups, bombs: sDup.bombs.length, inputs: sDup.inputs }));
ok(sDup.dups >= 1, 'the second event of a double tap is dropped', sDup.dups);
ok(sDup.bombs.length === 1, 'a double tap drops one bomb, not two', sDup.bombs.length);

// ---------- 11) play a real match from the default deal ----------
await ev("window.__bim.setup({ seed: 21 })");
await sleep(250);
const sPlay = await state();
const stMid = await ev('window.__bim.step(6)');
const shotPlay0 = await shot('bim-gate-play');
T('play ' + JSON.stringify({ sPlay: sPlay && { foes: sPlay.foes.length, crates: sPlay.crates }, stMid }));
ok(stMid && (stMid.t > 4 || stMid.result), 'the arena clock runs (a live match advances)', stMid);

// tile art: a mid-explosion frame (a lit fuse alone reads as a dull board on the face)
await ev("window.__bim.setup({ seed: 8, crates: [[6,3],[6,5],[8,3],[4,3],[4,5],[6,7]], bombs: [{ c: 3, r: 3, range: 2, t: 0.02 }, { c: 5, r: 3, range: 2, t: 1.3 }] })");
await sleep(200);
await ev('window.__bim.step(0.3); window.__bim.pause(true)');   // hold the blast on screen
T('art ' + JSON.stringify((await state())));   // blasts must be live in the frozen frame
const shotArt = await shot('bim-art');
await ev('window.__bim.pause(false)');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await copyFile(shotArt, '/home/cluer/cloned-free-games/.queue/lib-art/Bim.png');

// ---------- 12) portrait / touch ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
await ev("window.__bim.setup({ clearCrates: true, seed: 5 })");
await sleep(300);
{
  const hud = await ev(`(()=>{const e=document.querySelector('.brand h1');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (hud) { await click(hud); await sleep(200); }
}
const pInfo = await ev(`(()=>{
  const band = window.__bim.band();
  const pts = [];
  for (let r=0;r<9;r++) for (let c=0;c<11;c++) pts.push(window.__bim.cellPoint(c,r));
  const inside = pts.every(p => p.x >= 0 && p.x <= innerWidth && p.y >= band.topPx && p.y <= band.botPx);
  let bad = 0;
  for (let r=0;r<9;r++) for (let c=0;c<11;c++) {
    const p = window.__bim.cellPoint(c,r); const b = window.__bim.cellAt(p.x,p.y);
    if (!b || b.c!==c || b.r!==r) bad++;
  }
  const corners = [[1,1],[9,1],[1,7],[9,7]].map(([c,r]) => { const p=window.__bim.cellPoint(c,r); return {c,r,x:Math.round(p.x),y:Math.round(p.y)}; });
  return { view: innerWidth+'x'+innerHeight, band, inside, bad, corners };
})()`);
T('portrait ' + JSON.stringify(pInfo));
ok(pInfo && pInfo.view === '390x844', 'the viewport really is 390x844', pInfo && pInfo.view);
ok(pInfo && pInfo.inside, 'every cell sits between the HUD bars in portrait', pInfo && { band: pInfo.band, corners: pInfo.corners });
ok(pInfo && pInfo.bad === 0, 'the picker still round-trips in portrait', pInfo && pInfo.bad);

const ptP = await cellPt(3, 1);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(450);
let sTouch = await state();
if (sTouch.c === 1 && sTouch.r === 1) { await click(ptP); await sleep(450); sTouch = await state(); }
T('touch ' + JSON.stringify({ ptP, c: sTouch.c, r: sTouch.r }));
ok(sTouch.c !== 1 || sTouch.r !== 1, 'a finger tap walks the bomber on the phone', { c: sTouch.c, r: sTouch.r });
const shotPortrait = await shot('bim-gate-portrait');

// ---------- 13) console errors ----------
const errs = pageCdp.events
  .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params).slice(0, 160));
ok(errs.length === 0, 'no console exceptions during the whole gate', errs.slice(0, 4));

console.log(JSON.stringify({ fails, shots: { shotWin, shotPlay0, shotPortrait, shotArt } }, null, 1));
T(fails.length ? `FAILED — ${fails.length} check(s)` : 'PASS — every gate check passed');
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
