#!/usr/bin/env node
// Interaction gate for the Principia port: serves the site repo root (so ./kit.js is the shipped
// file), drives headless Chromium with real CDP mouse/touch input, and asserts the state hook moves
// on every gesture. A canvas that merely exists is not proof — the marble has to land in the pit.
//
// usage: node scripts/principia-gate.mjs [/path/to/site-repo]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = '/games/arcade/principia/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const SOLS = JSON.parse(await readFile('/home/cluer/cloned-free-games/.queue/principia-solutions.json', 'utf8')).solutions;
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
const PROFILE = mkdtempSync('/tmp/pp-gate-');
const RUNTIME = mkdtempSync('/tmp/pp-run-');
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
const hook = () => ev('window.__principia ? window.__principia() : null');
const poll = async (expr, ms = 12000, step = 150) => {
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
const booted = await poll('typeof window.__principia === "function"', 90000);
console.log(`boot: ${booted ? 'hook live' : 'NO HOOK'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(!!booted, 'the state hook never appeared (module died?)', await ev('document.title'));

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
const elPoint = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled,txt:e.textContent.trim()};})()`);
const clickEl = async (id) => { const p = await elPoint(id); if (!p) return null; await click(p); await sleep(250); return p; };
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const wpt = (x, y) => ev(`window.__principia.point(${x},${y})`);
const knob = (k) => ev(`window.__principia.leverPoint(${k})`);

// ---- 1) boot: a live bench, one beam, nothing running ----
{
  const s = await hook();
  console.log('boot:', JSON.stringify({ level: s?.level, mode: s?.mode, angles: s?.angles, name: s?.name }));
  ok(s && s.level === 1 && s.mode === 'build', 'the bench does not open on rig 1 in build mode', s?.mode);
  ok(s && s.over === false && s.sheet === '', 'the bench opens already over', s?.sheet);
  ok(s && s.angles.length === 1 && s.angles[0] === -6, 'rig 1 does not open at its default angle', s?.angles);
  ok(s && s.ball.x === s.spawn.x && s.ball.y === s.spawn.y, 'the marble is not waiting at the spawn', s?.ball);
  console.log('  boot shot:', await shot('principia-boot'));
}

// ---- 2) the picker round-trips on the beam knob ----
{
  const bad = await ev(`(()=>{const h=window.__principia;const out=[];const p=h.leverPoint(0);const w=h.pick(p.x,p.y);if(!w)out.push(['null']);return out;})()`);
  ok(Array.isArray(bad) && bad.length === 0, 'the board picker returns nothing for the beam knob', bad);
}

// ---- 3) a real drag tips the beam ----
{
  const s0 = await hook();
  const p0 = await knob(0);
  await press(p0);
  const tgt = await wpt(-2.0, -1.4);      // drag the knob down and to the right
  await moveTo(tgt);
  await sleep(120);
  await moveTo(tgt);
  const mid = await hook();
  await release(tgt);
  const s1 = await hook();
  console.log('  drag:', JSON.stringify({ from: s0.angles[0], to: s1.angles[0], drags: s1.drags }));
  ok(s1.drags >= 1, 'the drag never reached the beam', s1.drags);
  ok(Math.abs(s1.angles[0] - s0.angles[0]) > 12, 'dragging the knob did not tip the beam', [s0.angles[0], s1.angles[0]]);
  ok(Math.abs(mid.angles[0] - s1.angles[0]) < 0.6, 'the beam did not settle where the pointer was released', [mid.angles[0], s1.angles[0]]);
  await shot('principia-tipped');
}

// ---- 4) Reset puts the beam back on the bench default ----
{
  await clickEl('reset');
  const s = await hook();
  ok(s.angles[0] === -6, 'Reset did not return the beam to its default', s.angles);
  ok(s.mode === 'build' && !s.over, 'Reset did not put the bench back in build mode', s.mode);
}

// ---- 5) Run on a bad angle loses, and the sheet says why ----
{
  await ev('window.__principia.setup({level:1, angles:[-75]})');
  await clickEl('run');
  const run = await hook();
  ok(run.mode === 'run', 'the Run button did not start the marble', run.mode);
  const lose = await poll('window.__principia().over ? window.__principia() : null', 20000);
  ok(!!lose && lose.result === 'lose', 'a flat beam still wins', lose && { result: lose.result, cause: lose.cause });
  ok(lose && lose.ball.y < lose.spawn.y, 'the marble never fell', lose?.ball);
  ok(lose && lose.sheet === 'Missed the pit', 'the lose sheet did not open', lose?.sheet);
  await shot('principia-lose');
}

// ---- 6) the sheet's own button rebuilds the bench ----
{
  const p = await elPoint('overBtn');
  ok(p && p.txt === 'Try again', 'the lose sheet does not offer a retry', p);
  await clickEl('overBtn');
  const s = await poll('window.__principia().sheet === "" ? window.__principia() : null', 5000);
  ok(!!s, 'the retry button left the sheet open', await hook());
  ok(s && s.mode === 'build' && !s.over, 'the retry did not rebuild the bench', s && { mode: s.mode, over: s.over });
}

// ---- 7) a proven build, run through the real button, lands the marble ----
{
  await ev(`window.__principia.setup({level:1, angles:[${SOLS[1].join(',')}]})`);
  const s0 = await hook();
  ok(s0.mode === 'build' && Math.abs(s0.angles[0] - SOLS[1][0]) < 0.5, 'the QA build did not load', s0.angles);
  const rp = await elPoint('run');
  ok(rp && rp.disabled === false, 'Run is disabled on a loadable build', rp);
  await clickEl('run');
  await sleep(850);                       // let the marble fly so the tile art catches it mid-run
  await shot('principia-action');
  const win = await poll('window.__principia().over ? window.__principia() : null', 20000);
  ok(!!win && win.result === 'win' && win.cause === 'pit', 'the proven build did not land the marble in the pit',
    win && { result: win.result, cause: win.cause, ball: win.ball });
  ok(win && win.ball.y < -4.4, 'the win did not put the marble below the floor', win?.ball);
  ok(win && win.sheet === 'In the pit', 'the win sheet did not open', win?.sheet);
  ok(win && win.runs >= 1, 'the run counter never moved off zero', win?.runs);
  const sheetText = await ev("document.getElementById('overText').textContent");
  ok(typeof sheetText === 'string' && /\d+ runs?/.test(sheetText), 'the win sheet does not report the run count', sheetText);
  const np = await elPoint('next');
  ok(np && np.disabled === false, 'Next rig is not offered after a win', np);
  await shot('principia-win');
  console.log('  win:', JSON.stringify({ t: win?.t, ball: win?.ball, sheet: win?.sheet }));
}

// ---- 8) every rig is winnable in the browser, not just in node ----
{
  for (let lv = 2; lv <= 5; lv++) {
    const sol = SOLS[lv];
    await ev(`window.__principia.setup({level:${lv}, angles:[${sol.join(',')}]})`);
    await clickEl('run');
    const w = await poll('window.__principia().over ? window.__principia() : null', 25000);
    ok(w && w.result === 'win', `rig ${lv} does not land its proven build in the browser`, w && { result: w.result, cause: w.cause, ball: w.ball });
    console.log(`  rig ${lv}: ${w?.result} in ${w?.t}s at [${sol}]`);
    if (lv === 3) await shot('principia-rig3');
  }
}

// ---- 9) Next rig from the win sheet loads the next bench in build mode ----
{
  await ev('window.__principia.setup({level:5, angles:[-28,0], run:true})');
  await poll('window.__principia().over ? window.__principia() : null', 25000);
  const before = await hook();
  ok(before.result === 'win', 'rig 5 did not finish before the next-rig check', before.result);
  await clickEl('overBtn');   // "Play again" on the last rig -> back to rig 1
  const s = await poll('window.__principia().sheet === "" ? window.__principia() : null', 6000);
  ok(!!s, 'the last-rig sheet did not close', await hook());
  ok(s && s.level === 1 && s.mode === 'build', 'the last rig did not roll back to rig 1', s && { level: s.level, mode: s.mode });
}

// ---- 9b) the sheet's second button starts the shelf over in place, without navigating ----
{
  const url0 = await ev('location.pathname');
  await ev(`window.__principia.setup({level:2, angles:[${SOLS[2].join(',')}]})`);
  await clickEl('run');
  const w = await poll('window.__principia().over ? window.__principia() : null', 25000);
  ok(w && w.result === 'win', 'rig 2 did not finish before the start-over check', w && w.result);
  const p = await elPoint('overBack');
  ok(p && p.txt === 'Start over', 'the sheet does not offer Start over', p);
  await clickEl('overBack');
  const s = await poll('window.__principia().sheet === "" ? window.__principia() : null', 6000);
  ok(!!s, 'Start over left the sheet open', await hook());
  ok(s && s.level === 1 && s.mode === 'build' && s.runs === 0, 'Start over did not rebuild rig 1 with a fresh run count', s && { level: s.level, mode: s.mode, runs: s.runs });
  ok((await ev('location.pathname')) === url0, 'Start over navigated away from the game instead of rebuilding it');
}

// ---- 10) the beams are locked while the marble is away ----
{
  await ev('window.__principia.setup({level:1, angles:[-6]})');
  await clickEl('run');
  await sleep(300);
  const a0 = (await hook()).angles[0];
  const p = await knob(0);
  await press(p);
  const tgt = await wpt(0, -2);
  await moveTo(tgt);
  await sleep(80);
  await release(tgt);
  const s = await hook();
  ok(s.mode === 'run' || s.over, 'the run ended before the lock check', s.mode);
  ok(Math.abs(s.angles[0] - a0) < 0.01, 'the beam moved while the marble was running', [a0, s.angles[0]]);
  await ev('window.__principia.setup({level:1, angles:[-6]})');
}

// ---- 11) portrait touch: a finger tips the beam and the Run button serves ----
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url: base + PAGE });
  ok(!!(await poll('typeof window.__principia === "function"', 90000)), 'the port did not boot at 390x844');
  // prime the emulation with one neutral press (headless can swallow the first event after a resize)
  await click({ x: 195, y: 300 });
  await ev('window.__principia.setup({level:1, angles:[-6]})');
  const s0 = await hook();
  const p0 = await knob(0);
  const tgt = await wpt(-2.0, -1.4);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p0.x, y: p0.y, id: 1 }] });
  await sleep(90);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tgt.x, y: tgt.y, id: 1 }] });
  await sleep(140);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  const s1 = await hook();
  ok(Math.abs(s1.angles[0] - s0.angles[0]) > 12, 'a finger on the knob does not tip the beam', [s0.angles[0], s1.angles[0]]);
  const rp = await elPoint('run');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rp.x, y: rp.y, id: 2 }] });
  await sleep(80);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const started = await poll('window.__principia().mode === "run" || window.__principia().over', 6000);
  ok(!!started, 'a finger on Run does not release the marble', await hook());
  const moved = await poll('window.__principia().ball.y < window.__principia().spawn.y - 0.1', 8000);
  ok(!!moved, 'the marble does not fall on a phone', await hook());
  await shot('principia-touch');
}

// ---- 12) no console errors along the way ----
{
  const bad = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.method === 'Runtime.exceptionThrown' ? (e.params.exceptionDetails.exception?.description || 'exception') : e.params.entry.text)
    .filter((t) => !/favicon|net::ERR_ABORTED/i.test(t));
  ok(bad.length === 0, 'the page logged runtime errors', bad.slice(0, 4));
}

console.log(fails ? `\nFAIL: ${fails} gate assertion(s)` : '\nPASS — principia plays through real input');
kill();
process.exit(fails ? 1 : 0);
