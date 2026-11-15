#!/usr/bin/env node
// Click-and-play gate for ANY arcade port behind the catalog face.
//
// Point it at a staged tree that holds `catalog/` (the built face: index.html, games.json, art/)
// and `games/` (the arcade ports), then it opens a tile, proves the iframe runs the game, and
// proves a real pointer click inside the iframe changes the port's own state hook.
//
// usage:
//   node catalog-play-gate.mjs <baseUrl> <tileTitle> <hookName> <pointExpr> <stateExpr> <shotName> [clicks] [extraPointExpr]
//     baseUrl     e.g. http://127.0.0.1:8811/catalog/
//     tileTitle   the card title to click, e.g. "Privacy Friendly Checkers"
//     hookName    the iframe's debug hook, e.g. __checkers
//     pointExpr   JS evaluated inside the iframe with `w` = the game window, returning {x,y}
//                 in iframe-local pixels, e.g. "w.__checkers.tilePoint(5,0)"
//     stateExpr   JS evaluated inside the iframe returning a JSON-able snapshot,
//                 e.g. "JSON.stringify({sel:w.__checkers().sel, moves:w.__checkers().moves})"
//     shotName    screenshot basename written to .queue/playtest/<shotName>-catalog.png
//     clicks      how many times to click pointExpr (default 2)
//     extraPointExpr  optional second click, e.g. the number pad after selecting a sudoku cell
//
// Why it dispatches DOM PointerEvents instead of CDP Input events: page-level Input.dispatchMouseEvent
// does not reach an in-process iframe in headless Chromium here (verified: the iframe recorded no
// pointerdown at all). PointerEvents constructed inside the frame and dispatched on the element under
// the point do reach the canvas and the port's handlers.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';

const [BASE, TITLE, HOOK, PT_EXPR, STATE_EXPR, SHOT = 'catalog', CLICKS = '2', EXTRA_EXPR] = process.argv.slice(2);
if (!BASE || !TITLE || !HOOK || !PT_EXPR || !STATE_EXPR) {
  console.error('usage: node catalog-play-gate.mjs <baseUrl> <tileTitle> <hookName> <pointExpr> <stateExpr> [shotName] [clicks] [extraPointExpr]');
  process.exit(2);
}
const N = +CLICKS;
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cpg-');
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
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && p.has(msg.id)) { const { ok, bad, method } = p.get(msg.id); p.delete(msg.id); msg.error ? bad(new Error(method + ': ' + msg.error.message)) : ok(msg.result); }
  else if (msg.method) events.push(msg);
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
const clickAt = async (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};

await S('Runtime.enable');
await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: BASE });
await sleep(4500);

const card = await ev(`(() => {
  const t = ${JSON.stringify(TITLE)}.toLowerCase();
  const nodes = [...document.querySelectorAll('#grid > *, article, li, figure, a, button, div')]
    .filter(e => (e.textContent || '').toLowerCase().includes(t))
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 24; });
  const hit = nodes.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  return { tag: hit.tagName, text: hit.textContent.trim().slice(0, 70), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);

let opened = null, before = null, after = null, pt = null;
if (card) {
  await clickAt(card.x, card.y);
  await sleep(6000);
  opened = await ev(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { iframe: false };
    const r = f.getBoundingClientRect();
    let hook = false, cv = false;
    try { hook = typeof f.contentWindow.${HOOK} === 'function'; cv = !!(f.contentDocument && f.contentDocument.querySelector('canvas')); } catch (e) {}
    return { iframe: true, src: f.getAttribute('src') || f.src, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, hook, canvas: cv };
  })()`);
}

if (opened && opened.iframe && opened.hook) {
  const frame = `document.querySelector('iframe').contentWindow`;
  const inFrame = (body) => ev(`(() => { const w = ${frame}; ${body} })()`);
  const fireAt = (x, y) => inFrame(`
    const p = { x: ${x}, y: ${y} };
    const cv = w.document.querySelector('canvas');
    const el = w.document.elementFromPoint(p.x, p.y) || cv;
    const mk = (t, b) => new w.PointerEvent(t, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
      bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: b });
    for (const e of [el, cv]) { if (!e) continue; e.dispatchEvent(mk('pointerdown', 1)); e.dispatchEvent(mk('pointerup', 0)); }
    if (el && el.tagName === 'BUTTON') el.click();
    return true;`);

  before = await inFrame(`return ${STATE_EXPR};`);
  pt = await inFrame(`const p = ${PT_EXPR}; const r = document.querySelector('iframe').getBoundingClientRect();
    return p ? { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y), ix: Math.round(p.x), iy: Math.round(p.y) } : null;`);
  if (pt) for (let i = 0; i < N; i++) { await fireAt(pt.ix, pt.iy); await sleep(800); }
  if (EXTRA_EXPR) {
    const p2 = await inFrame(`const p = ${EXTRA_EXPR}; return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;`);
    if (p2) { await fireAt(p2.x, p2.y); await sleep(1200); }
  }
  after = await inFrame(`return ${STATE_EXPR};`);
}

const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = `/home/cluer/cloned-free-games/.queue/playtest/${SHOT}-catalog.png`;
writeFileSync(out, Buffer.from(shot.data, 'base64'));
const changed = JSON.stringify(before) !== JSON.stringify(after);
const ok = !!(card && opened && opened.iframe && opened.hook && changed);
console.log(JSON.stringify({ checks: {
  tileFound: !!card, iframeOpened: !!(opened && opened.iframe), hookLive: !!(opened && opened.hook),
  canvasLive: !!(opened && opened.canvas), playsOnClick: changed,
}, card, opened, point: pt, before, after, shot: out }, null, 1));
console.log(ok ? 'CATALOG PLAY PASS' : 'CATALOG PLAY FAIL');
ws.close();
proc.kill('SIGKILL');
process.exit(ok ? 0 : 1);
