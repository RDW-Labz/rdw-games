#!/usr/bin/env node
// Click-and-play gate for the Impostor MX port. Real CDP mouse events on the 3D cards,
// state-hook assertions through the whole round (deal -> private reveal -> debate -> vote
// -> verdict -> punishment wheel -> play again), a second round that loses, and a portrait
// phone pass. Screenshots land in .queue/playtest/.
// usage: node impostor-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/impostor-mx/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const CMD_TIMEOUT = 240000;
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/impostor-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 90000);
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
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`page exception in \`${expr.slice(0, 120)}\`: ${String(d).slice(0, 400)}`);
  }
  return r.result?.value;
};
const hook = () => ev('window.__impostor ? window.__impostor() : null');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');

async function shot(name) {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  const out = join(OUT, `impostor-mx-${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
}
async function poll(fn, want, budgetMs = 30000, label = 'poll') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await fn();
    if (want(last)) return last;
    await sleep(220);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)?.slice(0, 260)}`);
}
async function centre(sel) {
  return ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
}
async function clickAt(x, y) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
}
async function clickSel(sel) {
  const p = await centre(sel);
  if (!p) throw new Error('no visible element ' + sel);
  await clickAt(p.x, p.y);
  return p;
}
async function tapCard(i) {
  const p = await ev(`window.__impostor.cardPoint(${i})`);
  if (!p) throw new Error('no card point ' + i);
  const inside = p.x > 4 && p.y > 4 && p.x < await ev('innerWidth') - 4 && p.y < await ev('innerHeight') - 4;
  if (!inside) throw new Error(`card ${i} off-screen at ${JSON.stringify(p)}`);
  await clickAt(p.x, p.y);
  return p;
}
async function boot() {
  await poll(() => ev('typeof window.__impostor === "function" && window.__impostor().frames > 0'), Boolean, 90000, 'boot hook');
}

const consoleErrors = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 5).join(' | ');

/* ---------------------------------------------------------------- desktop round 1 */
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await boot();
const bootState = await hook();
const lobbyShot = await shot('lobby');

// 1) deal from the real setup panel
await clickSel('#deal');
const dealt = await poll(hook, (h) => h && h.phase === 'reveal', 8000, 'deal');

// 2) private reveal: every seat flips up on a real click and back down
const revealLog = [];
let peekWord = null, peekImp = null;
for (let i = 0; i < dealt.players; i++) {
  const before = await hook();
  await tapCard(before.seat);
  const up = await poll(hook, (h) => h.flipped === true, 6000, `flip up seat ${i}`);
  if (up.face === 'word') peekWord = up.word;
  if (up.face === 'impostor') peekImp = up.seat;
  await tapCard(up.seat);
  const down = await poll(hook, (h) => h.flipped === false, 6000, `flip down seat ${i}`);
  revealLog.push({ seat: before.seat, face: up.face, next: down.seat, phase: down.phase });
}
const afterReveal = await hook();
const revealShot = await shot('reveal');
// art plate for the library tile: one card face-up on a dealt table
await ev(`window.__impostor.setup({ seed: 3, players: 6, impostors: 1, category: 'fiesta' })`);
await sleep(400);
const artSeat = (await hook()).seat;
await tapCard(artSeat);
await sleep(900);
const artShot = await shot('art');

// back to the real table for the vote
await ev(`window.__impostor.setup({ seed: ${dealt.seed}, players: ${dealt.players}, impostors: ${dealt.impN}, category: '${dealt.category}' })`);
for (let i = 0; i < dealt.players; i++) {
  const b = await hook();
  await tapCard(b.seat); await poll(hook, (h) => h.flipped, 6000, 're-flip');
  await tapCard(b.seat); await poll(hook, (h) => !h.flipped, 6000, 're-hide');
  await sleep(60);
}

// 3) debate -> vote
await clickSel('#vote');
const voted0 = await poll(hook, (h) => h.phase === 'vote', 8000, 'call the vote');
let guard = 0;
while ((await hook()).phase === 'vote' && guard++ < 20) {
  const h = await hook();
  const crewSeats = [...Array(h.players).keys()].filter((i) => !h.impostors.includes(i) && i !== h.seat);
  const target = h.impostors.includes(h.seat) ? crewSeats[0] : h.impostors[0];
  await tapCard(target);
  await poll(hook, (x) => x.votes.length >= h.votes.length + 1 || x.phase === 'result', 8000, `vote ${h.seat}`);
}
const result1 = await poll(hook, (h) => h.phase === 'result', 8000, 'verdict');
await sleep(700);                       // let the cards finish flipping face-up
const resultShot = await shot('result');

// 4) punishment wheel
const wheelBefore = result1.wheel.angle;
await clickSel('#spin');
await poll(hook, (h) => h.phase === 'wheel' || h.phase === 'punish', 8000, 'wheel starts');
const landed = await poll(hook, (h) => h.wheel.landed >= 0, 40000, 'wheel lands');
await sleep(500);
const wheelShot = await shot('wheel');

// 5) play again
await clickSel('#again');
const again = await poll(hook, (h) => h.phase === 'lobby', 8000, 'play again');

