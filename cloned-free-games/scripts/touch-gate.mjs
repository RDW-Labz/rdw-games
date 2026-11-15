#!/usr/bin/env node
// Touch gate: iPhone-sized viewport, real touch events, proves the paddle follows a finger and
// a tap serves, and bricks break. usage: node touch-gate.mjs <dir> <file.html> <hook> <slug>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync as mkdt, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const [dir, file, hook, slug] = process.argv.slice(2);
const ROOT = resolve(dir);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream' }).end(body);
    } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run',
  `--user-data-dir=${mkdt('/tmp/touch-chr-')}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools ' + err.slice(-200))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});

const ws = new WebSocket(endpoint);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { ok, bad } = pending.get(msg.id); pending.delete(msg.id); msg.error ? bad(new Error(msg.error.message)) : ok(msg.result); } else if (msg.method) events.push(msg); };
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); setTimeout(() => { if (pending.delete(i)) bad(new Error('timeout ' + method)); }, 30000); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const ev = async (e) => (await S('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

await S('Runtime.enable'); await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${file}` });
await sleep(5000);

const touch = (x, y, type) => S('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
});

const s0 = await ev(`window.${hook}()`);
const shot0 = await S('Page.captureScreenshot', { format: 'png' });
const out0 = `/home/cluer/cloned-free-games/.queue/playtest/${slug}-touch-boot.png`;
await writeFile(out0, Buffer.from(shot0.data, 'base64'));
const left = await ev(`window.__x.paddleFor(-3)`);
await touch(left.x, left.y, 'touchStart'); await touch(left.x, left.y, 'touchEnd');
await sleep(400);
const sTouch1 = await ev(`window.${hook}()`);
const right = await ev(`window.__x.paddleFor(3)`);
await touch(right.x, right.y, 'touchStart'); await touch(right.x, right.y, 'touchEnd');
await sleep(400);
const sTouch2 = await ev(`window.${hook}()`);

// tap serves (tap mid-board too: a finger anywhere on the field should serve)
const bp = await ev(`window.__x.ballPoint()`);
let sServe = null, servedBy = '';
for (const [label, pt] of [['ball', bp], ['center', { x: 195, y: 420 }], ['launchBtn', await ev(`(()=>{const r=document.getElementById('launch').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`)]]) {
  await touch(pt.x, pt.y, 'touchStart'); await touch(pt.x, pt.y, 'touchEnd');
  await sleep(500);
  sServe = await ev(`window.${hook}()`);
  if (sServe.launched) { servedBy = label; break; }
}

// drag the finger to follow the ball for a few seconds
for (let i = 0; i < 80; i++) {
  const st = await ev(`window.${hook}()`);
  const p = await ev(`window.__x.paddleFor(${st.ball.x})`);
  await touch(p.x, p.y, 'touchStart');
  await sleep(60);
  await touch(p.x, p.y, 'touchEnd');
}
const sPlay = await ev(`window.${hook}()`);
const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = `/home/cluer/cloned-free-games/.queue/playtest/${slug}-touch.png`;
await writeFile(out, Buffer.from(shot.data, 'base64'));

const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.text).join(' | ');
const checks = {
  boot: s0.bricksAlive === 35,
  fingerLeft: sTouch1.paddle.x < -2.5,
  fingerRight: sTouch2.paddle.x > 2.5,
  tapServed: sServe.launched === true,
  bricksBroke: sPlay.bricksAlive < 35,
  noErrors: !errors,
};
console.log(JSON.stringify({ checks, servedBy, bp, errors, s0: s0.paddle, left: sTouch1.paddle, right: sTouch2.paddle, served: sServe.launched, play: sPlay, shot: out }));
console.log(Object.values(checks).every(Boolean) ? 'TOUCH PASS' : 'TOUCH FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
