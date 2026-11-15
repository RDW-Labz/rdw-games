#!/usr/bin/env node
// Click-and-play gate for the deployed library face: open the catalog, click the tile, prove the
// iframe game renders and starts on a real click. usage: node catalog-gate.mjs <siteDir> <title> <slug>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const [siteDir, title, slug] = process.argv.slice(2);
const ROOT = resolve(siteDir);
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
  `--user-data-dir=${mkdtempSync('/tmp/cat-chr-')}`, 'about:blank'],
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

await S('Runtime.enable'); await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/catalog/` });
await sleep(4000);

const card = await ev(`(() => {
  const t = ${JSON.stringify(title)}.toLowerCase();
  const nodes = [...document.querySelectorAll('button,a,li,article,div')].filter(e => (e.textContent||'').toLowerCase().includes(t));
  const hit = nodes.sort((a,b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { tag: hit.tagName, text: hit.textContent.trim().slice(0, 60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);

let opened = null;
if (card) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: card.x, y: card.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: card.x, y: card.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(5000);
  opened = await ev(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { iframe: false };
    let hook = null, err = null;
    try { hook = f.contentWindow.${'__'}brick ? f.contentWindow.${'__'}brick() : null; } catch (e) { err = String(e); }
    const r = f.getBoundingClientRect();
    const cv = f.contentDocument ? f.contentDocument.querySelector('canvas') : null;
    return { iframe: true, src: f.getAttribute('src'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
             canvas: !!cv, canvasSize: cv ? [cv.width, cv.height] : null, hook, err };
  })()`);
}

let played = null;
if (opened && opened.iframe && opened.hook) {
  const r = opened.rect;
  const px = Math.round(r.x + r.w / 2), py = Math.round(r.y + r.h * 0.72);
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(4000);
  played = await ev(`(() => { const f = document.querySelector('iframe'); return f.contentWindow.__brick(); })()`);
}

const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = `/home/cluer/cloned-free-games/.queue/playtest/${slug}-catalog.png`;
await writeFile(out, Buffer.from(shot.data, 'base64'));

const checks = {
  tileFound: !!card,
  iframeOpened: !!(opened && opened.iframe),
  canvasLive: !!(opened && opened.canvas && opened.canvasSize && opened.canvasSize[0] > 100),
  hookLive: !!(opened && opened.hook && opened.hook.bricksAlive === 35),
  playsOnClick: !!(played && (played.score > 0 || played.launched === true) && played.bricksAlive < 35),
};
console.log(JSON.stringify({ checks, card, opened, played, shot: out }, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'CATALOG PASS' : 'CATALOG FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
