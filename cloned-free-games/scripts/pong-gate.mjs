#!/usr/bin/env node
// Interaction gate for the King Pong port: real CDP mouse input, state-hook assertions, screenshots.
// Proves the paddle tracks the cursor, a real click serves, a league is WON by playing it, the next
// league is LOST by parking the paddle, the sheet buttons work, and R restarts the campaign.
// usage: node pong-gate.mjs <dir> <file.html> <hookName> <slug>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const [dir, file, hook, slug] = process.argv.slice(2);
if (!dir || !file || !hook || !slug) { console.error('usage: node pong-gate.mjs <dir> <file.html> <hook> <slug>'); process.exit(2); }
const ROOT = resolve(dir);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = await new Promise((ok) => {
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
  s.listen(0, '127.0.0.1', () => ok(s));
});

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${mkdtempSync('/tmp/pong-chr-')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});

const ws = new WebSocket(endpoint);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { ok, bad } = pending.get(msg.id); pending.delete(msg.id); msg.error ? bad(new Error(msg.error.message)) : ok(msg.result); }
  else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
  const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  setTimeout(() => { if (pending.delete(i)) bad(new Error('timeout ' + method)); }, 30000);
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const clickAt = async (x, y) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const centerOf = (sel) => ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${file}` });
await sleep(5000);

const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const s0 = await ev(`window.${hook}()`);

// 1) pointermove must move the paddle (real state change from real input), and the measured map
//    must put the paddle where the cursor is at every x we probe.
const from = await ev(`window.__x.paddlePoint()`);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - 220, y: from.y, button: 'none', pointerType: 'mouse' });
await sleep(400);
const sMove = await ev(`window.${hook}()`);

const probe = [];
for (const wx of [-2, -1, 1, 2]) {
  const pp = await ev(`window.__x.paddleFor(${wx})`);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pp.x, y: pp.y, button: 'none', pointerType: 'mouse' });
  await sleep(250);
  probe.push({ want: wx, px: pp.x, got: (await ev(`window.${hook}()`)).paddle.x });
}

// 2) a real click on the Serve button starts the ball
const serveBtn = await centerOf('#serve');
await clickAt(serveBtn.x, serveBtn.y);
await sleep(400);
const sServe = await ev(`window.${hook}()`);

// 3) play the first league to the target: track the ball where it will meet the paddle row
const play = [];
const shotMid = async (name) => {
  const shot = await S('Page.captureScreenshot', { format: 'png' });
  const out = join('/home/cluer/cloned-free-games/.queue/playtest', `${slug}-${name}.png`);
  await mkdir(join('/home/cluer/cloned-free-games/.queue/playtest'), { recursive: true });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  return out;
};
let shots = [];
const board = await ev(`window.__x.board()`);
const t0 = Date.now();
let iter = 0;
while (Date.now() - t0 < 90000) {
  iter += 1;
  const st = await ev(`window.${hook}()`);
  if (st.state === 'won' || st.state === 'lost' || st.state === 'champion') break;
  if (st.state === 'ready') { await clickAt(serveBtn.x, serveBtn.y); await sleep(120); continue; }
  const target = await ev(`window.__x.meet(${board.PLAYER_Z})`);
  const pp = await ev(`window.__x.paddleFor(${Number.isFinite(target) ? target : st.ball.x})`);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pp.x, y: pp.y, button: 'none', pointerType: 'mouse' });
  if (st.player >= 1 && shots.length === 0) shots.push(await shotMid('gate-mid'));
  await sleep(55);
}
const sWin = await ev(`window.${hook}()`);
const winSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent,btn:document.getElementById('overBtn').textContent}))()`);

// 4) Next level must open a fresh league with a quicker ladder step
const overBtn = await centerOf('#overBtn');
await clickAt(overBtn.x, overBtn.y);
await sleep(500);
const sNext = await ev(`window.${hook}()`);

// 5) lose the new league honestly: park the paddle on the far wall and let the cpu score
const park = await ev(`window.__x.paddleFor(-4.6)`);
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: park.x, y: park.y, button: 'none', pointerType: 'mouse' });
const t1 = Date.now();
while (Date.now() - t1 < 60000) {
  const st = await ev(`window.${hook}()`);
  if (st.state === 'lost' || st.state === 'won') break;
  if (st.state === 'ready') { await clickAt(serveBtn.x, serveBtn.y); await sleep(120); continue; }
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: park.x, y: park.y, button: 'none', pointerType: 'mouse' });
  await sleep(80);
}
const sLose = await ev(`window.${hook}()`);
const loseSheet = await ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,btn:document.getElementById('overBtn').textContent}))()`);
const shotLose = await shotMid('gate-lose');

// 6) R must restart the campaign from league one
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sRestart = await ev(`window.${hook}()`);
const shotEnd = await shotMid('gate');

const checks = {
  boot: s0 && s0.state === 'ready' && s0.level === 0 && s0.player === 0 && s0.cpu === 0 && s0.toWin === 3,
  paddleMoved: Math.abs(sMove.paddle.x - s0.paddle.x) > 0.4,
  mapAccurate: probe.every((p) => Math.abs(p.got - p.want) < 0.25),
  served: sServe.launched === true && sServe.state === 'play',
  wonLeague: sWin.state === 'won' && sWin.player >= sWin.toWin && sWin.cpu < sWin.toWin,
  winSheet: winSheet.open === true && /cleared/i.test(winSheet.title),
  nextLevel: sNext.level === 1 && sNext.player === 0 && sNext.cpu === 0 && sNext.state === 'ready' && sNext.toWin > s0.toWin,
  lostLeague: sLose.state === 'lost' && sLose.cpu >= sLose.toWin,
  loseSheet: loseSheet.open === true && /lost/i.test(loseSheet.title),
  restarted: sRestart.level === 0 && sRestart.player === 0 && sRestart.cpu === 0 && sRestart.state === 'ready',
  noErrors: !errors,
};
console.log(JSON.stringify({
  checks, probe, errors,
  s0: { level: s0.level, toWin: s0.toWin, state: s0.state },
  sMove: sMove.paddle, sServe: { launched: sServe.launched, state: sServe.state },
  sWin: { level: sWin.level, player: sWin.player, cpu: sWin.cpu, toWin: sWin.toWin, state: sWin.state },
  winSheet, sNext: { level: sNext.level, toWin: sNext.toWin, state: sNext.state },
  sLose: { level: sLose.level, player: sLose.player, cpu: sLose.cpu, toWin: sLose.toWin, state: sLose.state },
  loseSheet, sRestart: { level: sRestart.level, state: sRestart.state }, iter, shots, shotEnd,
}, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'GATE PASS' : 'GATE FAIL');
ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
