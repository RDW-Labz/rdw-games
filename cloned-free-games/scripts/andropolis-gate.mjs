#!/usr/bin/env node
// Interaction gate for the Andropolis port: real CDP mouse clicks on the tools and the lots,
// state-hook assertions for build / charge / growth / win sheet / lose sheet / restart,
// plus a 390x844 touch pass. usage: node andropolis-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/andro-gate-');
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

let fails = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('ok   ' + name);
  else { fails++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const p = join(OUT, name + '.png');
  await writeFile(p, Buffer.from(s.data, 'base64'));
  return p;
};
const click = async (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('bad click point ' + JSON.stringify([x, y]));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const hook = (expr = '') => ev(`(() => { const h = window.__andropolis; if (!h) return {__noHook:true}; const s = h(); return ${expr || 's'}; })()`);
const tile = async (r, c) => ev(`window.__andropolis.tilePoint(${r},${c})`);
const tapCell = async (r, c, wait = 240) => { const p = await tile(r, c); await click(p.x, p.y); await sleep(wait); return p; };
const tool = async (name) => {
  const p = await ev(`window.__andropolis.toolPoint(${JSON.stringify(name)})`);
  await click(p.x, p.y); await sleep(120);
  return (await hook('s.tool'));
};

await S('Runtime.enable');
await S('Page.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
pageCdp.events.length = 0;
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}/games/arcade/andropolis/`;
await S('Page.navigate', { url: BASE });
await sleep(5500);

// ---- 1. boot
let st = await hook();
ok('debug hook is a function returning state', st && !st.__noHook, st);
ok('boot: full treasury, empty board, no terminal state', st.built === 0 && st.over === false && st.funds > 5000, { funds: st.funds, tick: st.tick });
const canvas = await ev(`(() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height } : null; })()`);
ok('a WebGL canvas is sized', !!canvas && canvas.w > 100 && canvas.h > 100, canvas);
const bootShot = await shot('andropolis-boot');

// ---- 2. picker round-trip: every sampled lot's own point resolves back to that lot
const picks = await ev(`(() => {
  const out = [];
  for (let r = 0; r < 9; r += 2) for (let c = 0; c < 9; c += 2) {
    const p = window.__andropolis.tilePoint(r, c);
    out.push({ r, c, got: window.__andropolis.pick(p.x, p.y) });
  }
  return out;
})()`);
const badPicks = (picks || []).filter((p) => p.got !== p.r * 9 + p.c);
ok('tilePoint -> pick resolves every sampled lot', picks.length === 25 && badPicks.length === 0, badPicks.slice(0, 4));

// ---- 3. real clicks: road is the default tool, then switch tools with the pad buttons
let p = await tapCell(4, 4);
st = await hook();
ok('a click on a lot builds a road and charges $25', st.kinds[4 * 9 + 4] === 1 && st.funds === 5975 && st.inputs === 1, { kind: st.kinds[40], funds: st.funds, inputs: st.inputs });
ok('the road click landed on the tapped lot only', st.kinds.filter((k) => k !== 0).length === 1, st.kinds);
await tool('res');
ok('the Homes button selects the homes tool', (await hook('s.tool')) === 'res');
await tapCell(4, 3);
st = await hook();
ok('a home is zoned through a real click', st.kinds[4 * 9 + 3] === 2 && st.funds === 5975 - 90, { kind: st.kinds[39], funds: st.funds });

// a lot held down and dragged must not build (that is a camera drag, not a tap)
{
  const before = (await hook()).built;
  const a = await tile(0, 0), b = await tile(0, 4);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(300);
  ok('a drag across the board does not build', (await hook()).built === before);
}

// ---- 4. play a whole city to the win with real clicks
await ev('window.__andropolis.setup({})');           // clean board, funds restored
await sleep(300);
const PLAN = [];
PLAN.push([2, 2, 'power'], [2, 6, 'power']);
for (let c = 0; c < 9; c++) PLAN.push([3, c, 'road']);
for (let r = 0; r <= 1; r++) for (let c = 0; c <= 2; c++) PLAN.push([r, c, 'ind']);
for (let r = 0; r <= 1; r++) for (let c = 6; c <= 8; c++) PLAN.push([r, c, 'com']);
for (let r = 4; r <= 5; r++) for (const c of [0, 1, 2, 3, 4, 6, 7, 8]) PLAN.push([r, c, 'res']);
let curTool = 'road';
for (const [r, c, t] of PLAN) {
  if (t !== curTool) { await tool(t); curTool = t; }
  await tapCell(r, c, 120);
}
st = await hook();
ok('the whole planned city is on the board', st.built >= PLAN.length, { built: st.built, plan: PLAN.length, funds: st.funds });
const midShot = await shot('andropolis-city');

let won = null;
for (let i = 0; i < 90; i++) {
  await sleep(500);
  const s = await hook();
  if (s.over) { won = s; break; }
}
ok('the played city reaches a terminal state', !!won, won);
ok('the played city is won by population', !!won && won.result === 'win' && won.pop >= 100, won && { pop: won.pop, tick: won.tick, funds: won.funds });
const sheet = await ev(`(() => { const o = document.getElementById('over'); return { open: o.classList.contains('open'), title: document.getElementById('overTitle').textContent, text: document.getElementById('overText').textContent }; })()`);
ok('the win sheet opens with its own heading', sheet.open && /city works/i.test(sheet.title), sheet);
const winShot = await shot('andropolis-win');

// ---- 5. Play again restarts a clean city
const ob = await ev(`(() => { const r = document.getElementById('overBtn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
await click(ob.x, ob.y);
await sleep(700);
st = await hook();
ok('Play again restarts a fresh city', st.funds === 6000 && st.built === 0 && st.tick === 0 && st.over === false, st);
ok('the sheet is closed after restart', !(await ev(`document.getElementById('over').classList.contains('open')`)));

// ---- 6. the lose sheet, from a QA position the rules can actually reach
const set = await ev(`window.__andropolis.setup({ cells: [[4,4,5,1]], funds: 10 })`);
ok('QA lose position loads', set && set.funds === 10 && set.jobs === 0, set);
let lost = null;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  const s = await hook();
  if (s.over) { lost = s; break; }
}
ok('an unaffordable city loses when the treasury goes under', !!lost && lost.result === 'lose' && lost.funds < 0, lost);
const loseSheet = await ev(`(() => ({ open: document.getElementById('over').classList.contains('open'), title: document.getElementById('overTitle').textContent }))()`);
ok('the lose sheet opens with its own heading', loseSheet.open && /budget ran out/i.test(loseSheet.title), loseSheet);

// ---- 7. portrait touch pass
await ev('window.__andropolis.setup({})');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
await click(195, 120);           // prime the emulation override with one neutral press on the HUD
await sleep(300);
const layout = await ev(`(() => {
  const top = document.querySelector('.top').getBoundingClientRect();
  const bot = document.querySelector('.bottom').getBoundingClientRect();
  const p = window.__andropolis.tilePoint(4, 4);
  const q = window.__andropolis.tilePoint(0, 0);
  return { topBottom: Math.round(top.bottom), botTop: Math.round(bot.top), centre: p, corner: q, pick: window.__andropolis.pick(p.x, p.y), w: innerWidth, h: innerHeight };
})()`);
ok('portrait: the board sits between the two HUD bands', layout.pick === 4 * 9 + 4 && layout.centre.y > layout.topBottom && layout.centre.y < layout.botTop, layout);
await click(layout.centre.x, layout.centre.y);
await sleep(500);
st = await hook();
if (!st.inputs) { await click(layout.centre.x, layout.centre.y); await sleep(500); st = await hook(); }
ok('portrait: a tap on the screen builds on that lot', st.kinds[40] === 1 && st.inputs >= 1, { kind: st.kinds[40], inputs: st.inputs });
// a couple of coloured lots so the tile shot is not an empty grid
await tool('power'); await tapCell(3, 3, 200);
await tool('res'); await tapCell(5, 5, 200); await tapCell(5, 6, 200);
await tool('ind'); await tapCell(2, 2, 200);
st = await hook();
ok('portrait: further taps place the other tools', st.kinds[3 * 9 + 3] === 5 && st.kinds[5 * 9 + 5] === 2 && st.kinds[2 * 9 + 2] === 4, { kinds: [st.kinds[30], st.kinds[50], st.kinds[20]] });
const portraitShot = await shot('andropolis-portrait');

// ---- 8. console hygiene
const errors = pageCdp.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(e.params.type))
  .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
const pageErrors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '').slice(0, 200));
ok('no console errors and no uncaught exceptions', errors.length === 0 && pageErrors.length === 0, { errors, pageErrors });

console.log(JSON.stringify({ shots: { boot: bootShot, city: midShot, win: winShot, portrait: portraitShot }, final: st }, null, 1));
console.log(fails ? `\n${fails} GATE CHECK(S) FAILED` : '\nANDROPOLIS GATE PASS');
server.close();
pageCdp.ws.close();
proc.kill('SIGKILL');
process.exit(fails ? 1 : 0);
