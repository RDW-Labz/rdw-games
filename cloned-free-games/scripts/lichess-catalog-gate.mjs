#!/usr/bin/env node
// Catalog click-and-play gate for the Lichess port: open the deployed library face, click the
// tile, prove the iframe renders a WebGL board and that a real click inside the frame moves a
// piece (state hook changes). usage: node lichess-catalog-gate.mjs <siteDir> [title]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site/stage/public');
const TITLE = process.argv[3] || 'Lichess Mobile';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = normalize(join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1440,900', '--no-first-run',
  `--user-data-dir=${mkdtempSync('/tmp/chess-cat-')}`, 'about:blank'],
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
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); setTimeout(() => { if (pending.delete(i)) bad(new Error('timeout ' + method)); }, 40000); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const ev = async (e) => {
  const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
};
const click = async (x, y) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};

await S('Runtime.enable'); await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
await sleep(4500);

const card = await ev(`(() => {
  const t = ${JSON.stringify(TITLE)}.toLowerCase();
  const nodes = [...document.querySelectorAll('button,a,li,article,div')].filter(e => (e.textContent || '').toLowerCase().includes(t));
  const hit = nodes.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { tag: hit.tagName, text: hit.textContent.trim().slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);

let opened = null;
if (card) {
  await click(card.x, card.y);
  await sleep(5500);
  opened = await ev(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { iframe: false, src: null };
    const r = f.getBoundingClientRect();
    const w = f.contentWindow;
    let hook = null, err = null;
    try { hook = w.__lichess ? w.__lichess() : null; } catch (e) { err = String(e); }
    const cv = f.contentDocument ? f.contentDocument.querySelector('canvas') : null;
    return { iframe: true, src: f.getAttribute('src'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
             canvas: !!cv, canvasSize: cv ? [cv.width, cv.height] : null, webgl: !!(cv && (cv.getContext('webgl2') || cv.getContext('webgl'))), hook, err };
  })()`);
}

// A real click on the e2 pawn inside the frame, then on e4 — the board must actually move.
let before = null, sel = null, after = null, board = null, inner = null;
if (opened && opened.iframe && opened.hook) {
  inner = await ev(`(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect();
    const a = f.contentWindow.__lichess.tilePoint(6, 4), b = f.contentWindow.__lichess.tilePoint(4, 4);
    return { a: { x: Math.round(a.x), y: Math.round(a.y) }, b: { x: Math.round(b.x), y: Math.round(b.y) }, ox: Math.round(r.x), oy: Math.round(r.y) }; })()`);
  before = opened.hook;
  await click(inner.ox + inner.a.x, inner.oy + inner.a.y);
  await sleep(500);
  sel = await ev(`document.querySelector('iframe').contentWindow.__lichess()`);
  await click(inner.ox + inner.b.x, inner.oy + inner.b.y);
  await sleep(2600);
  after = await ev(`document.querySelector('iframe').contentWindow.__lichess()`);
  board = await ev(`document.querySelector('iframe').contentWindow.__lichess.board()`);
}

const shot = await S('Page.captureScreenshot', { format: 'png' });
await mkdir('/home/cluer/cloned-free-games/.queue/playtest', { recursive: true });
const out = '/home/cluer/cloned-free-games/.queue/playtest/lichess-catalog.png';
await writeFile(out, Buffer.from(shot.data, 'base64'));

const checks = {
  tileFound: !!card,
  iframeOpened: !!(opened && opened.iframe),
  rightGame: !!(opened && opened.src && opened.src.includes('/games/arcade/lichess.html')),
  canvasLive: !!(opened && opened.canvas && opened.canvasSize && opened.canvasSize[0] > 100),
  webgl: !!(opened && opened.webgl),
  hookLive: !!(opened && opened.hook && opened.hook.pieces === 32 && opened.hook.legalAll === 20),
  selectableInFrame: !!(sel && sel.selected === 52),
  playsInFrame: !!(after && after.ply >= 1 && board && board[36] === 'P' && board[52] === '.'),
};
console.log(JSON.stringify({ checks, card, opened, inner, sel: sel && { selected: sel.selected, legalForSel: sel.legalForSel },
  after: after && { ply: after.ply, turn: after.turn, pieces: after.pieces }, board, shot: out }, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'CATALOG PASS' : 'CATALOG FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
