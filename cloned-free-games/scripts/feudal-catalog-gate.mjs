#!/usr/bin/env node
// Catalog click-and-play gate for a hex-board port: open the library face, scroll the tile into
// the viewport, click it, prove the iframe opened the right port with a live WebGL canvas, then
// send a real mouse click to a hex inside the frame and require the port's own state hook to move.
// usage: node feudal-catalog-gate.mjs <siteDir> [title] [slug]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site/stage/public');
const TITLE = process.argv[3] || 'Feudal Tactics';
const SLUG = process.argv[4] || 'feudal-tactics';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
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
  `--user-data-dir=${mkdtempSync('/tmp/feudal-cat-')}`, 'about:blank'],
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
const fails = [];
const ok = (c, m, x) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (x === undefined ? '' : ' :: ' + JSON.stringify(x))); if (!c) fails.push(m); return c; };

await S('Runtime.enable'); await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/catalog/` });
await sleep(4000);

// find the card and bring it into the viewport before measuring
const card = await ev(`(() => {
  const t = ${JSON.stringify(TITLE)}.toLowerCase();
  const nodes = [...document.querySelectorAll('button,a,li,article,div')].filter(e => (e.textContent||'').toLowerCase().includes(t));
  const hit = nodes.sort((a,b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  return { tag: hit.tagName, text: hit.textContent.trim().slice(0, 60) };
})()`);
await sleep(900);
const pos = await ev(`(() => {
  const t = ${JSON.stringify(TITLE)}.toLowerCase();
  const nodes = [...document.querySelectorAll('button,a,li,article,div')].filter(e => (e.textContent||'').toLowerCase().includes(t));
  const hit = nodes.sort((a,b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
ok(!!card, 'the library face carries the tile', card);
ok(!!pos && pos.x > 0 && pos.y > 0 && pos.y < 900, 'the tile is inside the viewport', pos);

if (pos) {
  await click(pos.x, pos.y);
  await sleep(6000);
}
const opened = await ev(`(() => {
  const f = document.querySelector('iframe');
  if (!f) return { iframe: false };
  const r = f.getBoundingClientRect();
  let hook = null, err = null, cv = null;
  try { const w = f.contentWindow; cv = w.document.querySelector('canvas'); hook = typeof w.__feudal === 'function' ? w.__feudal() : null; } catch (e) { err = String(e); }
  return { iframe: true, src: f.getAttribute('src'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           canvas: !!cv, canvasSize: cv ? [cv.width, cv.height] : null, hook, err };
})()`);
ok(opened && opened.iframe, 'the tile opens a player frame', opened && opened.iframe);
ok(opened && opened.src && opened.src.includes(`/games/arcade/${SLUG}`), 'the frame points at the port folder', opened && opened.src);
ok(opened && opened.canvas && opened.canvasSize && opened.canvasSize[0] > 100, 'the frame runs a live WebGL canvas', opened && opened.canvasSize);
ok(opened && opened.hook && opened.hook.mine === 5 && opened.hook.turn === 0, 'the port boots inside the frame', opened && opened.hook);

// a real click on a hex inside the frame must move the port's own state
let played = null, hexPoint = null;
if (opened && opened.hook) {
  const r = opened.rect;
  const local = await ev(`(() => {
    const f = document.querySelector('iframe');
    const w = f.contentWindow;
    const st = w.__feudal.state();
    const mine = st.tiles.filter(t => t.owner === 0 && t.s > 0 && !t.acted);
    if (!mine.length) return null;
    const p = w.__feudal.tilePoint(mine[0].q, mine[0].r);
    return p ? { x: Math.round(p.x), y: Math.round(p.y), tile: [mine[0].q, mine[0].r] } : null;
  })()`);
  hexPoint = local;
  if (local) {
    await click(r.x + local.x, r.y + local.y);
    await sleep(1500);
    played = await ev(`(() => { const w = document.querySelector('iframe').contentWindow; const h = w.__feudal(); return { held: h.held, inputs: h.inputs, mine: h.mine, turn: h.turn }; })()`);
  }
}
ok(!!hexPoint, 'the frame exposes a hex screen point', hexPoint);
ok(!!played && !!played.held && played.held.s > 0, 'a real click inside the frame lifts a troop (state hook moved)', played);

const shot = await S('Page.captureScreenshot', { format: 'png' });
await mkdir(OUT, { recursive: true });
const out = join(OUT, `${SLUG}-live.png`);
await writeFile(out, Buffer.from(shot.data, 'base64'));
const consoleErrs = events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
ok(consoleErrs === 0, 'no uncaught exceptions in the catalog run', consoleErrs);

console.log(JSON.stringify({ card, pos, opened, hexPoint, played, shot: out }, null, 1));
proc.kill('SIGKILL'); server.close();
if (fails.length) { console.log(`\nFEUDAL CATALOG GATE FAILED (${fails.length})`); process.exit(1); }
console.log('FEUDAL CATALOG GATE PASS');
