#!/usr/bin/env node
// Interaction gate for the Beat Feet port. Real CDP clicks on the on-screen pad and real taps on
// the track, with state-hook assertions: the beat clock runs, timed presses score perfect/good,
// a bar is dodged by stepping out of its lane, a missed beat costs a heart, the song-end win sheet
// and the hearts-out lose sheet both open from real play, restart resets, the double-tap guard
// holds, plus a 390x844 portrait pass. Console errors are captured and must stay empty.
// usage: node beatfeet-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/beat-feet/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
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
const PROFILE = mkdtempSync('/tmp/beatfeet-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', '--no-first-run',
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
const until = async (fn, ms = 12000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__beatfeet()');
const actPoint = (kind) => ev(`window.__beatfeet.actionPoint('${kind}')`);
const actClick = async (kind) => {
  const p = await actPoint(kind);
  if (!p || p.__err || !Number.isFinite(p.x)) return { err: (p && p.__err) || 'bad point', p };
  await click(p);
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
const hookType = await ev('typeof window.__beatfeet');
const b0 = await state();
const song = await ev('window.__beatfeet.song(7)');
const shotBoot = await shot('beatfeet-gate-boot');
T('boot ' + JSON.stringify({ hookType, t: b0 && b0.t, lane: b0 && b0.lane, hearts: b0 && b0.hearts, obs: b0 && b0.obsLeft, calls: b0 && b0.calls, song: song && song.length }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(b0 && b0.hearts === 3 && b0.lane === 1 && b0.obsLeft > 10, 'boot is a live run: three hearts, middle lane, a full song', b0 && { hearts: b0.hearts, lane: b0.lane, obsLeft: b0.obsLeft });
ok(b0 && b0.calls > 5, 'the renderer is drawing the track this frame', b0 && b0.calls);
ok(Array.isArray(song) && song[0].beat === 8 && song[0].kind === 'gate', 'the deterministic opener is a beat-8 hurdle', song && song[0]);

// ---------- 2) play the beats for real: pad clicks timed off the hook ----------
// Poll fast and press inside the ~0.10 s perfect window; the state hook says when the beat is.
let pressed = 0, missedWorst = 0;
const playFor = async (ms) => {
  const t0 = Date.now();
  const seen = new Set();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (!s || s.over) break;
    const n = s.next;
    if (n && !seen.has(n.beat) && n.inSec <= 0.075 && n.inSec > 0.005) {
      if (n.kind === 'gate') { await actClick('jump'); pressed++; seen.add(n.beat); }
      else if (n.kind === 'low') { await actClick('duck'); pressed++; seen.add(n.beat); }
      else if (n.lanes.includes(s.lane)) {
        const free = [0, 1, 2].find((l) => !n.lanes.includes(l));
        if (free !== undefined) {
          await actClick(free < s.lane ? 'left' : 'right');
          while ((await state()).lane !== free) await actClick(free < (await state()).lane ? 'left' : 'right');
          pressed++; seen.add(n.beat);
        }
      }
      continue;
    }
    missedWorst = Math.max(missedWorst, s.misses);
    await sleep(25);
  }
  return await state();
};
const sPlay = await playFor(13000);
const shotPlay = await shot('beatfeet-gate-play');
T('play ' + JSON.stringify({ pressed, t: sPlay && sPlay.t, judged: sPlay && sPlay.judged, perfect: sPlay && sPlay.perfect, good: sPlay && sPlay.good, dodges: sPlay && sPlay.dodges, misses: sPlay && sPlay.misses, acc: sPlay && sPlay.acc, hearts: sPlay && sPlay.hearts }));
ok(pressed >= 4, 'the gate landed at least four real presses on the beat', pressed);
ok(sPlay && sPlay.judged >= 4, 'the beat clock reached the hazards (real seconds, not rAF)', sPlay && { t: sPlay.t, judged: sPlay.judged });
ok(sPlay && sPlay.perfect + sPlay.good + sPlay.dodges >= 3, 'timed pad clicks did not score any beats', sPlay && { perfect: sPlay.perfect, good: sPlay.good, dodges: sPlay.dodges });
ok(sPlay && sPlay.hearts >= 2, 'playing the opening cost more than one heart', sPlay && { hearts: sPlay.hearts, misses: sPlay.misses });

// ---------- 3) an untended beat costs a heart, and three cost the run ----------
await ev('window.__beatfeet.setup({seed:7, hearts:1, script:[{kind:"gate", lane:[0,1,2], inSec:1.1}]})');
const sMiss = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 9000, 150);
const sheetLose = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shotLose = await shot('beatfeet-gate-lose');
T('lose ' + JSON.stringify({ sMiss: sMiss && { over: sMiss.over, won: sMiss.won, why: sMiss.why, hearts: sMiss.hearts, misses: sMiss.misses }, sheetLose }));
ok(sMiss && sMiss.over && !sMiss.won && sMiss.why === 'hearts', 'ignoring a hazard did not end the run on hearts', sMiss && { over: sMiss.over, why: sMiss.why, hearts: sMiss.hearts });
ok(sMiss && sMiss.misses >= 1 && sMiss.hearts === 0, 'the missed beat did not draw the last heart', sMiss && { misses: sMiss.misses, hearts: sMiss.hearts });
ok(sheetLose && sheetLose.open && /drops you/.test(sheetLose.title), "the lose sheet did not open with its own title", sheetLose);

// ---------- 4) restart from the sheet's own button ----------
await actClick('left').catch(() => {});                    // a stray press on the track is refused while over
const bRestart = await ev(`(()=>{const e=document.getElementById('overBtn');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(bRestart);
await sleep(700);
const sRestart = await state();
T('restart ' + JSON.stringify({ t: sRestart && sRestart.t, hearts: sRestart && sRestart.hearts, over: sRestart && sRestart.over, sheet: sRestart && sRestart.sheet }));
ok(sRestart && !sRestart.over && !sRestart.sheet && sRestart.hearts === 3 && sRestart.t < 2.2, 'Play again did not start a fresh run', sRestart && { over: sRestart.over, hearts: sRestart.hearts, t: sRestart.t });

// ---------- 5) the song-end win sheet, from real play of the tail ----------
await ev('window.__beatfeet.setup({seed:7, fromBeat:56, hearts:3})');
const sTail0 = await state();
T('tail ' + JSON.stringify({ t: sTail0.t, obsLeft: sTail0.obsLeft, next: sTail0.next, acc: sTail0.acc }));
const sWin = await until(async () => {
  const s = await state();
  if (!s) return null;
  const n = s.next;
  if (!s.over && n && n.inSec <= 0.075 && n.inSec > 0.005) {
    if (n.kind === 'gate') await actClick('jump');
    else if (n.kind === 'low') await actClick('duck');
    else if (n.lanes.includes(s.lane)) {
      const free = [0, 1, 2].find((l) => !n.lanes.includes(l));
      if (free !== undefined) await actClick(free < s.lane ? 'left' : 'right');
    }
  }
  return s.over ? s : null;
}, 14000, 40);
const sheetWin = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shotWin = await shot('beatfeet-gate-win');
T('win ' + JSON.stringify({ sWin: sWin && { over: sWin.over, won: sWin.won, why: sWin.why, grade: sWin.grade, acc: sWin.acc, score: sWin.score, misses: sWin.misses }, sheetWin }));
ok(sWin && sWin.over && sWin.won && sWin.why === 'song', 'playing the tail to the end of the track did not win', sWin && { over: sWin.over, won: sWin.won, why: sWin.why });
ok(sWin && sWin.grade && /[SABC]/.test(sWin.grade), 'the win was not graded', sWin && sWin.grade);
ok(sheetWin && sheetWin.open && /Track cleared/.test(sheetWin.title), 'the win sheet did not open with its grade', sheetWin);
ok(sWin && sWin.acc >= 80, 'playing the tail on the beat scored below a B', sWin && sWin.acc);

// ---------- 6) the double-tap guard: two pointerups inside one page tick ----------
await ev('window.__beatfeet.setup({seed:7})');
const before = await state();
await ev(`(()=>{const p=window.__beatfeet.lanePoint(0);const o={bubbles:true,clientX:p.x,clientY:p.y,pointerType:'mouse'};
  document.body.dispatchEvent(new PointerEvent('pointerup',o));document.body.dispatchEvent(new PointerEvent('pointerup',o));})()`);
await sleep(300);
const after = await state();
T('dups ' + JSON.stringify({ taps: after.taps, dups: after.dups, lane: after.lane, laneChanges: after.laneChanges }));
ok(after.taps > before.taps, 'a synthetic pointerup never reached the page', { before: before.taps, after: after.taps });
ok(after.dups >= 1 && after.taps - before.taps === after.dups + 1, 'the same-point double tap was not swallowed', { tapsDelta: after.taps - before.taps, dups: after.dups });
ok(after.lane === 0, 'a tap on lane 0 did not move the runner there', { lane: after.lane, laneChanges: after.laneChanges });

// ---------- 7) portrait 390x844: the lanes are on screen and the pad works ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`window.__beatfeet.setup({seed:7, hearts:3})`);
await sleep(900);
const geo = await ev(`(()=>{const c=document.querySelector('body > canvas').getBoundingClientRect();
  const b=document.querySelector('.bottom').getBoundingClientRect();
  const top=document.querySelector('.top').getBoundingClientRect();
  return {w:innerWidth,h:innerHeight,canvas:{w:Math.round(c.width),h:Math.round(c.height)},
    band:{top:Math.round(top.bottom),bottom:Math.round(b.top)},
    lanes:[0,1,2].map(i=>window.__beatfeet.lanePoint(i)),
    pad:['left','jump','duck','right'].map(k=>window.__beatfeet.actionPoint(k))};})()`);
const beforePortrait = await state();
const pb = await actClick('left');
await sleep(350);
const afterPortrait = await state();
const shotPortrait = await shot('beatfeet-gate-portrait');
T('portrait ' + JSON.stringify({ geo, lane: afterPortrait && afterPortrait.lane, pb }));
ok(geo && geo.canvas && geo.canvas.w === 390 && geo.canvas.h === 844, 'the renderer did not resize for the portrait viewport', geo && geo.canvas);
ok(geo && Array.isArray(geo.lanes) && geo.lanes.every((p) => p.x > 4 && p.x < 386), 'a lane centre is off the portrait screen', geo && geo.lanes);
ok(geo && Array.isArray(geo.lanes) && geo.lanes.every((p) => p.y > geo.band.top && p.y < geo.band.bottom), 'a lane centre is behind the HUD bars', geo && { lanes: geo.lanes, band: geo.band });
ok(geo && Array.isArray(geo.pad) && geo.pad.every((p) => p.y > 0 && p.y < 844 && p.x > 0 && p.x < 390), 'a pad button is off screen', geo && geo.pad);
ok(afterPortrait && afterPortrait.lane === beforePortrait.lane - 1, 'the portrait pad click did not change lane', { before: beforePortrait.lane, after: afterPortrait.lane, pb });

// ---------- 8) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown'
  || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/i.test(e.params.entry.text || '')));
T('console ' + JSON.stringify(errors.map((e) => (e.params.entry && e.params.entry.text) || (e.params.exceptionDetails && e.params.exceptionDetails.text))));
ok(errors.length === 0, 'the page logged console errors', errors.map((e) => (e.params.entry && e.params.entry.text) || 'exception'));

console.log(JSON.stringify({ shots: [shotBoot, shotPlay, shotLose, shotWin, shotPortrait], pressed, fails }, null, 1));
console.log(fails.length ? `GATE FAIL (${fails.length})` : 'GATE PASS');
proc.kill('SIGKILL'); server.close();
process.exit(fails.length ? 1 : 0);
