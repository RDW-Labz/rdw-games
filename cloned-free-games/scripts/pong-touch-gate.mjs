#!/usr/bin/env node
// Portrait touch gate for the King Pong port: 390x844 emulated touch, finger drags the paddle,
// a tap on the field serves, the court stays in frame, and the player actually scores a point.
// usage: node pong-touch-gate.mjs <dir> <file.html> <hook> <slug>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync as mkdt, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const [dir, file, hook, slug] = process.argv.slice(2);
if (!dir || !file || !hook || !slug) { console.error('usage: node pong-touch-gate.mjs <dir> <file.html> <hook> <slug>'); process.exit(2); }
const ROOT = resolve(dir);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const body = await readFile(join(ROOT, p));
      res.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()] || 'application/octet-stream' }).end(body);
    } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run',
  `--user-data-dir=${mkdt('/tmp/pong-touch-chr-')}`, 'about:blank'],
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

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${file}` });
await sleep(5000);

const touch = (x, y, type) => S('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 9, radiusY: 9, force: 1, id: 1 }],
});

const s0 = await ev(`window.${hook}()`);
const board = await ev(`window.__x.board()`);
const boot = await S('Page.captureScreenshot', { format: 'png' });
const out0 = `/home/cluer/cloned-free-games/.queue/playtest/${slug}-touch-boot.png`;
await writeFile(out0, Buffer.from(boot.data, 'base64'));

// 1) finger drag must move the paddle to the finger's world position
const finger = [];
for (const wx of [-3, 3]) {
  const p = await ev(`window.__x.paddleFor(${wx})`);
  await touch(p.x, p.y, 'touchStart');
  await sleep(220);
  await touch(p.x, p.y, 'touchMove');
  await sleep(220);
  await touch(p.x, p.y, 'touchEnd');
  await sleep(220);
  finger.push({ want: wx, x: p.x, got: (await ev(`window.${hook}()`)).paddle.x });
}

// 2) a tap anywhere on the court serves
const bp = await ev(`window.__x.ballPoint()`);
await touch(bp.x, bp.y, 'touchStart'); await touch(bp.x, bp.y, 'touchEnd');
await sleep(500);
const sServe = await ev(`window.${hook}()`);

// 3) follow the ball with the finger and take at least one point
const t0 = Date.now();
let iter = 0;
while (Date.now() - t0 < 70000) {
  iter += 1;
  const st = await ev(`window.${hook}()`);
  if (st.state === 'ready') { await touch(195, 500, 'touchStart'); await touch(195, 500, 'touchEnd'); await sleep(120); continue; }
  if (st.state === 'won' || st.state === 'lost' || st.state === 'champion') break;
  const target = await ev(`window.__x.meet(${board.PLAYER_Z})`);
  const p = await ev(`window.__x.paddleFor(${Number.isFinite(target) ? target : st.ball.x})`);
  await touch(p.x, p.y, 'touchStart');
  await sleep(55);
  await touch(p.x, p.y, 'touchMove');
  await sleep(40);
  await touch(p.x, p.y, 'touchEnd');
}
const sPlay = await ev(`window.${hook}()`);
const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = `/home/cluer/cloned-free-games/.queue/playtest/${slug}-touch.png`;
await writeFile(out, Buffer.from(shot.data, 'base64'));

// 4) the whole court must sit inside a 390x844 viewport (both paddle ends, both scoring lines)
const corners = await ev(`(()=>{const b=window.__x.board();
  return [window.__x.point(-b.HALF_X,b.PLAYER_Z),window.__x.point(b.HALF_X,b.PLAYER_Z),
          window.__x.point(-b.HALF_X,b.CPU_Z),window.__x.point(b.HALF_X,b.CPU_Z)];})()`);
const inFrame = corners.every((c) => c.x > 2 && c.x < 388 && c.y > 60 && c.y < 800);

const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.text || e.params.entry?.text).slice(0, 3).join(' | ');

const checks = {
  boot: s0 && s0.state === 'ready' && s0.level === 0 && s0.toWin === 3,
  fingerTracks: finger.every((f) => Math.abs(f.got - f.want) < 0.4),
  tapServed: sServe.launched === true,
  scoredByTouch: sPlay.player >= 1,
  courtInFrame: inFrame,
  noErrors: !errors,
};
console.log(JSON.stringify({ checks, finger, corners, errors, board, serve: sServe.launched, play: { player: sPlay.player, cpu: sPlay.cpu, state: sPlay.state }, iter, out0, out }, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'TOUCH PASS' : 'TOUCH FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
