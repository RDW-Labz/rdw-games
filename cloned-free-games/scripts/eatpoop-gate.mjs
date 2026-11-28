#!/usr/bin/env node
// Interaction gate for the Eat Poop You Cat port: real CDP mouse/touch input, state-hook
// assertions for the full write -> draw -> write -> draw chain, the reveal strip, its drag,
// the restart path, and a portrait-phone pass. Screenshots land in .queue/playtest/.
// usage: node eatpoop-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/eat-poop-you-cat/index.html';
const FWD = 'games/arcade/eat-poop-you-cat.html';
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
const PROFILE = mkdtempSync('/tmp/eatpoop-');
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
const hook = () => ev('window.__eatpoop ? window.__eatpoop() : null');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');

async function shot(name) {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  const out = join(OUT, `eat-poop-you-cat-${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
}
async function centre(sel) {
  return ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
}
async function click(sel) {
  const p = await centre(sel);
  if (!p) throw new Error('no element ' + sel);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(350);
}
async function type(text) {
  await click('#txt');
  await S('Input.insertText', { text });
  await sleep(200);
}
async function stroke(points) {
  const [first, ...rest] = points;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  for (const p of rest) {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(16);
  }
  const last = rest[rest.length - 1] || first;
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(250);
}

/* ---------------------------------------------------------------- desktop run */
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const consoleErrors = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const allLogs = () => cdp.events.filter((e) => e.method === 'Log.entryAdded' || e.method === 'Runtime.consoleAPICalled')
  .map((e) => (e.params.entry ? e.params.entry.level + ':' + e.params.entry.text : e.params.type + ':' + (e.params.args || []).map((a) => a.description || a.value).join(' ')))
  .slice(-8);

const boot = await hook();
const introShot = await shot('intro');

// 1) start a 4-player chain from the intro sheet
await click('#pcount button[data-n="4"]');
await click('#go');
const afterStart = await hook();

// 2) player 1 writes
await click('#taketurn');
const writePhase = await hook();
const textareaPresent = await ev(`!!document.querySelector('#txt')`);
await type('A cat riding a skateboard through a supermarket');
const typed = await ev(`document.querySelector('#txt').value`);
await click('#sub');
const afterWrite1 = await hook();

// 3) player 2 draws — real pointerdown/move/up on the 3D sheet
await click('#taketurn');
const drawPhase = await hook();
const blank1 = await ev('window.__eatpoop.inkBox()');
const rect = await ev('window.__eatpoop.paper()');
const x0 = rect.x + rect.w * 0.18, x1 = rect.x + rect.w * 0.82;
const y0 = rect.y + rect.h * 0.30, y1 = rect.y + rect.h * 0.72;
const pts = [];
for (let i = 0; i <= 10; i++) pts.push({ x: Math.round(x0 + (x1 - x0) * (i / 10)), y: Math.round(y0) });
for (let i = 1; i <= 8; i++) pts.push({ x: Math.round(x1), y: Math.round(y0 + (y1 - y0) * (i / 8)) });
await stroke(pts);
const afterStroke = await hook();
const ink1 = await ev('window.__eatpoop.inkBox()');
const drawShot = await shot('draw');
await click('#done');
const afterDraw1 = await hook();

// 4) player 3 writes a caption while looking at that drawing
await click('#taketurn');
const prevImg = await ev(`(()=>{const i=document.querySelector('#prevImg');return i? i.getAttribute('src').slice(0,22): null;})()`);
await type('a dog in a supermarket');
await click('#sub');
const afterWrite2 = await hook();

// 5) player 4 draws again, then the chain reveals
await click('#taketurn');
const rect2 = await ev('window.__eatpoop.paper()');
const c = { x: rect2.x + rect2.w * 0.5, y: rect2.y + rect2.h * 0.5 };
const circle = [];
for (let i = 0; i <= 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  circle.push({ x: Math.round(c.x + Math.cos(a) * rect2.w * 0.14), y: Math.round(c.y + Math.sin(a) * rect2.h * 0.14) });
}
await stroke(circle);
const afterStroke2 = await hook();
await click('#done');
const revealed = await hook();
await sleep(900);
const cardPos = await ev('window.__eatpoop.cards()');
const revealShot = await shot('reveal');

// 6) drag the strip — the group must turn
const rot0 = revealed.turnRot;
await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 260, button: 'none', pointerType: 'mouse' });
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 260, button: 'left', clickCount: 1, pointerType: 'mouse' });
for (let i = 1; i <= 8; i++) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640 + i * 22, y: 260, button: 'left', buttons: 1, pointerType: 'mouse' });
  await sleep(20);
}
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 816, y: 260, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(400);
const rotated = await hook();

// 7) play again returns to a fresh chain
await click('#restart');
const restarted = await hook();

// 8) the flat forwarding URL still resolves to the folder build
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FWD}` });
await sleep(3500);
const fwdUrl = await ev('location.pathname');
const fwdHook = await hook();

