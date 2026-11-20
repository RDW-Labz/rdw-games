#!/usr/bin/env node
// Interaction gate for the Vector Pinball port (com.dozingcatsoftware.bouncy card).
// Real CDP mouse + touch, state-hook assertions, screenshots. Proves: launch moves the ball and
// scores, each half of the table swings its own flipper, a bumper hit reaches the win sheet, a
// drain with one ball left reaches the lose sheet, both sheet buttons restart, R restarts, and the
// portrait touch build plays.
// usage: node pinball-gate.mjs <dir>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/vector-pinball/index.html';
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
      if (msg.id && c.p.has(msg.id)) { const { ok, bad, method } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? bad(new Error(method + ': ' + msg.error.message)) : ok(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/pin-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
T('serving ' + port);
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
await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const pressAt = (pt) => S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
const releaseAt = (pt) => S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
const elPt = (id) => ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const poll = async (expr, pred, ms = 12000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) { last = await ev(expr); if (pred(last)) return last; await sleep(300); }
  return last;
};

const results = {};
// ---- 1) boot
const hookType = await ev('typeof window.__pinball');
const s0 = await ev('window.__pinball()');
const board = await ev('window.__x.board()');
const shotBoot = await shot('vector-pinball-gate-boot');
T('boot ' + JSON.stringify({ hookType, state: s0.state, balls: s0.balls, gap: board.gap }));

// ---- 2) launch through the real #launch button, prove the ball moves and scores
const launchPt = await elPt('launch');
await click(launchPt);
await sleep(200);
const sL = await ev('window.__pinball()');
const moved = await poll('window.__pinball()', (s) => s && s.score > 0, 9000);
const shotPlay = await shot('vector-pinball-gate-play');
results.launch = { click: launchPt, inPlay: sL.inPlay, state: sL.state, ballAt200ms: sL.ball, scored: moved.score, hits: moved.hits, lastKind: moved.lastKind };
T('launch ' + JSON.stringify(results.launch));

// ---- 3) each half swings its own flipper (real mouse pressed and held)
const restL = s0.flipper.l, restR = s0.flipper.r;
const pL = await ev(`window.__x.flipperPoint('l')`);
T('left flipper point ' + JSON.stringify(pL));
if (!pL || pL.__err || !Number.isFinite(pL.x)) { console.log(JSON.stringify({ fail: 'flipperPoint("l") did not return a point', pL })); process.exit(1); }
await pressAt(pL);
await sleep(260);
const heldL = await ev('window.__pinball()');
await releaseAt(pL);
await sleep(400);
const afterL = await ev('window.__pinball()');
const pR = await ev(`window.__x.flipperPoint('r')`);
await pressAt(pR);
await sleep(260);
const heldR = await ev('window.__pinball()');
await releaseAt(pR);
await sleep(400);
const afterR = await ev('window.__pinball()');
results.flippers = {
  left: { rest: restL, held: heldL.flipper.l, back: afterL.flipper.l, presses: heldL.flips.l },
  right: { rest: restR, held: heldR.flipper.r, back: afterR.flipper.r, presses: heldR.flips.r },
};
T('flippers ' + JSON.stringify(results.flippers));

// ---- 4) play a few seconds with both flippers: the score must keep moving
let maxScore = moved.score;
for (let i = 0; i < 10; i++) {
  const side = i % 2 ? 'r' : 'l';
  const p = await ev(`window.__x.flipperPoint('${side}')`);
  await pressAt(p); await sleep(180); await releaseAt(p); await sleep(360);
  const s = await ev('window.__pinball()');
  maxScore = Math.max(maxScore, s.score);
  if (s.state !== 'play') break;
}
results.rally = { maxScore, state: (await ev('window.__pinball()')).state };
T('rally ' + JSON.stringify(results.rally));

// ---- 5) win: QA position one bumper away from the target, then a real drop into it
await ev('window.__x.setup({score: 2250, balls: 2, ball: {x: 0, z: -5.25, vx: 0, vz: 7}})');
const sWin = await poll('window.__pinball()', (s) => s && s.state === 'won', 12000);
const winSheet = await sheet();
const shotWin = await shot('vector-pinball-gate-win');
results.win = { state: sWin.state, score: sWin.score, sheet: winSheet };
T('win ' + JSON.stringify(results.win));

// ---- 6) Play again from the sheet
await click(await elPt('overBtn'));
await sleep(500);
const sAgain = await ev('window.__pinball()');
results.again = { state: sAgain.state, score: sAgain.score, balls: sAgain.balls, sheetOpen: (await sheet()).open };
T('again ' + JSON.stringify(results.again));

// ---- 7) lose: one ball left, dropped through the flipper gap
await ev('window.__x.setup({score: 640, balls: 1, ball: {x: 0, z: 4.3, vx: 0, vz: 15}})');
const sLose = await poll('window.__pinball()', (s) => s && s.state === 'lost', 12000);
const loseSheet = await sheet();
const shotLose = await shot('vector-pinball-gate-lose');
results.lose = { state: sLose.state, balls: sLose.balls, sheet: loseSheet };
T('lose ' + JSON.stringify(results.lose));

// ---- 8) Back up from the sheet, then R
await click(await elPt('overBack'));
await sleep(500);
const sBack = await ev('window.__pinball()');
await ev('window.__x.setup({score: 300, balls: 1})');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await ev('window.__pinball()');
results.restart = { back: { state: sBack.state, score: sBack.score, balls: sBack.balls }, keyR: { state: sR.state, score: sR.score, balls: sR.balls } };
T('restart ' + JSON.stringify(results.restart));

const errors1 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 9) portrait touch: launch and both halves
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5500);
const touch = async (p, hold = 0) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  if (hold) await sleep(hold);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const t0 = await ev('window.__pinball()');
const lp = await elPt('launch');
await touch(lp);
await sleep(300);
const tLaunch = await ev('window.__pinball()');
const tl = await ev(`window.__x.flipperPoint('l')`);
await touch(tl, 240);
await sleep(400);
const afterTouch = await ev('window.__pinball()');
const shotPortrait = await shot('vector-pinball-gate-portrait');
results.touch = {
  bootState: t0.state, launched: tLaunch.inPlay, scoreAfterTouch: afterTouch.score,
  flips: afterTouch.flips, canvasFill: await ev(`(()=>{const c=document.querySelector('canvas');return c?{w:c.clientWidth,h:c.clientHeight}:null;})()`),
  ballPoint: tl,
};
T('touch ' + JSON.stringify(results.touch));

