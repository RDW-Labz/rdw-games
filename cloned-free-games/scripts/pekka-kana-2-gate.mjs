#!/usr/bin/env node
// Interaction gate for the Pekka Kana 2 port. Real CDP input against the shipped page:
// a canvas tap that walks the rooster, the JUMP pad (one-shot press), a held ▶ pad, an egg
// pickup by play, then the win sheet (walk into the door with every egg), the out-of-lives
// sheet, the restart button, the double-tap guard and a 390x844 touch pass.
// usage: node pekka-kana-2-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PATH_ = 'games/arcade/pekka-kana-2/';
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
const PROFILE = mkdtempSync('/tmp/pk2-gate-');
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
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('FAIL: no page target'); process.exit(1); }
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const events = () => pageCdp.events;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

const server = await serve();
const port = server.address().port;
const URL_ = `http://127.0.0.1:${port}/${PATH_}`;
T('serving ' + URL_);

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: URL_ });
await sleep(5000);

const click = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const press = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const release = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const elPoint = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const hook = () => ev('window.__pk2()');
const sheet = () => ev('window.__pk2.sheet()');
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const poll = async (fn, budgetMs, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  T('poll timeout: ' + label);
  return null;
};

// ---- 1) boot
const hookType = await ev('typeof window.__pk2');
const s0 = await hook();
const rules = await ev('window.__pk2.rules()');
const band = await ev('window.__pk2.band()');
const shotBoot = await shot('pekka-kana-2-gate-boot');
T('boot ' + JSON.stringify({ hookType, x: s0.x, lives: s0.lives, level: s0.level, band }));

// ---- 2) a canvas tap walks the rooster
const hp = await ev('window.__pk2.heroPoint()');
const before = await hook();
await click({ x: Math.min(1270, hp.x + 90), y: hp.y });
await sleep(500);
const afterTap = await hook();

// ---- 3) the JUMP pad is a one-shot press that lifts the bird
const jumpPt = await elPoint('#jump');
const yBefore = (await hook()).y;
await press(jumpPt); await sleep(60); await release(jumpPt);
const airborne = await poll(async () => { const s = await hook(); return s.y > yBefore + 0.6 ? s : null; }, 2000, 'jump arc');
await sleep(900);
const landed = await hook();

// ---- 4) holding ▶ runs right
const rightPt = await elPoint('#right');
const x0 = (await hook()).x;
await press(rightPt);
const ran = await poll(async () => { const s = await hook(); return s.x > x0 + 2.5 ? s : null; }, 4000, 'run right');
await release(rightPt);
// keep running to pick up the first egg by play
await press(rightPt);
const egged = await poll(async () => { const s = await hook(); return s.got >= 1 ? s : null; }, 6000, 'first egg');
await release(rightPt);
const shotMid = await shot('pekka-kana-2-gate-play');
T('play ' + JSON.stringify({ tapSteps: afterTap.steps, airborneY: airborne && airborne.y, landedY: landed.y, ranX: ran && ran.x, got: egged && egged.got }));

// ---- 5) double-tap guard: two pointerups in ONE page tick
const dup = await ev(`(()=>{const p=window.__pk2.heroPoint();const c=document.querySelector('body > canvas');
  const mk=()=>new PointerEvent('pointerup',{clientX:p.x+40,clientY:p.y,bubbles:true,pointerId:9,pointerType:'touch'});
  const before=window.__pk2().steps;
  c.dispatchEvent(mk()); c.dispatchEvent(mk());
  const after=window.__pk2();
  return {before, after: after.steps, dups: after.dups};})()`);

// ---- 6) win: level 2 with every egg, walk into the door
const winSetup = await ev('window.__pk2.setup({level:1, got:5, lives:3, hero:[60.6,2.0], clearEnemies:true})');
const doorPt = await ev('window.__pk2.padPoint("right")');
await press(doorPt);
const wonState = await poll(async () => { const s = await hook(); return s.over ? s : null; }, 8000, 'win sheet');
await release(doorPt);
const winSheet = await sheet();
const shotWin = await shot('pekka-kana-2-gate-win');
T('win ' + JSON.stringify({ winSetup, wonState: wonState && { result: wonState.result, why: wonState.why, level: wonState.level }, winSheet }));

// ---- 7) restart from the sheet
const overBtnPt = await elPoint('#overBtn');
await click(overBtnPt);
await sleep(500);
const sRestart = await hook();

