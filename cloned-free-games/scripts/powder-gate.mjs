#!/usr/bin/env node
// Interaction gate for the Powder Lab port (The Powder Toy card): a real in-frame drag pours sand
// through the pointer handlers, the sim runs on its wall clock, the crucible objective completes,
// the win sheet opens, Next level advances, a fire stroke burns the oil trough out, a shortened
// clock produces the loss sheet, R restarts, and a portrait touch pass pours on a phone. Every
// assertion reads the page's own state hook — a canvas that exists is not proof.
// usage: node powder-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/powder-lab/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/pw-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: PROFILE } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
});
T('devtools up');
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const server = await serve();
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const url = `http://127.0.0.1:${port}/${FILE}`;

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) T('PASS ' + msg);
  else { fails++; T('FAIL ' + msg + (extra ? ' :: ' + extra : '')); }
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheetOf = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,btn:document.getElementById('overBtn').textContent}))()`);
const state = () => ev('window.__powder()');
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
};
const ptOf = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);

// Real pointer gesture inside the page: down on the element under the first point, moves across the
// stroke, up on document.body. Exactly one dispatch per event — a second one would double-paint.
const drag = async (expr, { touch = false } = {}) => ev(`(()=>{
  const pts = ${expr};
  if (!pts || !pts.length) return {__err:'no points'};
  const mk = (p, type) => new PointerEvent(type, {bubbles:true, cancelable:true, pointerType:'${touch ? 'touch' : 'mouse'}',
    button:0, isPrimary:true, clientX:p.x, clientY:p.y, pointerId:1});
  const el = document.elementFromPoint(pts[0].x, pts[0].y) || document.body;
  el.dispatchEvent(mk(pts[0], 'pointerdown'));
  for (let i = 1; i < pts.length; i++) {
    const e = document.elementFromPoint(pts[i].x, pts[i].y) || el;
    e.dispatchEvent(mk(pts[i], 'pointermove'));
  }
  document.body.dispatchEvent(mk(pts[pts.length-1], 'pointerup'));
  return {from: pts[0], to: pts[pts.length-1], n: pts.length};
})()`);

const waitFor = async (expr, ms = 20000, step = 300) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await ev(expr);
    if (last === true) return true;
    await sleep(step);
  }
  return last;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url });
await sleep(6000);
T('page loaded');

const errorsOf = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 1) boot: the wall is built and drawn, nothing is solved yet ----
const s0 = await state();
ok(s0 && s0.level === 1 && s0.mode === 'crucible', 'boots on level 1 (crucible)', JSON.stringify(s0 && { level: s0.level, mode: s0.mode }));
ok(s0 && s0.stone > 40 && s0.cells > 40, 'the stone apparatus is on the board', s0 && `stone=${s0.stone} cells=${s0.cells}`);
ok(s0 && s0.drawn.body > 30 && s0.over === false, 'the grid is drawn as instances, nothing terminal yet', s0 && `drawn=${s0.drawn.body} over=${s0.over}`);
ok(s0 && s0.done === false && s0.target === 60, 'the crucible starts unsolved with a 60-grain target', JSON.stringify(s0 && { progress: s0.progress, target: s0.target, done: s0.done }));
const shotBoot = await shot('powder-lab-gate-boot');
T('shot ' + shotBoot);

// ---- 2) one real drag pours sand; the state hook moves ----
const band = (row, c0 = 14, c1 = 34) => `(()=>{const a=[];for(let c=${c0};c<=${c1};c+=2)a.push(window.__powder.cellPoint(c,${row}));return a;})()`;
const d1 = await drag(band(24), {});
await sleep(400);
const s1 = await state();
ok(d1 && !d1.__err, 'the drag dispatched inside the page', JSON.stringify(d1));
ok(s1.painted > 20 && s1.inputs > 0, 'the stroke deposited powder through the pointer handlers', `painted=${s1.painted} inputs=${s1.inputs}`);
ok(s1.sand > 20, 'sand cells exist on the board after the stroke', `sand=${s1.sand}`);

// ---- 3) the sand settles into the crucible and clears the objective ----
let sWin = null;
for (let pass = 0; pass < 5; pass++) {
  const st = await state();
  if (st.done || st.over) break;
  await drag(band(24), {});
  await sleep(900);
  sWin = await state();
}
const cleared = await waitFor(`(()=>{const s=window.__powder();return (s.done && s.over) ? true : null;})()`, 20000);
const sAfter = await state();
const sheetWin = await sheetOf();
ok(cleared === true && sAfter.result === 'win', 'pouring sand into the crucible clears the level', JSON.stringify({ progress: sAfter.progress, target: sAfter.target, result: sAfter.result }));
ok(sheetWin.open && /cleared/i.test(sheetWin.title), 'the win sheet opens with its own buttons', JSON.stringify(sheetWin));
const shotWin = await shot('powder-lab-gate-win');
T('shot ' + shotWin);
ok((await state()).sand > 30, 'the sand is still drawn in the bowl at the win', '');

// ---- 4) Next level advances to the oil trough ----
await click(await ptOf('#overBtn'));
const s2 = await state();
ok(s2.level === 2 && s2.mode === 'quench' && s2.over === false, 'Next level starts the quench experiment', JSON.stringify({ level: s2.level, mode: s2.mode, over: s2.over }));
ok(s2.oil > 40 && s2.tool === 'fire', 'the trough is full of oil and the fire brush is selected', `oil=${s2.oil} tool=${s2.tool}`);

// ---- 5) set the trough alight with the fire brush (real click on the tool button) ----
await click(await ptOf('#tools button[data-tool="fire"]'));
ok((await state()).tool === 'fire', 'the fire tool button wires to the brush');
const oilDrag = `(()=>{const a=[];for(let c=8;c<=28;c+=3)a.push(window.__powder.cellPoint(c,4));return a;})()`;
await drag(oilDrag, {});
const sLight = await state();
ok(sLight.fire > 0 && sLight.burnt > 0, 'the stroke sets the oil alight', `fire=${sLight.fire} burnt=${sLight.burnt}`);
await sleep(600);
const sBurn = await state();
for (let pass = 0; pass < 4; pass++) {
  const st = await state();
  if (st.done || st.over) break;
  await drag(`(()=>{const a=[];for(let c=8;c<=28;c+=4)a.push(window.__powder.cellPoint(c,3));return a;})()`, {});
  await sleep(1500);
}
const burnDone = await waitFor(`(()=>{const s=window.__powder();return (s.oil===0 && s.fire===0 && s.over) ? true : null;})()`, 30000);
const sBurned = await state();
ok(burnDone === true && sBurned.result === 'win', 'the trough burns out completely and clears level 2', JSON.stringify({ oil: sBurned.oil, fire: sBurned.fire, progress: sBurned.progress, result: sBurned.result }));
ok((await sheetOf()).open, 'the second win sheet opens');

// ---- 6) Next level reaches the tower, and a short clock produces the loss sheet ----
await click(await ptOf('#overBtn'));
ok((await state()).mode === 'tower', 'Next level reaches the sand tower');
await ev('window.__powder.setup(0, {clock: 1.2})');
const expired = await waitFor(`(()=>{const s=window.__powder();return s.over ? true : null;})()`, 8000, 250);
const sLose = await state();
const sheetLose = await sheetOf();
ok(expired === true && sLose.result === 'lose', 'the clock running out ends the level', JSON.stringify({ result: sLose.result, why: sLose.why, left: sLose.left }));
ok(sheetLose.open && /out of time/i.test(sheetLose.title), 'the loss sheet says out of time', JSON.stringify(sheetLose));

// ---- 7) R restarts the level clean ----
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await state();
ok(sR.over === false && sR.result === null && sR.progress === 0 && sR.left > 60, 'R restarts the level with a fresh clock', JSON.stringify({ over: sR.over, result: sR.result, progress: sR.progress, left: sR.left }));
ok((await sheetOf()).open === false, 'the sheet is closed after a restart');

// ---- 7b) a clean gameplay frame for the library tile (partial pour, no sheet) ----
await drag(band(12, 21, 25), {});
await sleep(1200);
const sPlay = await state();
ok(sPlay.sand > 10 && sPlay.over === false, 'the tile frame is a live, half-poured board', `sand=${sPlay.sand} over=${sPlay.over}`);
const shotPlay = await shot('powder-lab-gate-play');
T('shot ' + shotPlay);

// ---- 8) portrait touch pass: the same drag works with a finger ----
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url });
await sleep(6000);
const sP0 = await state();
ok(sP0 && sP0.level === 1, 'the port boots in portrait', JSON.stringify(sP0 && { level: sP0.level }));
// Shot before any pour: a full crucible would pop the win sheet over the layout being checked.
const shotP = await shot('powder-lab-gate-portrait');
T('shot ' + shotP);
// The board must sit inside the band the HUD leaves, not behind the bars or the tool strip.
const box = await ev(`(()=>{
  const top=document.querySelector('.top').getBoundingClientRect();
  const bot=document.querySelector('.bottom').getBoundingClientRect();
  const a=window.__powder.cellPoint(14,0), b=window.__powder.cellPoint(34,9), c=window.__powder.cellPoint(0,33);
  return {top:Math.round(top.bottom), bot:Math.round(bot.top), a, b, c, w:innerWidth, h:innerHeight};
})()`);
ok(box.a.x > 0 && box.b.x < box.w && box.a.y < box.bot && box.b.y > box.top,
  'the crucible sits inside the portrait viewport and clear of both bars',
  JSON.stringify({ a: box.a, b: box.b, band: [box.top, box.bot], view: [box.w, box.h] }));
ok(box.c.x > -20 && box.c.x < box.w + 20 && box.c.y > box.top - 30,
  'the top of the board is not clipped behind the top bar', JSON.stringify(box.c));
const pPts = await ev(band(24));
const pIn = pPts.filter((p) => p && p.y > 0 && p.y < 844 && p.x > 0 && p.x < 390);
ok(pIn.length >= 6, 'the crucible mouth is tappable on a 390px phone', `${pIn.length}/${pPts.length} points on screen`);
const dP = await drag(`(()=>{const a=[];for(let c=18;c<=24;c+=2)a.push(window.__powder.cellPoint(c,24));return a;})()`, { touch: true });
await sleep(700);
const sP = await state();
ok(dP && !dP.__err && sP.painted > 10 && sP.sand > 10, 'a finger drag pours powder in portrait', `painted=${sP.painted} sand=${sP.sand}`);
ok(sP.drawn.body > 30, 'the grid is still drawn after the portrait refit', `drawn=${sP.drawn.body}`);

// ---- 9) no console errors anywhere ----
const errs = errorsOf();
ok(!errs, 'no console errors or uncaught exceptions', errs);

T(`\n${fails ? fails + ' FAILURE(S)' : 'ALL POWDER LAB GATE CHECKS PASSED'}`);
try { proc.kill('SIGKILL'); } catch {}
server.close();
process.exit(fails ? 1 : 0);