const checks = {
  hookIsFunction: hookType === 'function',
  bootReady: s0.state === 'ready' && s0.balls === 3 && s0.score === 0,
  launchPlaysBall: !!sL.inPlay && Math.abs(sL.ball.vz) > 1,
  launchScores: maxScore > 0,
  leftFlipperSwings: heldL.flipper.l < restL - 0.25 && afterL.flipper.l > restL - 0.12 && heldL.flips.l > 0,
  rightFlipperSwings: heldR.flipper.r > restR + 0.25 && afterR.flipper.r < restR + 0.12 && heldR.flips.r > 0,
  winSheet: sWin.state === 'won' && winSheet.open && /cleared/i.test(winSheet.title),
  playAgain: sAgain.state === 'ready' && sAgain.score === 0 && sAgain.balls === 3,
  loseSheet: sLose.state === 'lost' && loseSheet.open && /drained/i.test(loseSheet.title),
  backUp: sBack.state === 'ready' && sBack.score === 0,
  keyRestart: sR.state === 'ready' && sR.score === 0 && sR.balls === 3,
  portraitPlays: tLaunch.inPlay === true && afterTouch.flips.l > 0,
  noConsoleErrors: !errors1,
};
const pass = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ checks, results, errors: errors1 || null,
  shots: { boot: shotBoot, play: shotPlay, win: shotWin, lose: shotLose, portrait: shotPortrait } }, null, 1));
console.log(pass ? 'PINBALL GATE PASS' : 'PINBALL GATE FAIL');
pageCdp.ws.close(); cdp.ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