// ---- 8) lose: one life left, walk into a monster
const loseSetup = await ev('window.__pk2.setup({level:0, lives:1, hero:[7.2,2.0]})');
const lostState = await poll(async () => { const s = await hook(); return s.over ? s : null; }, 6000, 'lose sheet');
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ loseSetup, lostState: lostState && { result: lostState.result, why: lostState.why, lives: lostState.lives }, loseSheet }));

const errors1 = events().filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => t && !/favicon/i.test(t))
  .slice(0, 4).join(' | ');

// ---- 9) portrait touch pass
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: URL_ });
await sleep(5200);
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
const tap = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(280);
};
await click({ x: 20, y: 12 });          // prime the metrics override
await sleep(400);
const tJump = await elPoint('#jump');
const tHp = await ev('window.__pk2.heroPoint()');
const tBand = await ev('window.__pk2.band()');
const ty0 = (await hook()).y;
await tap(tJump);
let tAir = await poll(async () => { const s = await hook(); return s.y > ty0 + 0.5 ? s : null; }, 2500, 'touch jump');
if (!tAir) { await tap(tJump); tAir = await poll(async () => { const s = await hook(); return s.y > ty0 + 0.5 ? s : null; }, 2500, 'touch jump retry'); }
await sleep(700);
const tTap = await ev('window.__pk2.heroPoint()');
const stepsBefore = (await hook()).steps;
await tap({ x: Math.min(385, tTap.x + 60), y: tTap.y });
const tSteps = await poll(async () => { const s = await hook(); return s.steps > stepsBefore ? s : null; }, 2500, 'touch tap step');
const shotTouch = await shot('pekka-kana-2-gate-touch');
T('touch ' + JSON.stringify({ tBand, tAir: tAir && tAir.y, steps: tSteps && tSteps.steps, view: tSteps && tSteps.view }));

const errors2 = events().filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .filter((t) => t && !/favicon/i.test(t))
  .slice(0, 3).join(' | ');

const checks = {
  hook: hookType === 'function' && !!s0,
  shipped: rules && rules.LIVES === 3 && rules.levels.length === 2 && rules.levels[0].eggs === 4 && rules.levels[1].eggs === 5,
  boot: s0 && s0.level === 0 && s0.lives === 3 && s0.got === 0 && s0.need === 4 && s0.running === true,
  heroFramed: band && band.inBand,
  tapSteps: afterTap && afterTap.steps === before.steps + 1 && afterTap.x !== before.x,
  jumpPad: airborne && landed && Math.abs(landed.y - yBefore) < 0.6 && airborne.y > yBefore + 0.6,
  runRight: ran && ran.x > x0 + 2.5,
  eggByPlay: egged && egged.got >= 1,
  doubleTapGuarded: dup && dup.dups >= 1 && dup.after === dup.before + 1,
  won: wonState && wonState.over === true && wonState.result === 'win' && winSheet && winSheet.open && /cleared/i.test(winSheet.title),
  restarted: sRestart && sRestart.level === 0 && sRestart.lives === 3 && sRestart.got === 0 && sRestart.over === false,
  lost: lostState && lostState.over === true && lostState.result === 'lose' && lostState.why === 'monster' && loseSheet && loseSheet.open && /lives/i.test(loseSheet.title),
  touchJump: tAir && tAir.y > ty0 + 0.5,
  touchSteps: tSteps && tSteps.view === '390x844',
  touchFramed: tBand && tBand.inBand && tBand.hero.x > 2 && tBand.hero.x < 388,
  noErrors: !errors1 && !errors2,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  checks, errors1, errors2,
  s0: s0 && { x: s0.x, y: s0.y, lives: s0.lives, level: s0.level, view: s0.view }, band,
  tap: { before: { x: before.x, steps: before.steps }, after: { x: afterTap.x, steps: afterTap.steps, dups: afterTap.dups } },
  jump: { yBefore, airborne: airborne && airborne.y, landed: landed && landed.y },
  ran: ran && { x: ran.x }, egged: egged && { got: egged.got, x: egged.x },
  dup, winSetup, winSheet, wonState: wonState && { result: wonState.result, level: wonState.level },
  sRestart: sRestart && { level: sRestart.level, lives: sRestart.lives, got: sRestart.got, over: sRestart.over },
  loseSetup, loseSheet, lostState: lostState && { result: lostState.result, why: lostState.why, lives: lostState.lives },
  touch: { band: tBand, air: tAir && tAir.y, steps: tSteps && tSteps.steps, view: tSteps && tSteps.view },
  shots: [shotBoot, shotMid, shotWin, shotTouch],
}, null, 0));
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
