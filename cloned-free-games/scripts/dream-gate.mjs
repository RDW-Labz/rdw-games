#!/usr/bin/env node
// Interaction gate for the "I Keep Having This Dream" port. Real CDP mouse clicks on the three hand
// cards, every assertion read from the page's own state hook: lay a tile, walk a whole cycle through
// the gate, play a campaign to the win sheet, force a loss from a QA position, restart, and a
// portrait touch. usage: node dream-gate.mjs [site-root] [shot-prefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PREFIX = process.argv[3] || 'dream-gate';
const FILE = 'games/arcade/i-keep-having-this-dream/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
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
const PROFILE = mkdtempSync('/tmp/dream-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { T('fatal ' + (e && e.message)); kill(); process.exit(1); });
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
const until = async (fn, ms = 30000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
const booted = await until(async () => (await ev('typeof window.__dream')) === 'function', 90000, 400);
T(`boot hook after ${Date.now() - t0} ms: ${booted}`);
ok(booted === true, 'the page boots its state hook');
await sleep(1200);

const shot = async (name) => {
  await mkdir(OUT, { recursive: true });
  const r = await S('Page.captureScreenshot', { format: 'png' });
  const path = join(OUT, `${PREFIX}-${name}.png`);
  await (await import('node:fs/promises')).writeFile(path, Buffer.from(r.data, 'base64'));
  T('shot ' + path);
  return path;
};

const st = () => ev('window.__dream()');
const cardPoint = (i) => ev(`window.__dream.handPoint(${i})`);
const clickPt = async (pt, wait = 220) => {
  if (!pt || pt.__err || typeof pt.x !== 'number') return false;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(wait);
  return true;
};
const clickEl = async (id, wait = 320) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  return clickPt(b, wait);
};

const rules = await ev('window.__dream.rules');
ok(!!rules && rules.BUILD === 16 && rules.CYCLES === 3, 'the port publishes its rules to the gate', rules && { BUILD: rules.BUILD, CYCLES: rules.CYCLES, DEEP: rules.DEEP });

// The gate's own forecast, written independently of the port so a wrong rule in the page cannot
// hide behind a matching helper: rounds = ceil(hp/atk), damage per round past defence, one chase slot
// per round, and the deep-slot enemies hit one harder.
function scoreTile(s, t) {
  if (t.kind === 'star') return 100;
  if (t.kind === 'ward') return s.def < 4 ? 80 : 40;
  if (t.kind === 'dew') return s.hp <= 9 ? 70 : 30;
  if (t.kind === 'mist') return 20;
  const eatk = t.atk + ((s.pos + 1) >= rules.DEEP ? 1 : 0);
  const rounds = Math.max(1, Math.ceil(t.hp / Math.max(1, s.atk)));
  const dmg = rounds * Math.max(0, eatk - s.def);
  return 10 - rounds * 12 - dmg * 0.5;
}
const choose = (s) => {
  let best = 0, bs = -1e9;
  s.hand.forEach((t, i) => { const sc = scoreTile(s, t); if (sc > bs) { bs = sc; best = i; } });
  return best;
};

// ---------- 1) the opening board ----------
{
  // every dream below is dealt from seed 1 so the gate is reproducible; the core test is what proves
  // the deal varies by seed and that the ladder is real.
  const a = await ev('window.__dream.restart(1)');
  const b = await ev('window.__dream.restart(1)');
  ok(a && b && JSON.stringify(a.hand) === JSON.stringify(b.hand) && a.deck === b.deck,
    'the same seed deals the same dream twice', { a: a && a.hand, b: b && b.hand });
  const s0 = await st();
  ok(s0 && s0.cycle === 1 && s0.pos === 0 && s0.placed === 0 && s0.over === false, 'a fresh dream starts on the entrance of cycle 1', s0);
  ok(s0.hand.length === 3 && s0.cards === 3, 'the dream offers three tiles, and three cards are on screen', { hand: s0.hand.length, cards: s0.cards });
  ok(s0.hp === 12 && s0.atk === 2 && s0.def === 1 && s0.gap === 8, 'the HUD numbers come from the same state the hook reads', { hp: s0.hp, atk: s0.atk, def: s0.def, gap: s0.gap });
  const canvas = await ev(`(()=>{const c=document.querySelector('canvas');return c?{w:c.width,h:c.height}:null;})()`);
  ok(canvas && canvas.w > 0 && canvas.h > 0, 'a WebGL canvas is sized to the window', canvas);
  await shot('boot');
}

// ---------- 2) one real click lays one tile ----------
{
  const before = await st();
  const pt = await cardPoint(0);
  ok(!!pt && typeof pt.x === 'number', 'the hook hands out the screen point of a card', pt);
  const clicked = await clickPt(pt, 300);
  const after = await st();
  ok(clicked, 'a real mouse click landed on the first card');
  ok(after.placed === before.placed + 1, 'the click laid exactly one tile', { before: before.placed, after: after.placed });
  ok(after.pos === 1 && after.inputs === before.inputs + 1, 'the visitor stands on slot 1 and the tap was counted', { pos: after.pos, inputs: after.inputs, dups: after.dups });
  ok(after.built === 1, 'the laid tile is on the path', after.built);
  // the click changed real numbers, not just the DOM: playing the tile had its cost
  const played = before.hand[0];
  if (played.kind === 'enemy') {
    const eatk = played.atk + (1 >= rules.DEEP ? 1 : 0);
    const rounds = Math.max(1, Math.ceil(played.hp / Math.max(1, before.atk)));
    ok(after.hp === before.hp - rounds * Math.max(0, eatk - before.def), 'the fight cost hp exactly as the card promised', { before: before.hp, after: after.hp, rounds });
    ok(after.gap === before.gap - rounds, 'the fight cost the chase exactly as many slots as rounds', { before: before.gap, after: after.gap, rounds });
  } else if (played.kind === 'star') {
    ok(after.atk === before.atk + 1, 'the star raised attack', { before: before.atk, after: after.atk });
  } else if (played.kind === 'ward') {
    ok(after.def === before.def + 1, 'the ward raised defence', { before: before.def, after: after.def });
  } else if (played.kind === 'dew') {
    ok(after.hp === Math.min(12, before.hp + 3), 'the dew healed up to the cap', { before: before.hp, after: after.hp });
  } else {
    ok(after.hp === before.hp && after.gap === before.gap, 'mist costs nothing', { hp: after.hp, gap: after.gap });
  }
}

// ---------- 3) walk a whole cycle through the gate ----------
{
  await ev('window.__dream.restart(1)');
  await sleep(200);
  let s = await st();
  let guard = 0;
  while (!s.over && s.cycle === 1 && guard++ < 40) {
    const i = choose(s);
    const pt = await cardPoint(i);
    if (!(await clickPt(pt, 180))) break;
    s = await st();
    if (s.placed === 8 && !s.over) await shot('mid');
  }
  ok(s.cycle === 2 || (s.over && s.result === 'wake'), 'sixteen laid tiles walk the visitor through the gate', { cycle: s.cycle, placed: s.placed, over: s.over });
  if (!s.over) {
    ok(s.pos === 0 && s.built === 0, 'the next cycle opens an empty path', { pos: s.pos, built: s.built });
    ok(s.hand.length === 3 && s.cards === 3, 'the next cycle opens a fresh hand of three', { hand: s.hand.length, cards: s.cards });
    ok(s.gap === 8, 'the pursuer is left behind at the gate', s.gap);
  }
  await shot('cycle2');
}

// ---------- 4) play the campaign out to the win ----------
{
  await ev('window.__dream.restart(1)');
  await sleep(200);
  let s = await st();
  let guard = 0;
  while (!s.over && guard++ < 140) {
    const i = choose(s);
    const pt = await cardPoint(i);
    if (!(await clickPt(pt, 120))) break;
    s = await st();
  }
  T(`campaign ended: result ${s.result} · ${s.placed} tiles · cycle ${s.cycle} · ${s.hp} hp · ${s.atk} atk · ${s.def} def · ${s.inputs} taps`);
  ok(s.over === true, 'the campaign reaches a terminal state', { over: s.over, guard });
  ok(s.result === 'wake' && s.cycles === 3, 'an upgrade-first visitor escapes three cycles and wakes up', { result: s.result, cycles: s.cycles });
  ok(s.sheet === true, 'the end sheet is open on a finished dream', s.sheet);
  const title = await ev(`document.getElementById('overTitle').textContent`);
  ok(/wake/i.test(String(title)), 'the win sheet says the visitor woke up', title);
  await shot('win');
}

// ---------- 5) the loss: a QA position with nothing left to survive with ----------
{
  await clickEl('restart', 400);
  const prior = await st();
  const qa = await ev(`window.__dream.setup({hp:2, gap:3, pos:4, atk:1, def:1, hand:[{kind:'enemy',hp:9,atk:9}]})`);
  ok(qa && qa.over === false && qa.pos === 4 && qa.cards === 1, 'a QA position loads with one lethal tile in hand', qa && { pos: qa.pos, cards: qa.cards, hp: qa.hp });
  const pt = await cardPoint(0);
  const before = await st();
  await clickPt(pt, 340);
  const s = await st();
  ok(s.over === true && (s.result === 'hp' || s.result === 'gap'), 'laying the lethal tile ends the dream', { result: s.result, hp: s.hp, gap: s.gap, before: { hp: before.hp, gap: before.gap } });
  ok(s.sheet === true, 'the loss sheet opens', s.sheet);
  const title = await ev(`document.getElementById('overTitle').textContent`);
  ok(/pursuer|dream keeps you/i.test(String(title)), 'the loss sheet names what took the visitor', title);
  await shot('loss');
}

// ---------- 6) the sheet's own button restarts into a fresh dream ----------
{
  const before = await st();
  await clickEl('overBack', 420);
  const s = await st();
  ok(s.over === false && s.pos === 0 && s.cycle === 1 && s.hp === 12, 'the sheet button starts a clean dream', { cycle: s.cycle, pos: s.pos, hp: s.hp, over: s.over });
  ok(s.sheet === false, 'the sheet closes on a restart', s.sheet);
  await clickEl('newdream', 420);
  const n = await st();
  ok(n.over === false && n.seed !== undefined, 'the new-dream button deals again', { seed: n.seed });
}

// ---------- 7) portrait touch ----------
{
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  await clickPt({ x: 195, y: 120 }, 200);   // prime the override with a neutral press on the HUD
  const before = await st();
  const pt = await cardPoint(0);
  const okBox = pt && pt.y > 600 && pt.x > 0 && pt.x < 390;
  ok(okBox, 'the hand sits in the bottom bar of a 390x844 phone', pt);
  if (okBox) {
    const tp = [{ x: pt.x, y: pt.y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
    await sleep(80);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(360);
  }
  const after = await st();
  ok(after.placed === before.placed + 1, 'a finger tap on the card lays a tile', { before: before.placed, after: after.placed });
  await shot('portrait');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}

// ---------- 8) console / log errors ----------
{
  const bad = pageCdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text).filter((t) => !/favicon/i.test(t));
  const exc = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  ok(bad.length === 0, 'no console errors during the run', bad.slice(0, 4));
  ok(exc.length === 0, 'no uncaught exceptions during the run', exc.slice(0, 4));
}

kill();
server.close();
console.log(fails.length === 0 ? 'PASS dream gate' : `FAIL dream gate (${fails.length})`);
fails.forEach((f) => console.error('  · ' + f));
process.exit(fails.length === 0 ? 0 : 1);
