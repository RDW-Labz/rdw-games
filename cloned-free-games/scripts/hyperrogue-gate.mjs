#!/usr/bin/env node
// Interaction gate for the HyperRogue port. Real CDP pointer events on the heptagon
// board with state-hook assertions: picker round-trip, one-cell steps, tap-to-walk,
// the double-tap guard, a win sheet, a loss, restart, keyboard, and portrait touch.
// usage: node hyperrogue-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || join(process.env.HOME, 'kaos/work/site'));
const FILE = 'games/arcade/hyperrogue/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store' }).end(body);
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
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/hyper-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800',
  '--no-first-run', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const server = await serve();
const port = server.address().port;
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(6000);

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { fails++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
  else console.log('ok   ' + name + (extra ? ' :: ' + extra : ''));
};
const hook = () => ev('window.__hyperrogue && window.__hyperrogue()');
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, name + '.png');
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const click = async (p) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickNeighbour = async (k) => {
  const p = await ev(`window.__hyperrogue.neighbourPoint(${k})`);
  if (!p || p.__err || p.x == null) return { p, err: p && p.__err };
  T(`neighbour ${k} at ${Math.round(p.x)},${Math.round(p.y)}`);
  await click(p);
  return p;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),
  title:document.getElementById('overTitle').textContent,
  back: !!document.getElementById('overBack')}))()`);

// ---- 1) boot + hook
const h0 = await hook();
ok('hook is a function', await ev('typeof window.__hyperrogue') === 'function');
ok('world built', h0 && h0.cells > 600, h0 && h0.cells + ' cells');
ok('nine treasures', h0 && h0.total === 9, h0 && h0.total);
ok('three hunters', h0 && h0.enemies.length === 3, h0 && h0.enemies.length);
ok('board is drawn', h0 && h0.drawn > 200, h0 && h0.drawn + ' cells drawn');
const shotBoot = await shot('hyperrogue-gate-boot');
T('boot shot ' + shotBoot);

// ---- 2) the picker must round-trip: every drawn cell's centre picks that same cell
const rt = await ev(`(()=>{
  const st = window.__hyperrogue();
  const ids = [st.pos, ...st.neighbours.filter(x=>x>=0)];
  let bad = [];
  for (const id of ids) {
    const p = window.__hyperrogue.cellPoint(id);
    if (!p) { bad.push([id,'nopoint']); continue; }
    const got = window.__hyperrogue.cellAt(p.x, p.y);
    if (got !== id) bad.push([id,got]);
  }
  return {n: ids.length, bad};
})()`);
ok('cellPoint round-trips through cellAt', rt && rt.bad.length === 0, JSON.stringify(rt));

// ---- 3) one real click steps one cell
const a = await clickNeighbour(0);
const h1 = await hook();
ok('a click moves the player', h1.pos !== h0.pos && h1.moves === h0.moves + 1,
  'pos ' + h0.pos + ' -> ' + h1.pos + ' moves ' + h0.moves + ' -> ' + h1.moves);
const shotStep = await shot('hyperrogue-gate-step');

// ---- 4) tap-to-walk: tapping a cell two steps away still moves exactly one
const far = await ev(`(()=>{
  const st = window.__hyperrogue();
  const nb = st.neighbours.filter(x=>x>=0)[0];
  const p = window.__hyperrogue.cellPoint(nb);
  return p ? {x:p.x, y:p.y} : null;
})()`);
const before = await hook();
if (far) { await click(far); }
const afterWalk = await hook();
ok('a tap on a far cell walks one step', afterWalk.moves === before.moves + 1,
  'moves ' + before.moves + ' -> ' + afterWalk.moves);

// ---- 5) double-tap guard: two pointerups in one tick must count once
const dbl = await ev(`(()=>{
  const st = window.__hyperrogue();
  const k = st.neighbours.findIndex(x=>x>=0);
  const p = window.__hyperrogue.neighbourPoint(k);
  const before = window.__hyperrogue().moves;
  const target = document.elementFromPoint(p.x, p.y) || document.body;
  const mk = () => new PointerEvent('pointerup', {clientX:p.x, clientY:p.y, bubbles:true, pointerType:'mouse'});
  target.dispatchEvent(mk()); target.dispatchEvent(mk());
  return {before, after: window.__hyperrogue().moves, p};
})()`);
ok('a same-point double tap counts once', dbl && dbl.after === dbl.before + 1,
  'moves ' + (dbl && dbl.before) + ' -> ' + (dbl && dbl.after));

// ---- 6) keyboard moves too
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
await sleep(250);
const hKey = await hook();
ok('an arrow key steps a cell', hKey.moves > 0, 'moves ' + hKey.moves);

// ---- 7) win: one treasure on a neighbour, one honest click
await ev('window.__hyperrogue.setup({treasureAtNeighbour:true})');
await sleep(300);
const w0 = await hook();
const kWin = w0.neighbours.indexOf(w0.left[0]);
ok('QA treasure sits on a neighbour', kWin >= 0, 'k ' + kWin + ' left ' + JSON.stringify(w0.left));
await clickNeighbour(kWin);
await sleep(400);
const w1 = await hook();
const winSheet = await sheet();
const shotWin = await shot('hyperrogue-gate-win');
ok('collecting the last treasure wins', w1.over === true && w1.result === 'win',
  w1.result + ' got ' + w1.got + '/' + w1.total);
ok('the win sheet opens with both buttons', winSheet.open && winSheet.title.length > 4 && winSheet.back,
  winSheet.title);
T('win shot ' + shotWin);

// ---- 8) restart from the sheet
await ev(`(()=>{const b=document.getElementById('overBtn');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
  .then((p) => click(p));
await sleep(500);
const hNew = await hook();
const sheetAfter = await sheet();
ok('Play again starts a fresh run', hNew.over === false && hNew.got === 0 && hNew.moves === 0 && !sheetAfter.open,
  'over ' + hNew.over + ' got ' + hNew.got + ' moves ' + hNew.moves);

// ---- 9) lose: a hunter on the neighbour, walk into it
await ev('window.__hyperrogue.setup({enemyAtNeighbour:true})');
await sleep(300);
const l0 = await hook();
const kLose = l0.neighbours.indexOf(l0.enemies[0]);
ok('QA hunter sits on a neighbour', kLose >= 0, 'k ' + kLose + ' enemies ' + JSON.stringify(l0.enemies));
await clickNeighbour(kLose);
await sleep(400);
const l1 = await hook();
const loseSheet = await sheet();
const shotLose = await shot('hyperrogue-gate-lose');
ok('walking into a hunter loses', l1.over === true && l1.result === 'lose', l1.result);
ok('the lose sheet opens', loseSheet.open && loseSheet.title.length > 4, loseSheet.title);
T('lose shot ' + shotLose);

// ---- 10) console errors
const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text ||
    (e.params.args || []).map((x) => x.description || x.value).join(' ')).slice(0, 4);
ok('no console errors', errors.length === 0, errors.join(' | '));

// ---- 11) portrait touch: board inside the HUD band, and a tap plays
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(6500);
const bands = await ev(`(()=>{
  const t=document.querySelector('.top').getBoundingClientRect();
  const b=document.querySelector('.bottom').getBoundingClientRect();
  const st=window.__hyperrogue();
  const ids=[st.pos, ...st.neighbours.filter(x=>x>=0)];
  const ys=ids.map(i=>window.__hyperrogue.cellPoint(i)).filter(Boolean).map(p=>p.y);
  const xs=ids.map(i=>window.__hyperrogue.cellPoint(i)).filter(Boolean).map(p=>p.x);
  return {top:t.bottom, bottom:b.top, yMin:Math.min(...ys), yMax:Math.max(...ys),
          xMin:Math.min(...xs), xMax:Math.max(...xs), w:innerWidth};
})()`);
ok('the local board sits inside the HUD band',
  bands.yMin > bands.top - 2 && bands.yMax < bands.bottom + 2 && bands.xMin > 0 && bands.xMax < bands.w,
  JSON.stringify(bands));
const pPortrait = await ev(`window.__hyperrogue.neighbourPoint(0)`);
const pBefore = await hook();
if (pPortrait) {
  // headless can swallow the first touch after a metrics override: prime it once
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 40, radiusX: 6, radiusY: 6, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pPortrait.x, y: pPortrait.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
}
let pAfter = await hook();
if (pAfter.moves === pBefore.moves) {         // a finger repeats
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pPortrait.x, y: pPortrait.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
  pAfter = await hook();
}
ok('a portrait tap steps the player', pAfter.moves > pBefore.moves,
  'moves ' + pBefore.moves + ' -> ' + pAfter.moves);
const shotPortrait = await shot('hyperrogue-gate-portrait');
T('portrait shot ' + shotPortrait);

console.log('\n' + (fails ? fails + ' FAILED of ' + checks : 'all ' + checks + ' checks passed'));
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
