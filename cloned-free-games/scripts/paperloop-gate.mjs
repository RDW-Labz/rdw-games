#!/usr/bin/env node
// Interaction gate for the Paper Loop 2 port: serves the site repo root (so ./kit.js is the shipped
// file), drives headless Chromium with real CDP mouse/touch input, and asserts the state hook moves
// on every gesture. A canvas that merely exists is not proof.
//
// usage: node scripts/paperloop-gate.mjs [/path/to/site-repo]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = '/games/arcade/paper-loop-2/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CMD_TIMEOUT = 240000;

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
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws attach failed')); });
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

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/pl2-gate-');
const RUNTIME = mkdtempSync('/tmp/pl2-run-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1100,720', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('REJECT ' + (e && e.message)); kill(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools in 60s: ' + err.slice(-300))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});

const browserPort = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) throw new Error('no page target: ' + JSON.stringify(list).slice(0, 200));
const cdp = await CDP.attach(target.webSocketDebuggerUrl);
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const hook = () => ev('window.__paperloop ? window.__paperloop() : null');
const poll = async (expr, ms = 8000, step = 120) => {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  return !!cond;
};

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await cdp.send('Page.navigate', { url: base + PAGE });
const booted = await poll('typeof window.__paperloop === "function"', 90000);
console.log(`boot: ${booted ? 'hook live' : 'NO HOOK'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(!!booted, 'the state hook never appeared (module died?)', await ev('document.title'));

// ---- real pointer input ----
const press = async (pt) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const moveTo = async (pt) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'left', pointerType: 'mouse' });
};
const release = async (pt) => {
  const p = pt || { x: 640, y: 400 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const click = async (pt) => { await press(pt); await sleep(60); await release(pt); };
const elPoint = async (id) => ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:r.width,h:r.height};})()`);
const clickEl = async (id) => { const p = await elPoint(id); await click(p); await sleep(400); return p; };
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const point = (x, z) => ev(`window.__paperloop.point(${x},${z})`);

// ---- 1) boot: a live arena, two scripted rivals, nothing claimed yet ----
{
  const s = await hook();
  console.log('boot:', JSON.stringify({ mode: s?.mode, share: s?.share, cells: s?.cells, rivals: s?.rivals?.length, over: s?.over }));
  ok(s && s.mode === 'hard', 'the arena does not open in HARD mode', s?.mode);
  ok(s && s.rivals.length === 2 && s.rivals.every((r) => r.alive), 'the rivals are not both on the board', s?.rivals);
  ok(s && s.share > 0 && s.share < 0.05, 'the visitor does not start on a small patch of turf', s?.share);
  ok(s && s.over === false && s.sheet === '', 'the round is already over at boot', s?.sheet);
  ok(s && s.out === false && s.trail === 0, 'the head starts with a ribbon already laid', s?.trail);
  const p = await shot('paper-loop-2-boot');
  console.log('  boot shot:', p);
}

// ---- 2) the ground picker round-trips ----
{
  const bad = await ev(`(()=>{const h=window.__paperloop;const out=[];for(const [x,z] of [[0,0],[3,2],[-4,-4]]){const p=h.point(x,z);const w=h.pick(p.x,p.y);if(!w||Math.hypot(w.x-x,w.z-z)>0.12)out.push([x,z,w]);}return out;})()`);
  ok(Array.isArray(bad) && bad.length === 0, 'the ground picker does not round-trip on the arena', bad);
}

// ---- 3) a held pointer steers the head out, and a second press brings it home: a real loop ----
{
  const s0 = await hook();
  const away = await point(0, 0);   // aim at the middle of the arena, not at the rail behind the spawn
  await press(away);
  const mid = await poll('(()=>{const h=window.__paperloop();return h.out&&h.trail>=6?h:null})()', 25000);
  ok(!!mid, 'holding the pointer did not send the head off its turf', await hook());
  ok(mid && Math.abs(mid.you.heading - s0.you.heading) > 0.15, 'the head did not turn toward the pointer', [s0.you.heading, mid?.you.heading]);
  await shot('paper-loop-2-ribbon');
  const home = await point(s0.you.x, s0.you.z);
  await moveTo(home);
  const closed = await poll('window.__paperloop().loops>=1?window.__paperloop():null', 30000);
  await release(home);
  ok(!!closed, 'curling back into own turf never closed a loop', await hook());
  const after = await hook();
  ok(after && after.share > s0.share + 0.005, 'the closed loop did not claim ground', { before: s0.share, after: after?.share });
  ok(after && after.out === false && after.trail === 0, 'the ribbon survived the close', { out: after?.out, trail: after?.trail });
  await shot('paper-loop-2-claimed');
  console.log('  loop:', JSON.stringify({ from: s0.share, to: after?.share, loops: after?.loops }));
}

// ---- 4) the rails kill, and it ends the round with the lose sheet ----
{
  await ev('window.__paperloop.setup({mode:"none", x:0, z:7.4, heading:Math.PI/2})');
  const over = await poll('window.__paperloop().over ? window.__paperloop() : null', 15000);
  ok(!!over && over.result === 'lose' && over.cause === 'wall', 'drifting into the rails did not lose', { result: over?.result, cause: over?.cause });
  ok(over && over.sheet === 'Ribbon cut', 'the lose sheet did not open', over?.sheet);
  await shot('paper-loop-2-lose');
}

// ---- 5) a rival ribbon in the way is sliced, and its ground is released ----
{
  await ev('window.__paperloop.setup({mode:"hard", x:0, z:0, heading:0, rival:{x:3, z:0, heading:Math.PI/2}})');
  const hit = await poll('window.__paperloop().kills >= 1 ? window.__paperloop() : null', 15000);
  ok(!!hit, 'driving through a rival ribbon did not knock it out', await hook());
  const s = await hook();
  ok(s && s.rivals.some((r) => !r.alive && r.cause === 'sliced'), 'no rival is down as sliced', s?.rivals);
  ok(s && s.rivals.some((r) => !r.alive && r.cells === 0), 'the sliced rival kept its ground', s?.rivals);
  ok(s && s.you.alive, 'the visitor died on a rival ribbon');
}

// ---- 6) crossing the win share opens the win sheet ----
{
  await ev('window.__paperloop.setup({mode:"none", winAt:0.065, prefill:0.045, seed:7})');
  const s0 = await hook();
  ok(s0 && s0.share > 0.05 && s0.share < 0.065, 'the win fixture did not hand over its ground', s0?.share);
  const away = await point(0, 0);
  await press(away);
  const mid = await poll('(()=>{const h=window.__paperloop();return h.out&&h.trail>=6?h:null})()', 25000);
  ok(!!mid, 'the win run never got a ribbon down', await hook());
  const home = await point(s0.you.x, s0.you.z);
  await moveTo(home);
  const win = await poll('window.__paperloop().over ? window.__paperloop() : null', 30000);
  await release(home);
  ok(!!win && win.result === 'win', 'claiming past the target share did not win', { result: win?.result, share: win?.share, cause: win?.cause });
  ok(win && win.sheet === 'Arena claimed', 'the win sheet did not open', win?.sheet);
  ok(win && win.share >= 0.065, 'the win fired below the target share', win?.share);
  await shot('paper-loop-2-win');
  console.log('  win state:', JSON.stringify({ share: win?.share, loops: win?.loops, sheet: win?.sheet }));
}

// ---- 7) Play again restarts a live arena ----
{
  await clickEl('overBtn');
  const s = await poll('!window.__paperloop().over ? window.__paperloop() : null', 6000);
  ok(!!s, 'Play again left the round over', await hook());
  ok(s && s.sheet === '' && s.share < 0.05, 'the restart did not clear the sheet and the turf', { sheet: s?.sheet, share: s?.share });
  ok(s && s.you.alive && s.loops === 0, 'the restart kept the old run', { alive: s?.you.alive, loops: s?.loops });
}

// ---- 8) the mode button cycles and restarts on the new mode ----
{
  const before = (await hook()).mode;
  await clickEl('mode');
  const s = await hook();
  ok(s && s.mode !== before, 'the mode button did not cycle', [before, s?.mode]);
  ok(s && s.sheet === '' && s.loops === 0, 'the mode change did not restart', { sheet: s?.sheet, loops: s?.loops });
  const label = await ev("document.getElementById('mode').textContent");
  ok(label && label.includes(s.mode.toUpperCase()), 'the mode button label does not track the mode', label);
}

// ---- 9) portrait touch: a finger steers the head on a phone ----
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url: base + PAGE });
  const up = await poll('typeof window.__paperloop === "function"', 90000);
  ok(!!up, 'the port did not boot at 390x844');
  const s0 = await hook();
  const tgt = await point(s0.you.x - 4, s0.you.z);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tgt.x, y: tgt.y, id: 1 }] });
  await sleep(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tgt.x, y: tgt.y, id: 1 }] });
  await sleep(700);
  const s1 = await hook();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  ok(s1 && s1.out === true && s1.trail >= 4, 'a finger on the arena does not steer the head', { out: s1?.out, trail: s1?.trail });
  ok(s1 && Math.abs(s1.you.heading - s0.you.heading) > 0.05, 'the head did not turn toward the finger', [s0.you.heading, s1?.you.heading]);
  await shot('paper-loop-2-touch');
}

// ---- 10) no console errors along the way ----
{
  const bad = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.method === 'Runtime.exceptionThrown' ? (e.params.exceptionDetails.exception?.description || 'exception') : e.params.entry.text)
    .filter((t) => !/favicon|net::ERR_ABORTED/i.test(t));
  ok(bad.length === 0, 'the page logged runtime errors', bad.slice(0, 4));
}

console.log(fails ? `\nFAIL: ${fails} gate assertion(s)` : '\nPASS — paper loop 2 plays through real input');
kill();
process.exit(fails ? 1 : 0);