/* ---------------------------------------------------------------- portrait phone run */
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
await click('#go');
await click('#taketurn');
await type('a frog on a bicycle');
await click('#sub');
await click('#taketurn');
const mRect = await ev('window.__eatpoop.paper()');
const blankPhone = await ev('window.__eatpoop.inkBox()');
const t0 = { x: Math.round(mRect.x + mRect.w * 0.25), y: Math.round(mRect.y + mRect.h * 0.35) };
const t1 = { x: Math.round(mRect.x + mRect.w * 0.72), y: Math.round(mRect.y + mRect.h * 0.62) };
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: t0.x, y: t0.y, id: 1 }] });
for (let i = 1; i <= 12; i++) {
  await S('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(t0.x + (t1.x - t0.x) * (i / 12)), y: Math.round(t0.y + (t1.y - t0.y) * (i / 12)), id: 1 }] });
  await sleep(22);
}
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const mobileDraw = await hook();
const mobileInk = await ev('window.__eatpoop.inkBox()');
const mobileShot = await shot('phone');
const diag = await ev('window.__eatpoop.diag()');

const vw = 390, vh = 844;
const inView = mRect.x >= 0 && mRect.y >= 0 && mRect.x + mRect.w <= vw && mRect.y + mRect.h <= vh;

const checks = {
  boot: boot && boot.phase === 'intro' && boot.players === 4,
  started: afterStart && afterStart.phase === 'pass' && afterStart.players === 4,
  writeTurn: writePhase && writePhase.phase === 'write' && writePhase.turn === 0 && textareaPresent,
  typed: typed === 'A cat riding a skateboard through a supermarket',
  wroteEntry: afterWrite1 && afterWrite1.chain.length === 1 && afterWrite1.chain[0].kind === 'write' && afterWrite1.turn === 1,
  drawTurn: drawPhase && drawPhase.phase === 'draw' && drawPhase.turn === 1,
  drew: afterStroke && afterStroke.strokes >= 1 && afterStroke.ink > blank1.n + 80,
  drewStaysPut: ink1 && blank1 && ink1.n > blank1.n + 80 && ink1.x1 > blank1.x1 + 100,
  drewEntry: afterDraw1 && afterDraw1.chain.length === 2 && afterDraw1.chain[1].kind === 'draw' && afterDraw1.chain[1].hasImg,
  sawDrawing: typeof prevImg === 'string' && prevImg.startsWith('data:image/png'),
  captioned: afterWrite2 && afterWrite2.chain.length === 3 && afterWrite2.chain[2].len > 0,
  secondDraw: afterStroke2 && afterStroke2.strokes >= 1 && afterStroke2.ink > 40,
  revealed: revealed && revealed.phase === 'reveal' && revealed.over === true && revealed.cards === 4 &&
    revealed.chain.map((c) => c.kind).join(',') === 'write,draw,write,draw',
  stripTurns: Math.abs(rotated.turnRot - rot0) > 0.05,
  allCardsOnScreen: Array.isArray(cardPos) && cardPos.length === 4 &&
    cardPos.every((p) => p.x > 20 && p.x < 1260) &&
    Math.max(...cardPos.map((p) => p.x)) - Math.min(...cardPos.map((p) => p.x)) > 500,
  restarted: restarted && restarted.phase === 'pass' && restarted.chain.length === 0 && restarted.over === false,
  forwarder: fwdUrl === '/games/arcade/eat-poop-you-cat/' && fwdHook && fwdHook.phase === 'intro',
  phoneFits: mRect && inView && mRect.w > 250,
  phoneDrew: mobileDraw && mobileDraw.phase === 'draw' && mobileDraw.strokes >= 1 && mobileInk && blankPhone && mobileInk.n > blankPhone.n + 80 && mobileInk.x1 > blankPhone.x1 + 200,
  noTexUploadErrors: !allLogs().some((t) => /Offset overflows|INVALID_VALUE/.test(t)) && diag && diag.glErr === 0,
  noErrors: !consoleErrors(),
};

console.log(JSON.stringify({
  checks,
  errors: consoleErrors(),
  rect, mRect: { ...mRect, inView },
  boot, afterStart, writePhase, afterWrite1, drawPhase: { phase: drawPhase?.phase, turn: drawPhase?.turn },
  afterStroke: { strokes: afterStroke?.strokes, ink: afterStroke?.ink },
  afterDraw1: afterDraw1?.chain, afterWrite2: afterWrite2?.chain, revealed: { ...revealed, chain: revealed?.chain },
  rotated: rotated?.turnRot, restarted: { phase: restarted?.phase, chain: restarted?.chain?.length },
  cardPos,
  blank1, ink1, blankPhone, mobileInk,
  frames: { at: mobileDraw?.frames }, diag, allLogs: allLogs(),
  mobileDraw: { phase: mobileDraw?.phase, strokes: mobileDraw?.strokes, ink: mobileDraw?.ink },
  shots: { introShot, drawShot, revealShot, mobileShot },
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
