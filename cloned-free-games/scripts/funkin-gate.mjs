#!/usr/bin/env node
// Interaction gate for the Friday Night Funkin' port. Real CDP mouse clicks on the on-screen lane
// pads, real taps on the board, and state-hook assertions: the chart clock runs on wall time, a
// timed press is judged sick/good/ok, an ignored arrow costs hype, the empty hype bar opens the
// lose sheet, Play again restarts, the song tail played on the beat opens the win sheet, the
// double-tap guard holds, plus a 390x844 portrait pass. Console errors must stay empty.
// usage: node funkin-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/funkin/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const CMD_TIMEOUT = 180000;
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
const PROFILE = mkdtempSync('/tmp/funkin-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const bail = (why) => { try { proc.kill('SIGKILL'); } catch {} T('ABORT ' + why); process.exit(2); };
process.on('SIGTERM', () => bail('sigterm'));
process.on('unhandledRejection', (e) => bail('unhandled ' + (e && e.message)));

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
const until = async (fn, ms = 15000, step = 60) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const bootT0 = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
const booted = await until(async () => (await ev('typeof window.__funkin')) === 'function', 90000, 250);
T('boot hook after ' + ((Date.now() - bootT0) / 1000).toFixed(1) + 's');

const click = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__funkin()');
const padPoint = (i) => ev(`window.__funkin.padPoint(${i})`);
const padClick = async (i) => { const p = await padPoint(i); await click(p); return p; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const b0 = await state();
const chart = await ev('window.__funkin.chart(0)');
const shotBoot = await shot('funkin-gate-boot');
T('boot ' + JSON.stringify({ booted, health: b0 && b0.health, notesLeft: b0 && b0.notesLeft, chart: chart && chart.length, next: b0 && b0.next, calls: b0 && b0.calls }));
ok(booted === true, 'the state hook is a function (the catalog gate reads typeof frame.__hook)', booted);
ok(b0 && b0.health === 0.5 && b0.notesLeft > 20, 'boot is not a live song at half hype', b0 && { health: b0.health, notesLeft: b0.notesLeft });
ok(b0 && b0.calls > 5, 'the renderer is drawing the board', b0 && b0.calls);
ok(Array.isArray(chart) && chart[0].beat === 4 && chart[0].lane === 0, 'the chart does not open on beat 4 lane 0', chart && chart[0]);
ok(b0 && b0.next && b0.next.beat === 4 && b0.next.inSec > 1, 'the hook has no runway to the first arrow', b0 && b0.next);

// ---------- 2) ignore the first arrow: a real miss costs hype ----------
const preMiss = await state();
const sMiss = await until(async () => {
  const s = await state();
  return s && s.miss > preMiss.miss ? s : null;
}, 12000, 60);
T('miss ' + JSON.stringify({ miss: sMiss && sMiss.miss, health: sMiss && sMiss.health, last: sMiss && sMiss.last }));
ok(sMiss && sMiss.miss >= 1, 'an untouched arrow was never judged a miss', sMiss && { miss: sMiss.miss, beat: sMiss.beat });
ok(sMiss && sMiss.health < 0.5, 'a missed arrow did not drain the hype bar', sMiss && sMiss.health);

// ---------- 3) play for real: pad clicks timed off the hook ----------
await ev('window.__funkin.setup({song:0, health:1})');
await sleep(400);
let pressed = 0, boardTaps = 0;
const playFor = async (ms, allowBoardTap = false) => {
  const t0 = Date.now();
  const seen = new Set();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (!s || s.over) break;
    const n = s.next;
    if (n && !seen.has(n.beat + ':' + n.lane) && n.inSec <= 0.075 && n.inSec > 0.004) {
      seen.add(n.beat + ':' + n.lane);
      if (allowBoardTap && boardTaps < 2) {
        // a real tap on the lane column of the board itself, not the HUD pad
        const p = await ev(`window.__funkin.lanePoint(${n.lane})`);
        await click({ x: p.x, y: Math.round(p.y - 40) });
        boardTaps++;
      } else {
        await padClick(n.lane);
      }
      pressed++;
      continue;
    }
    await sleep(20);
  }
  return await state();
};
const sPlay = await playFor(11000, true);
const shotPlay = await shot('funkin-gate-play');
T('play ' + JSON.stringify({ pressed, boardTaps, beat: sPlay && sPlay.beat, sick: sPlay && sPlay.sick, good: sPlay && sPlay.good, ok: sPlay && sPlay.ok, miss: sPlay && sPlay.miss, acc: sPlay && sPlay.acc, health: sPlay && sPlay.health }));
ok(pressed >= 5, 'the gate landed fewer than five real presses', pressed);
ok(sPlay && sPlay.judged >= 5, 'the chart clock never reached the arrows (wall-time pump)', sPlay && { beat: sPlay.beat, judged: sPlay.judged });
ok(sPlay && sPlay.sick + sPlay.good + sPlay.ok >= 4, 'on-beat presses were not judged as hits', sPlay && { sick: sPlay.sick, good: sPlay.good, ok: sPlay.ok });
ok(sPlay && sPlay.acc >= 60, 'playing on the beat scored under 60 %', sPlay && sPlay.acc);
ok(boardTaps >= 1, 'no press went through the board itself (only the HUD pads)', boardTaps);

// ---------- 4) the lose sheet: an empty hype bar, reached by ignoring a real arrow ----------
await ev('window.__funkin.setup({song:1, health:0.05, noChart:true, script:[{lane:2, inSec:1.0}]})');
const sLose = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 12000, 100);
const sheetLose = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shotLose = await shot('funkin-gate-lose');
T('lose ' + JSON.stringify({ sLose: sLose && { over: sLose.over, won: sLose.won, why: sLose.why, health: sLose.health, miss: sLose.miss }, sheetLose }));
ok(sLose && sLose.over && !sLose.won && sLose.why === 'hype', 'ignoring the arrow did not empty the hype bar', sLose && { over: sLose.over, why: sLose.why, health: sLose.health });
ok(sLose && sLose.miss >= 1 && sLose.health === 0, 'the missed arrow did not drain the last hype', sLose && { miss: sLose.miss, health: sLose.health });
ok(sheetLose && sheetLose.open && /boos you off/.test(sheetLose.title), 'the lose sheet did not open with its own title', sheetLose);

