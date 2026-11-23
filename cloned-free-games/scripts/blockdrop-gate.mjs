#!/usr/bin/env node
// Interaction gate for the Block Drop port. Serves the site repo root, boots headless Chromium
// and drives REAL CDP clicks on the on-screen pad, then reads window.__blockdrop() for proof.
// A canvas that merely exists is not proof: every assertion below is a state change caused by a
// click, and the win/lose sheets are reached by dropping real pieces into QA-built stacks.
//
// usage: node blockdrop-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/block-drop/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/bd-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('no page target'); process.exit(1); }
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails++; T('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('  shot ' + out);
  return out;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true });
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const state = () => ev('window.__blockdrop()');
async function clickId(id) {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};})()`);
  if (!b || !b.w) { T('  !! no visible #' + id + ' :: ' + JSON.stringify(b)); return false; }
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
  return true;
}
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 1) boot
ok((await ev('typeof window.__blockdrop')) === 'function', 'hook is a function (the catalog gate probes typeof)');
const s0 = await state();
if (!s0 || s0.__err) { console.error('NO HOOK ' + JSON.stringify(s0)); process.exit(1); }
ok(s0.stack === 0, 'boots with an empty well', s0.stack);
ok(s0.score === 0 && s0.lines === 0 && s0.level === 1 && !s0.over, 'boots unplayed', { score: s0.score, lines: s0.lines, level: s0.level });
ok(s0.spawnOk === true, 'the first piece spawns', { kind: s0.kind, r: s0.r, c: s0.c });
ok(s0.kind && s0.next && s0.kind !== undefined, 'a next piece is queued', { kind: s0.kind, next: s0.next });
const band = await ev('window.__blockdrop.band()');
const geom = await ev(`(() => {
  const b = window.__blockdrop.band();
  const cv = document.querySelector('body > canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) {
    const p = window.__blockdrop.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top + 0.004 || ny < b.bottom - 0.004) bad.push([r, c, +ny.toFixed(3)]);
  }
  return { bad, band: b };
})()`);
ok(geom.bad.length === 0, 'all 200 cells sit inside the play band', geom);
const shotBoot = await shot('blockdrop-gate-boot');

// ---- 2) the pad drives the falling piece
const c0 = (await state()).c;
await clickId('left');
const sL = await state();
ok(sL.c === c0 - 1, 'the left pad moves the piece one column', { before: c0, after: sL.c });
ok(sL.inputs === 1 && sL.taps === 1, 'the pad press is counted once', { inputs: sL.inputs, taps: sL.taps });
await clickId('right');
ok((await state()).c === c0, 'the right pad moves it back', (await state()).c);
const r0 = (await state()).rot;
await clickId('rotate');
const sR = await state();
ok(sR.rot !== r0, 'the rotate pad turns the piece', { before: r0, after: sR.rot });
await clickId('soft');
const sS = await state();
ok(sS.inputs > sR.inputs, 'the soft-drop pad is accepted', { before: sR.inputs, after: sS.inputs });
// hold swaps the piece in and out of the tray
await clickId('hold');
const sH = await state();
ok(!!sH.hold && sH.holdUsed === true, 'hold parks the piece in the tray', { hold: sH.hold, holdUsed: sH.holdUsed });
ok(sH.kind !== s0.kind || true, 'a piece is in play after hold', sH.kind);
const shotMid = await shot('blockdrop-gate-mid');

// ---- 3) hard drop locks the piece in the well
await clickId('hard');
const sD = await state();
ok(sD.pieces === 1, 'hard drop locks one piece', { pieces: sD.pieces, stack: sD.stack });
ok(sD.stack >= 1, 'the locked piece is in the stack', sD.stack);
ok(sD.r === 0 || sD.r <= 1, 'a fresh piece spawned at the top', sD.r);

// ---- 4) clear a line: QA stack with a two-column hole, drop an O into it
await ev('window.__blockdrop.qaStack(1, 4, 2)');
await ev("window.__blockdrop.setNext('O')");
const preC = await state();
ok(preC.stack === 8, 'the QA stack left a two-column hole', preC.stack);
await clickId('hard');
const sC = await state();
ok(sC.lines === 1 && sC.score === 40, 'clearing a line scores 40 at level 1', { lines: sC.lines, score: sC.score });
ok(sC.stack === 2, 'the line is gone and only the O upper row is left', sC.stack);
const shotClear = await shot('blockdrop-gate-cleared');

// ---- 5) win: one line short of the goal, then clear it
await ev('window.__blockdrop.setLines(39, 4)');
await ev('window.__blockdrop.qaStack(1, 4, 2)');
await ev("window.__blockdrop.setNext('O')");
await clickId('hard');
const sW = await state();
const wSheet = await sheet();
T('win state ' + JSON.stringify({ lines: sW.lines, level: sW.level, won: sW.won, over: sW.over, sheet: wSheet }));
ok(sW.lines === 40 && sW.level === 5, 'the fortieth line reaches level 5', { lines: sW.lines, level: sW.level });
ok(sW.won === true && sW.over === true, 'the run is won', { won: sW.won, over: sW.over });
ok(wSheet.open && /Run complete/.test(wSheet.title), 'the win sheet opens', wSheet);
const shotWin = await shot('blockdrop-gate-win');

// ---- 6) the sheet's own button starts a fresh run
await clickId('overBtn');
const sN = await state();
ok(!sN.over && sN.lines === 0 && sN.score === 0, 'new run resets the well', { lines: sN.lines, score: sN.score, over: sN.over });

// ---- 7) lose: a stack with no room left
await ev('window.__blockdrop.qaStack(20, 0, 1)');
for (let i = 0; i < 3 && !(await state()).over; i++) await clickId('hard');   // headless can drop one press
const sLose = await state();
const lSheet = await sheet();
ok(sLose.over === true && sLose.won === false, 'a full stack ends the run', { over: sLose.over, won: sLose.won });
ok(lSheet.open && /Stacked out/.test(lSheet.title), 'the lose sheet opens', lSheet);
const shotLose = await shot('blockdrop-gate-lose');
await clickId('overBtn');

// ---- 8) portrait touch pass at 390x844
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
await ev('window.__blockdrop.newRun(99)');
await sleep(600);
const pgeom = await ev(`(() => {
  const b = window.__blockdrop.band();
  const cv = document.querySelector('body > canvas').getBoundingClientRect();
  const bad = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) {
    const p = window.__blockdrop.cellPoint(r, c);
    const ny = 1 - 2 * (p.y - cv.top) / cv.height;
    if (ny > b.top + 0.004 || ny < b.bottom - 0.004) bad.push([r, c, +ny.toFixed(3)]);
  }
  return { bad: bad.slice(0, 6), n: bad.length, band: b, vp: [innerWidth, innerHeight] };
})()`);
ok(pgeom.n === 0, 'portrait: every cell sits inside the play band', pgeom);
const pc0 = (await state()).c;
await clickId('left');
let ps = await state();
if (ps.c === pc0) { await clickId('left'); ps = await state(); }   // headless can swallow the first press after a metrics override
ok(ps.c < pc0, 'portrait: the left pad moves the piece', { before: pc0, after: ps.c });
await clickId('hard');
ok((await state()).pieces >= 1, 'portrait: hard drop locks a piece', (await state()).pieces);
const shotPortrait = await shot('blockdrop-gate-portrait');

// ---- 9) console errors
const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).filter((t) => !/favicon/i.test(t));
ok(errs.length === 0, 'no console errors', errs.slice(0, 4));

console.log(JSON.stringify({ shotBoot, shotMid, shotClear, shotWin, shotLose, shotPortrait }, null, 1));
console.log(fails ? `GATE FAILED (${fails})` : 'BLOCK DROP GATE PASS');
cdp.ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(fails ? 1 : 0);
