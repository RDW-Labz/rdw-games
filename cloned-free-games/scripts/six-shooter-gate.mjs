#!/usr/bin/env node
// Interaction gate for the Six Shooter port. Serves the arcade tree, boots headless Chromium and
// dispatches REAL pointer events: on the drum itself, on the Spin / Mode / New buttons, on the
// player chips and on the end-of-draw sheet. Every claim is read back out of window.__sixshooter —
// a canvas that merely exists is never proof.
//
// usage: node six-shooter-gate.mjs [rootDir] [page] [outDir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/six-shooter/index.html';
const OUT = process.argv[4] || '/home/cluer/cloned-free-games/.queue/playtest';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/6s-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const state = () => ev('window.__sixshooter()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// in-page pointer tap at a reported point — dispatch ONCE, on whatever the point really hits
const tapAt = (p) => ev(`(()=>{
  const el = document.elementFromPoint(${p.x}, ${p.y});
  if (!el) return { hit: null };
  const host = (el.closest && el.closest('button')) || el;
  const o = { bubbles: true, cancelable: true, composed: true, clientX: ${p.x}, clientY: ${p.y}, pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { hit: host.id || host.dataset.p || host.tagName };
})()`);
const tapPoint = async (expr, ms = 200) => {
  const p = await ev(expr);
  if (!p || p.x == null) return { miss: true, at: p };
  const r = await tapAt(p);
  await sleep(ms);
  return { ...r, x: p.x, y: p.y };
};
const waitIdle = async (ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (s && !s.spinning) return s;
    await sleep(220);
  }
  return await state();
};

// ---- 1) boot
const s0 = await state();
ok((await ev('typeof window.__sixshooter')) === 'function', 'hook is a function (the catalog gate probes typeof)');
ok(s0 && s0.mode === 'elim' && s0.players.length === 3 && s0.loaded === 3 && s0.spins === 0 && !s0.over, 'boots with three gunslingers and three cartridges', s0);
const cam0 = await ev('window.__sixshooter.camera()');
ok(cam0.aspect > 1 && cam0.dist > 0, 'camera framed', cam0);
const sBootShot = await shot('six-shooter-gate-boot');

// ---- 2) the Spin button spins, and the draw resolves on wall-clock time
const r1 = await tapPoint('window.__sixshooter.spinPoint()', 150);
ok(r1.hit === 'spin', 'the spin point lands on the Spin button', r1);
const mid = await state();
ok(mid.spinning === true, 'the cylinder starts spinning', mid.spinning);
const done1 = await waitIdle();
ok(done1.spins === 1 && done1.last && done1.last.chamber >= 0, 'the spin resolves to a chamber', { spins: done1.spins, last: done1.last });
ok(Math.abs(done1.angle) > 1e-6 || done1.last.chamber === 0, 'the drum rotated to that chamber', done1.angle);
ok(done1.inputs >= 1, 'accepted taps are counted', done1.inputs);

// ---- 3) tapping the drum itself spins (the tile/canvas path, not a button)
const dp = await ev('window.__sixshooter.drumPoint()');
const drumHit = await ev(`(()=>{const e=document.elementFromPoint(${dp.x},${dp.y});return e?e.tagName:null})()`);
ok(drumHit === 'CANVAS', 'the drum point is over the canvas, not the HUD', drumHit);
const before2 = await state();
await tapAt(dp);
await sleep(120);
const mid2 = await state();
ok(mid2.spinning === true, 'a tap on the drum spins it', { spinning: mid2.spinning });
const done2 = await waitIdle();
ok(done2.spins === before2.spins + 1, 'the drum tap is one spin, not two', { was: before2.spins, now: done2.spins });
ok(done2.lastPick === 'drum', 'the drum tap is recorded as a drum pick', done2.lastPick);

// ---- 4) a QA bang: two players, hit chamber 0, elimination ends on the last cartridge
await ev(`window.__sixshooter.setup({mode:'elim', players:[0,1], slots:[0,null,null,1,null,null], seed:5})`);
const qa = await state();
ok(qa.players.length === 2 && qa.loaded === 2 && qa.slots[0] === 0, 'QA board loaded', qa.slots);
const bangMid = await ev('window.__sixshooter.forceSpin(0)');
ok(bangMid && bangMid.chamber === 0, 'the forced spin aims at the loaded chamber', bangMid);
const sBang = await waitIdle();
ok(sBang.last && sBang.last.hit === true && sBang.last.player === 0, 'landing on a cartridge hits its owner', sBang.last);
ok(sBang.bangs === 1 && sBang.loaded === 1, 'the bang takes that cartridge out of the drum', { bangs: sBang.bangs, loaded: sBang.loaded });
ok(sBang.over === true && sBang.survivor === 1, 'the last cartridge left ends the draw', { over: sBang.over, survivor: sBang.survivor });
const sh1 = await sheet();
ok(sh1.open && /Last cartridge standing/.test(sh1.title), 'the end-of-draw sheet names the survivor', sh1);
ok(/Tuco/.test(sh1.text), 'the sheet names the actual survivor', sh1.text);
const sTermShot = await shot('six-shooter-gate-terminal');

// ---- 5) the sheet's own buttons work (they sit above the bottom bar)
const op = await tapPoint('window.__sixshooter.overPoint()', 300);
ok(op.hit === 'overBtn', 'the play-again point lands on the sheet button', op);
const sAgain = await state();
ok(sAgain.over === false && sAgain.spins === 0 && sAgain.loaded === 2, 'play again redeals a fresh draw', { over: sAgain.over, spins: sAgain.spins, loaded: sAgain.loaded });
ok(!(await sheet()).open, 'the sheet closes on play again');

