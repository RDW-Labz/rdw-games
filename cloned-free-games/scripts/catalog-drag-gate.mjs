#!/usr/bin/env node
// Drag/swipe click-and-play gate for arcade ports behind the catalog face.
//
// catalog-play-gate.mjs fires pointerdown+up at ONE point, which is enough for tap games but
// cannot drive a drag port (Stone Wars deals slabs out of a tray) or a swipe port (2048's
// onDirection reads the body pointerdown→pointerup delta). This gate does the whole gesture
// inside the iframe: down at A, moves, up at B — all constructed in the frame's own window,
// because page-level CDP Input events never reach an in-process iframe here.
//
// usage:
//   node catalog-drag-gate.mjs <baseUrl> <tileTitle> <hookName> <downExpr> <upExpr> <stateExpr> <shotName>
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

const [BASE, TITLE, HOOK, DOWN_EXPR, UP_EXPR, STATE_EXPR, SHOT = 'drag'] = process.argv.slice(2);
if (!BASE || !TITLE || !HOOK || !DOWN_EXPR || !UP_EXPR || !STATE_EXPR) {
  console.error('usage: node catalog-drag-gate.mjs <baseUrl> <tileTitle> <hookName> <downExpr> <upExpr> <stateExpr> [shotName]');
  process.exit(2);
}
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/sbin/chromium'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cdg-');
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
const pend = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pend.has(msg.id)) { const { ok, bad, method } = pend.get(msg.id); pend.delete(msg.id); msg.error ? bad(new Error(method + ': ' + msg.error.message)) : ok(msg.result); }
  else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
  const i = ++id;
  pend.set(i, { ok, bad, method });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  setTimeout(() => { if (pend.delete(i)) bad(new Error('timeout ' + method)); }, 30000);
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => {
  const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
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

let opened = null, before = null, after = null, points = null;
if (card) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: card.x, y: card.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: card.x, y: card.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(6000);
  opened = await ev(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { iframe: false };
    const r = f.getBoundingClientRect();
    let hook = false, cv = false, src = f.getAttribute('src') || f.src;
    try { hook = !!f.contentWindow.${HOOK} && (typeof f.contentWindow.${HOOK} === 'function' || typeof f.contentWindow.${HOOK} === 'object'); cv = !!(f.contentDocument && f.contentDocument.querySelector('canvas')); } catch (e) {}
    return { iframe: true, src, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, hook, canvas: cv };
  })()`);
}

if (opened && opened.iframe && opened.hook) {
  const inFrame = (body) => ev(`(() => { const w = document.querySelector('iframe').contentWindow; ${body} })()`);
  before = await inFrame(`return ${STATE_EXPR};`);
  points = await inFrame(`
    const A = ${DOWN_EXPR}, B = ${UP_EXPR};
    return (A && B) ? { a: { x: Math.round(A.x), y: Math.round(A.y) }, b: { x: Math.round(B.x), y: Math.round(B.y) } } : null;`);
  if (points) {
    // Full gesture inside the frame: kit.js listens on document.body, ports listen on the canvas.
    await inFrame(`
      const mk = (t, x, y, b) => new w.PointerEvent(t, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: b });
      const cv = w.document.querySelector('canvas');
      const body = w.document.body;
      const A = ${DOWN_EXPR}, B = ${UP_EXPR};
      for (const el of [w.document.elementFromPoint(A.x, A.y) || cv, cv, body])
        if (el) el.dispatchEvent(mk('pointerdown', A.x, A.y, 1));
      for (let k = 1; k <= 5; k++) {
        const x = A.x + (B.x - A.x) * k / 5, y = A.y + (B.y - A.y) * k / 5;
        for (const el of [cv, body]) if (el) el.dispatchEvent(mk('pointermove', x, y, 1));
      }
      for (const el of [w.document.elementFromPoint(B.x, B.y) || cv, cv, body])
        if (el) el.dispatchEvent(mk('pointerup', B.x, B.y, 0));
      return true;`);
    await sleep(1500);
  }
  after = await inFrame(`return ${STATE_EXPR};`);
}

const shot = await S('Page.captureScreenshot', { format: 'png' });
mkdirSync('/home/cluer/cloned-free-games/.queue/playtest', { recursive: true });
const out = `/home/cluer/cloned-free-games/.queue/playtest/${SHOT}-catalog.png`;
writeFileSync(out, Buffer.from(shot.data, 'base64'));
const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => (e.params.exceptionDetails?.exception?.description || '').slice(0, 160)).slice(0, 3).join(' | ');
const changed = JSON.stringify(before) !== JSON.stringify(after);
const ok = !!(card && opened && opened.iframe && opened.hook && changed);
console.log(JSON.stringify({ checks: {
  tileFound: !!card, iframeOpened: !!(opened && opened.iframe), hookLive: !!(opened && opened.hook),
  canvasLive: !!(opened && opened.canvas), playsOnDrag: changed, noErrors: !errors,
}, card, opened, points, before, after, errors, shot: out }, null, 1));
console.log(ok ? 'CATALOG DRAG PASS' : 'CATALOG DRAG FAIL');
ws.close();
proc.kill('SIGKILL');
process.exit(ok ? 0 : 1);
