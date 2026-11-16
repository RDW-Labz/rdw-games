#!/usr/bin/env node
// Click-and-play gate for the Memory port (games/arcade/memory.html).
//
// Proves with real DOM PointerEvents that a click turns a card over, that a matching pair is
// scored, that a mismatching pair costs flips and flips back, that a full sweep reaches the win
// sheet, that a restart resets the board, that the flip budget can be lost, and that a portrait
// 390x844 touch pointer plays too. Screenshots every stage. No canvas-exists credit.
//
// usage: node memory-gate.mjs [url] [shotPrefix]
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:8793/games/arcade/memory.html';
const SHOT = process.argv[3] || 'memory';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
mkdirSync(OUT, { recursive: true });

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(2); }
const PROFILE = mkdtempSync('/tmp/memgate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1440,900', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});
const ws = new WebSocket(endpoint);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
let id = 0;
const p = new Map();
const logs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && p.has(msg.id)) { const { ok, bad, method } = p.get(msg.id); p.delete(msg.id); msg.error ? bad(new Error(method + ': ' + msg.error.message)) : ok(msg.result); }
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 240));
  else if (msg.method === 'Runtime.exceptionThrown') logs.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || '').slice(0, 240));
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
  const i = ++id;
  p.set(i, { ok, bad, method });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  setTimeout(() => { if (p.delete(i)) bad(new Error('timeout ' + method)); }, 30000);
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, pp) => send(m, pp, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => {
  const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
  return r.result?.value;
};
// Real PointerEvents on the element under the point (and the canvas), inside the page.
const fireAt = (x, y, pointerType = 'mouse') => ev(`(() => {
  const p = { x: ${x}, y: ${y} };
  const cv = document.querySelector('canvas');
  const el = document.elementFromPoint(p.x, p.y) || cv;
  const mk = (t, b) => new PointerEvent(t, { pointerId: 1, pointerType: '${pointerType}', isPrimary: true,
    bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: b });
  for (const e of [el, cv]) { if (!e) continue; e.dispatchEvent(mk('pointerdown', 1)); e.dispatchEvent(mk('pointerup', 0)); }
  return true; })()`);
const shotOf = async (name) => {
  const shot = await S('Page.captureScreenshot', { format: 'png' });
  const out = `${OUT}/${SHOT}-${name}.png`;
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  return out;
};
const state = () => ev('window.__memory ? window.__memory() : null');
const clickCard = async (r, c, pointerType = 'mouse') => {
  const pt = await ev(`window.__memory.cardPoint(${r}, ${c})`);
  if (!pt) return null;
  await fireAt(pt.x, pt.y, pointerType);
  return pt;
};
const sheet = () => ev(`(() => { const o = document.getElementById('over');
  return { open: o.classList.contains('open'), title: document.getElementById('overTitle').textContent,
    text: document.getElementById('overText').textContent, btn: document.getElementById('overBtn').textContent }; })()`);

await S('Runtime.enable');
await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: URL });
await sleep(5000);

const checks = {};
const steps = {};
const hookLive = await ev('typeof window.__memory === "function"');
checks.hookLive = !!hookLive;
const first = await state();
steps.boot = first && { cards: first.symbols.length, flipsLeft: first.flipsLeft, webgl: await ev('!!document.querySelector("canvas")') };
checks.canvasLive = !!(steps.boot && steps.boot.webgl);

// ---- 1. a single click turns one card over (flips -1, no match yet)
const p00 = await clickCard(0, 0);
await sleep(500);
const s1 = await state();
checks.clickFlipsCard = !!(s1 && s1.flips === 1 && s1.flipsLeft === (first ? first.flipsLeft - 1 : -1) && s1.up[0] === 1);
steps.afterFirstClick = { point: p00 && { x: Math.round(p00.x), y: Math.round(p00.y) }, flips: s1.flips, flipsLeft: s1.flipsLeft, up: s1.up.slice(0, 6) };

// ---- 2. a matching pair scores
const sym = s1.symbols;
const mate = sym.findIndex((v, i) => i !== 0 && v === sym[0]);
await clickCard(Math.floor(mate / s1.cols), mate % s1.cols);
await sleep(900);
const s2 = await state();
checks.pairMatched = !!(s2 && s2.found === 1 && s2.matched[0] === 1 && s2.matched[mate] === 1);
steps.afterMatch = { found: s2.found, matched: s2.matched.filter(Boolean).length, flips: s2.flips };
const shotMatch = await shotOf('matched');