// a tap on a finished board is refused
const blockedBefore = (await state()).blocked;
await ev(`(()=>{const p=window.__funkin.lanePoint(0);const o={bubbles:true,clientX:p.x,clientY:p.y,pointerType:'mouse'};document.body.dispatchEvent(new PointerEvent('pointerup',o));})()`);
const blockedAfter = (await state()).blocked;
ok(blockedAfter > blockedBefore, 'a tap on the finished board was accepted', { blockedBefore, blockedAfter });

// ---------- 5) Play again from the sheet's own button ----------
const overBtn = await ev(`(()=>{const r=document.getElementById('overBtn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(overBtn);
await sleep(700);
const sRestart = await state();
T('restart ' + JSON.stringify({ beat: sRestart && sRestart.beat, health: sRestart && sRestart.health, over: sRestart && sRestart.over, sheet: sRestart && sRestart.sheet }));
ok(sRestart && !sRestart.over && !sRestart.sheet && sRestart.health === 0.5 && sRestart.beat < 2.5,
  'Play again did not start a fresh run', sRestart && { over: sRestart.over, health: sRestart.health, beat: sRestart.beat });

// ---------- 6) the tail played on the beat opens the win sheet ----------
const tail = await ev('window.__funkin.setup({song:0, fromBeat:72, health:1})');
T('tail ' + JSON.stringify({ beat: tail.beat, notesLeft: tail.notesLeft, next: tail.next }));
const sWin = await until(async () => {
  const s = await state();
  if (!s) return null;
  const n = s.next;
  if (!s.over && n && n.inSec <= 0.075 && n.inSec > 0.004) await padClick(n.lane);
  return s.over ? s : null;
}, 20000, 40);
const sheetWin = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shotWin = await shot('funkin-gate-win');
T('win ' + JSON.stringify({ sWin: sWin && { over: sWin.over, won: sWin.won, why: sWin.why, grade: sWin.grade, acc: sWin.acc, score: sWin.score, miss: sWin.miss }, sheetWin }));
ok(sWin && sWin.over && sWin.won && sWin.why === 'song', 'playing the tail to the end did not clear the song', sWin && { over: sWin.over, won: sWin.won, why: sWin.why });
ok(sWin && /[SABC]/.test(sWin.grade || ''), 'the cleared song was not graded', sWin && sWin.grade);
ok(sWin && sWin.acc >= 80, 'playing the tail on the beat scored below a B', sWin && sWin.acc);
ok(sheetWin && sheetWin.open && /Song cleared/.test(sheetWin.title), 'the win sheet did not open with its grade', sheetWin);

// ---------- 7) double-tap guard: two pointerups inside one page tick ----------
await ev('window.__funkin.setup({song:2, health:1})');
const before = await state();
await ev(`(()=>{const p=window.__funkin.lanePoint(1);const o={bubbles:true,clientX:p.x,clientY:p.y,pointerType:'mouse'};
  document.body.dispatchEvent(new PointerEvent('pointerup',o));document.body.dispatchEvent(new PointerEvent('pointerup',o));})()`);
await sleep(300);
const after = await state();
T('dups ' + JSON.stringify({ taps: after.taps, dups: after.dups, presses: after.presses, ghosts: after.ghosts }));
ok(after.taps > before.taps, 'a synthetic pointerup never reached the page', { before: before.taps, after: after.taps });
ok(after.dups >= 1 && after.taps - before.taps === after.dups + 1, 'the same-point double tap was not swallowed',
  { tapsDelta: after.taps - before.taps, dups: after.dups });
ok(after.presses > before.presses, 'a tap on lane 1 did not press that lane', { before: before.presses, after: after.presses });

// ---------- 8) portrait 390x844 ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(400);
await ev('window.__funkin.setup({song:0, health:1})');
await sleep(700);
const geo = await ev(`(()=>{const c=document.querySelector('body > canvas').getBoundingClientRect();
  const b=document.querySelector('.bottom').getBoundingClientRect();
  const top=document.querySelector('.top').getBoundingClientRect();
  return {w:innerWidth,h:innerHeight,canvas:{w:Math.round(c.width),h:Math.round(c.height)},
    band:{top:Math.round(top.bottom),bottom:Math.round(b.top)},
    lanes:[0,1,2,3].map(i=>window.__funkin.lanePoint(i)),
    pads:[0,1,2,3].map(i=>window.__funkin.padPoint(i))};})()`);
const bs = await state();
await padClick(3);
await sleep(300);
const as = await state();
const shotPortrait = await shot('funkin-gate-portrait');
T('portrait ' + JSON.stringify({ geo, before: bs.presses, after: as.presses }));
ok(geo && geo.canvas && geo.canvas.w === 390 && geo.canvas.h === 844, 'the renderer did not resize for the portrait viewport', geo && geo.canvas);
ok(geo && geo.lanes.every((p) => p.x > 4 && p.x < 386), 'a lane centre is off the portrait screen', geo && geo.lanes);
ok(geo && geo.lanes.every((p) => p.y > geo.band.top && p.y < geo.band.bottom), 'a lane centre is behind the HUD bars', geo && { lanes: geo.lanes, band: geo.band });
ok(geo && geo.pads.every((p) => p.y > 0 && p.y < 844 && p.x > 0 && p.x < 390), 'a lane pad is off screen', geo && geo.pads);
ok(as.presses > bs.presses, 'the portrait pad click did not press a lane', { before: bs.presses, after: as.presses });

// ---------- 9) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown'
  || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/i.test(e.params.entry.text || '')));
T('console ' + JSON.stringify(errors.map((e) => (e.params.entry && e.params.entry.text) || (e.params.exceptionDetails && e.params.exceptionDetails.text))));
ok(errors.length === 0, 'the page logged console errors',
  errors.map((e) => (e.params.entry && e.params.entry.text) || 'exception'));

console.log(JSON.stringify({ shots: [shotBoot, shotPlay, shotLose, shotWin, shotPortrait], pressed, boardTaps, fails }, null, 1));
console.log(fails.length ? `GATE FAIL (${fails.length})` : 'GATE PASS');
proc.kill('SIGKILL'); server.close();
process.exit(fails.length ? 1 : 0);
