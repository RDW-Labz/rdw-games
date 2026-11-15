#!/usr/bin/env node
// Interaction gate for an arcade port: real CDP mouse input, state hook assertions, screenshot.
// usage: node arcade-gate.mjs <dir> <file.html> <hookName> <slug>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const [dir, file, hook, slug] = process.argv.slice(2);
const ROOT = resolve(dir);
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
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    c.events = [];
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
import { mkdtempSync } from 'node:fs';
const PROFILE = mkdtempSync('/tmp/gate-chr-');
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
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${file}` });
await sleep(5000);

const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
const s0 = await ev(`window.${hook}()`);
const bp = await ev(`window.__x.ballPoint ? window.__x.ballPoint() : window.__x.paddlePoint()`);

// 1) pointermove must move the paddle (real state change from real input)
const from = await ev(`window.__x.paddlePoint()`);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - 220, y: from.y, button: 'none', pointerType: 'mouse' });
await sleep(500);
const sMove = await ev(`window.${hook}()`);

// 1b) mapping probe: dispatching at paddleFor(x) must land the paddle on x
const probe = [];
for (const wx of [-4, -2, 2, 4]) {
  const pp = await ev(`window.__x.paddleFor(${wx})`);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pp.x, y: pp.y, button: 'none', pointerType: 'mouse' });
  await sleep(300);
  probe.push({ want: wx, px: pp.x, got: (await ev(`window.${hook}()`)).paddle.x });
}

// 2) pointerdown on the ball launches the serve
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bp.x, y: bp.y, button: 'none', pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp.x, y: bp.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp.x, y: bp.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(400);
const sLaunch = await ev(`window.${hook}()`);

// 3) autoplay: track the ball with real mouse moves and prove rallies break bricks
let rally = [];
for (let i = 0; i < 900; i++) {
  const st0 = await ev(`window.${hook}()`);
  // predict where the ball meets the paddle row (fold side-wall bounces) — a human aims, they
  // do not chase the ball's current position
  const bd = await ev(`window.__x.board()`);
  let target = st0.ball.x;
  if (st0.ball.vz > 0.1) {
    const t = (bd.PADDLE_Z - st0.ball.z) / st0.ball.vz;
    let x = st0.ball.x + st0.ball.vx * t;
    const per = bd.HALF_X * 2;
    x = ((x + bd.HALF_X) % per + per) % per - bd.HALF_X;
    target = x;
  }
  const p = await ev(`window.__x.paddleFor(${target})`);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await sleep(60);
  const st = await ev(`window.${hook}()`);
  rally.push({ i, ballX: st.ball.x, paddleX: st.paddle.x, bricks: st.bricksAlive, lives: st.lives });
  if (st.state === 'ready') {
    const bp2 = await ev(`window.__x.ballPoint()`);
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp2.x, y: bp2.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp2.x, y: bp2.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }
  if (st.state === 'clear' || st.state === 'over') break;
  if (st.bricksAlive === 0) break;
}
// win path: clearing the board opens the sheet, and "Next wave" must rebuild a full board
await sleep(500);
const sClear = await ev(`window.${hook}()`);
const overlayOpen = await ev(`document.getElementById('over').classList.contains('open')`);
const overTitle = await ev(`document.getElementById('overTitle').textContent`);
const btn = await ev(`(()=>{const r=document.getElementById('overBtn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(500);
const sWave2 = await ev(`window.${hook}()`);
const sPlay = await ev(`window.${hook}()`);

// 4) R must restart to a fresh board
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sRestart = await ev(`window.${hook}()`);

const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = join('/home/cluer/cloned-free-games/.queue/playtest', `${slug}-gate.png`);
await writeFile(out, Buffer.from(shot.data, 'base64'));

const checks = {
  boot: s0 && s0.bricksAlive > 0,
  paddleMoved: Math.abs(sMove.paddle.x - s0.paddle.x) > 0.15,
  launched: sLaunch.launched === true && sLaunch.state === 'play',
  bricksBroke: sClear.bricksAlive === 0,
  winSheet: overlayOpen === true && /cleared/i.test(overTitle),
  nextWave: sWave2.wave === 2 && sWave2.bricksAlive === 35 && sWave2.state === 'ready',
  scoredFull: sClear.score >= 350,
  restarted: sRestart.bricksAlive === 35 && sRestart.score === 0 && sRestart.lives === 3,
  noErrors: !errors,
};
console.log(JSON.stringify({ probe, checks, errors, trace: rally.slice(0, 6), s0, sMove: sMove.paddle, sLaunch: { launched: sLaunch.launched, state: sLaunch.state }, sPlay, sRestart: { bricks: sRestart.bricksAlive, score: sRestart.score, lives: sRestart.lives }, shot: out }, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