// ---- 3. a mismatching pair costs flips and turns back down
const openIdx = s2.matched.map((m, i) => (m ? -1 : i)).filter((i) => i >= 0);
let a = -1, b = -1;
for (const i of openIdx) {
  const j = openIdx.find((k) => k !== i && s2.symbols[k] !== s2.symbols[i]);
  if (j !== undefined) { a = i; b = j; break; }
}
const flipsBefore = s2.flips;
await clickCard(Math.floor(a / s2.cols), a % s2.cols);
await sleep(260);
await clickCard(Math.floor(b / s2.cols), b % s2.cols);
await sleep(1200);
const s3 = await state();
checks.mismatchCostsFlips = !!(s3 && s3.flips === flipsBefore + 2 && s3.found === 1 && s3.up.every((u, i) => !u || s3.matched[i]));
steps.afterMismatch = { flips: s3.flips, found: s3.found, faceUp: s3.up.filter(Boolean).length };

// ---- 4. clear every remaining pair through real clicks -> win sheet
let guard = 0;
const remaining = new Set();
for (let i = 0; i < s3.symbols.length; i++) if (!s3.matched[i]) remaining.add(i);
const bySym = new Map();
for (const i of remaining) {
  const k = s3.symbols[i];
  if (!bySym.has(k)) bySym.set(k, []);
  bySym.get(k).push(i);
}
for (const [, idx] of bySym) {
  if (guard++ > 40) break;
  const st = await state();
  if (st.over) break;
  for (const i of idx) {
    await clickCard(Math.floor(i / st.cols), i % st.cols);
    await sleep(420);
  }
  await sleep(700);
}
const s4 = await state();
const sheetWin = await sheet();
checks.winReached = !!(s4 && s4.won === true && s4.over === true && sheetWin.open);
checks.winSheetText = /cleared/i.test(sheetWin.title);
steps.win = { found: s4.found, pairs: s4.pairs, flips: s4.flips, sheet: sheetWin };
const shotWin = await shotOf('win');

// ---- 5. restart resets the board
await ev(`document.getElementById('new').click()`);
await sleep(900);
const s5 = await state();
checks.restartResets = !!(s5 && s5.found === 0 && s5.flips === 0 && s5.over === false && s5.flipsLeft === s5.pairs * 4);
steps.afterRestart = { found: s5.found, flips: s5.flips, flipsLeft: s5.flipsLeft, over: s5.over };

// ---- 6. the flip budget can be lost (QA setFlips + a real mismatch)
await ev('window.__memory.setFlips(2)');
const s6 = await state();
const o1 = s6.symbols[0];
const mA = 0, mB = s6.symbols.findIndex((v, i) => i > 0 && v !== o1);
await clickCard(0, 0);
await sleep(260);
await clickCard(Math.floor(mB / s6.cols), mB % s6.cols);
await sleep(1300);
const s7 = await state();
const sheetLose = await sheet();
checks.loseReached = !!(s7 && s7.over === true && s7.won === false && sheetLose.open);
checks.loseSheetText = /flips/i.test(sheetLose.title + ' ' + sheetLose.text);
steps.lose = { flipsLeft: s7.flipsLeft, over: s7.over, won: s7.won, sheet: sheetLose };
const shotLose = await shotOf('lose');

// ---- 7. portrait 390x844 touch play
await ev(`document.getElementById('new').click()`);
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
const st = await state();
const tpt = await clickCard(st.rows - 1, 0, 'touch');
await sleep(600);
const s8 = await state();
const inView = tpt && tpt.x > 0 && tpt.y > 0 && tpt.x < 390 && tpt.y < 844;
checks.touchPortrait = !!(s8 && s8.flips === 1 && s8.up[st.rows * st.cols - st.cols] === 1 && inView);
steps.touch = { point: tpt && { x: Math.round(tpt.x), y: Math.round(tpt.y) }, inView: !!inView, flips: s8.flips };
const shotTouch = await shotOf('touch');
await S('Emulation.clearDeviceMetricsOverride');

checks.consoleClean = logs.length === 0;

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ url: URL, checks, steps, consoleErrors: logs,
  shots: { match: shotMatch, win: shotWin, lose: shotLose, touch: shotTouch } }, null, 1));
console.log(ok ? 'MEMORY PLAY PASS' : 'MEMORY PLAY FAIL');
ws.close();
proc.kill('SIGKILL');
process.exit(ok ? 0 : 1);