// back up: walk to a terminal sheet again and dismiss it without restarting
await ev(`window.__sixshooter.setup({mode:'elim', players:[0,1], slots:[0,null,null,1,null,null], seed:5})`);
await ev('window.__sixshooter.forceSpin(0)');
await waitIdle();
ok((await sheet()).open, 'the terminal sheet reopens for the back-up check');
const bp = await tapPoint('window.__sixshooter.backPoint()', 250);
ok(bp.hit === 'backBtn', 'the back-up point lands on the sheet button', bp);
ok(!(await sheet()).open, 'the sheet closes');
ok((await state()).over === true, 'back up leaves the finished draw standing');

// ---- 6) a QA click: an empty chamber is a real, non-terminal outcome
await ev(`window.__sixshooter.setup({mode:'solo', players:[0,1,2], slots:[0,1,2,null,null,null], seed:9})`);
const sPreClick = await state();
await ev('window.__sixshooter.forceSpin(4)');
const sClick = await waitIdle();
ok(sClick.last && sClick.last.hit === false && sClick.last.player === null, 'an empty chamber clicks, nobody draws', sClick.last);
ok(sClick.empties === 1 && sClick.spins === 1 && !sClick.over, 'a click is counted and the draw goes on', { empties: sClick.empties, over: sClick.over });
ok(sClick.loaded === sPreClick.loaded, 'a click leaves every cartridge in the drum', { was: sPreClick.loaded, now: sClick.loaded });

// ---- 7) the mode button is never a dead button
const m1 = await tapPoint('window.__sixshooter.modePoint()', 300);
ok(m1.hit === 'mode', 'the mode point lands on the Mode button', m1);
const sMode = await state();
ok(sMode.mode === 'elim' && sMode.spins === 0, 'mode cycles to elimination and restarts the draw', { mode: sMode.mode, spins: sMode.spins });
await tapPoint('window.__sixshooter.modePoint()', 300);
ok((await state()).mode === 'solo', 'mode cycles back to solo');

// ---- 8) player chips add and remove gunslingers, and the deal follows
await ev(`window.__sixshooter.setup({mode:'solo', players:[0,1,2], seed:3})`);
const cp = await tapPoint('window.__sixshooter.chipPoint(4)', 300);
ok(cp.hit === '4', 'the chip point lands on the fourth chip', cp);
const sChip = await state();
ok(sChip.players.length === 4 && sChip.players.includes(4), 'a chip tap adds a gunslinger', sChip.players);
ok(sChip.loaded === 4, 'the deal loads one cartridge per gunslinger', sChip.loaded);
await tapPoint('window.__sixshooter.chipPoint(4)', 300);
const sChip2 = await state();
ok(sChip2.players.length === 3 && !sChip2.players.includes(4), 'tapping the chip again removes them', sChip2.players);

// ---- 9) New redraws, R restart path exists
await ev('window.__sixshooter.forceSpin(0)');
await waitIdle();
const np = await tapPoint('window.__sixshooter.newPoint()', 300);
ok(np.hit === 'new', 'the new point lands on the New draw button', np);
const sNew = await state();
ok(sNew.spins === 0 && !sNew.over && sNew.last === null, 'New draw resets the run', sNew);

// ---- 10) portrait 390x844: every chamber still resolves over the canvas, and a tap still spins
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await ev('dispatchEvent(new Event("resize"))');
await sleep(1200);
const camP = await ev('window.__sixshooter.camera()');
ok(camP.aspect > 0 && camP.aspect < 0.6, 'camera re-framed for portrait', camP);
const pts = [];
for (let i = 0; i < 6; i++) pts.push(await ev(`window.__sixshooter.chamberPoint(${i})`));
const inView = pts.every((p) => p && p.x > 0 && p.y > 0 && p.x < 390 && p.y < 844);
ok(inView, 'all six chamber points are inside the phone viewport', pts);
const overCanvas = await ev(`(()=>{const ps=${JSON.stringify(pts)};return ps.map(p=>{const e=document.elementFromPoint(p.x,p.y);return e?e.tagName:'none'});})()`);
ok(overCanvas.every((t) => t === 'CANVAS'), 'every chamber point is over the canvas, not a HUD bar', overCanvas);
const sPort = await state();
await tapAt(await ev('window.__sixshooter.drumPoint()'));
await sleep(120);
const sPortMid = await state();
ok(sPortMid.spinning === true, 'the drum still spins in portrait', sPortMid.spinning);
await waitIdle();
const sPortDone = await state();
ok(sPortDone.spins === sPort.spins + 1, 'the portrait tap is one honest spin', { was: sPort.spins, now: sPortDone.spins });
const sPortShot = await shot('six-shooter-gate-portrait');

// ---- 11) console errors
const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text).filter((t) => !/favicon/.test(t));
ok(errs.length === 0, 'no console errors', errs);
const exC = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
ok(exC.length === 0, 'no uncaught exceptions', exC.map((e) => e.params.exceptionDetails.text));

T('shots: ' + [sBootShot, sTermShot, sPortShot].join(', '));
T(fails ? `FAILED (${fails})` : 'PASS');
proc.kill('SIGTERM');
server.close();
process.exit(fails ? 1 : 0);