/* ---------------------------------------------------------------- desktop round 2 (lose) */
await ev(`window.__impostor.setup({ seed: 21, players: 6, impostors: 1, category: 'kitchen' })`);
await sleep(500);
const r2 = await hook();
for (let i = 0; i < r2.players; i++) {
  const b = await hook();
  await tapCard(b.seat); await poll(hook, (h) => h.flipped, 6000, 'r2 flip');
  await tapCard(b.seat); await poll(hook, (h) => !h.flipped, 6000, 'r2 hide');
}
const r2Debate = await hook();
await clickSel('#vote');
await poll(hook, (h) => h.phase === 'vote', 8000, 'r2 vote opens');
guard = 0;
while ((await hook()).phase === 'vote' && guard++ < 20) {
  const h = await hook();
  const crewSeats = [...Array(h.players).keys()].filter((i) => !h.impostors.includes(i));
  const scapegoat = crewSeats[0];
  const target = h.seat === scapegoat ? crewSeats[1] : scapegoat;
  await tapCard(target);
  await poll(hook, (x) => x.votes.length >= h.votes.length + 1 || x.phase === 'result', 8000, 'r2 vote');
}
const result2 = await poll(hook, (h) => h.phase === 'result', 8000, 'r2 verdict');
await sleep(600);
const loseShot = await shot('lose');

/* ---------------------------------------------------------------- portrait phone */
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await boot();
await ev(`window.__impostor.setup({ seed: 31, players: 6, impostors: 1, category: 'office' })`);
await sleep(600);
const phonePts = await ev('window.__impostor.allPoints()');
const phoneBoxes = await ev('[0,1,2,3,4,5].map(i=>window.__impostor.cardBox(i))');
const bandP = await ev('window.__impostor.hudBand()');
// tap a card on the phone with a real touch event
const tapPt = await ev('window.__impostor.cardPoint(window.__impostor().seat)');
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(tapPt.x), y: Math.round(tapPt.y), id: 1 }] });
await sleep(80);
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const phoneTap = await poll(hook, (h) => h.flipped === true, 8000, 'phone tap reveals');
const phoneShot = await shot('phone');
const diagP = await ev('window.__impostor.diag()');

const vw = 390, vh = 844;
const ptsIn = phonePts.every((p) => p.x > 6 && p.x < vw - 6 && p.y > bandP.topPx - 4 && p.y < bandP.botPx + 4);
const xs = phonePts.map((p) => p.x), ys = phonePts.map((p) => p.y);
const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
const centred = Math.abs((bbox.x0 + bbox.x1) / 2 - vw / 2) < 0.06 * vw;
const cardW = Math.min(...phoneBoxes.map((b) => b.x1 - b.x0));
const noOverlap = phoneBoxes.every((a, i) => phoneBoxes.every((b, j) => i === j || (a.x1 <= b.x0 + 1 || b.x1 <= a.x0 + 1 || a.y1 <= b.y0 + 1 || b.y1 <= a.y0 + 1)));

const checks = {
  boot: bootState && bootState.phase === 'lobby' && bootState.cards === 5 && bootState.players === 5,
  bootFrames: bootState && bootState.frames > 0,
  dealt: dealt.phase === 'reveal' && dealt.seat === 0 && dealt.cards === 5 && dealt.impostors.length === 1 &&
    dealt.word && typeof dealt.word === 'string',
  revealWalks: revealLog.length === 5 && revealLog.slice(0, 4).every((r, i) => r.seat === i && r.next === i + 1),
  revealEnds: afterReveal.phase === 'debate' && afterReveal.seen.length === 5 && afterReveal.flipped === false,
  wordToCrew: typeof peekWord === 'string' && peekWord.length > 2 && peekWord === dealt.word,
  impostorNotTold: peekImp !== null && revealLog[peekImp] && revealLog[peekImp].face === 'impostor',
  voteOpens: voted0.phase === 'vote' && voted0.seat === 0 && voted0.votes.length === 0,
  verdict: result1.phase === 'result' && result1.result === 'crew' && result1.ejected === result1.impostors[0] &&
    result1.tally[result1.ejected] >= 3 && result1.over === true,
  wheelSpins: landed.wheel.landed >= 0 && landed.wheel.landed < 8 && Math.abs(landed.wheel.angle - wheelBefore) > 0.2 &&
    landed.phase === 'punish' && typeof landed.slam === 'string' && landed.slam.length > 8,
  again: again.phase === 'lobby' && again.over === false && again.cards === 5,
  lose: r2Debate.phase === 'debate' && result2.phase === 'result' && result2.result === 'impostors' &&
    result2.why === 'innocent' && result2.ejected !== null &&
    !result2.impostors.includes(result2.ejected),
  phoneCards: phonePts.length === 6 && ptsIn && centred && cardW > 46 && noOverlap,
  phoneTap: phoneTap.flipped === true && phoneTap.face !== 'back',
  noGlErrors: diagP && diagP.glErr === 0,
  noErrors: !consoleErrors(),
};

console.log(JSON.stringify({
  checks,
  errors: consoleErrors(),
  boot: { phase: bootState?.phase, cards: bootState?.cards, frames: bootState?.frames },
  dealt: { seed: dealt.seed, word: dealt.word, impostors: dealt.impostors, category: dealt.category },
  revealLog, peekWord, peekImp,
  afterReveal: { phase: afterReveal.phase, seen: afterReveal.seen },
  result1: { result: result1.result, why: result1.why, ejected: result1.ejected, tally: result1.tally, impostors: result1.impostors },
  wheel: { landed: landed.wheel.landed, angleBefore: wheelBefore, angleAfter: landed.wheel.angle, slam: landed.slam, phase: landed.phase },
  again: { phase: again.phase, cards: again.cards },
  result2: { result: result2.result, why: result2.why, ejected: result2.ejected, tally: result2.tally, impostors: result2.impostors },
  phone: { pts: phonePts.length, bbox, centred, cardW, ptsIn, noOverlap, band: bandP, diag: diagP },
  shots: { lobbyShot, revealShot, artShot, resultShot, wheelShot, loseShot, phoneShot },
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
