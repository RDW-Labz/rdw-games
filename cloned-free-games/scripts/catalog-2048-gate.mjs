#!/usr/bin/env node
// Catalog gate for the 2048 port: click the library tile, then dispatch a REAL in-iframe drag
// and assert window.__arcade.state() changed (tiles/score), plus the win sheet on a 1024 merge.
// usage: node catalog-2048-gate.mjs <siteRoot> [tileTitleSubstring]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site/stage/public');
const TILE = process.argv[3] || '2048 (Privacy Friendly)';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      let f = normalize(join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const st = await stat(f).catch(() => null);
      if (st && st.isDirectory()) f = join(f, 'index.html');
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
const PROFILE = mkdtempSync('/tmp/gcat2-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,900', '--no-first-run',
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
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` });
await sleep(5000);
const errorsOf = () => cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || '').filter(Boolean).slice(0, 3).join(' | ');
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

const F = `[...document.querySelectorAll('iframe')].find(e=>e.offsetParent||e.getClientRects().length)`;
const tile = await ev(`(() => {
  const t = ${JSON.stringify(TILE)}.toLowerCase();
  const cards = [...document.querySelectorAll('button.tile, .tile')].filter((e) => e.getClientRects().length);
  const hit = cards.find((e) => (e.querySelector('.nm') || e).textContent.toLowerCase().includes(t));
  if (!hit) return { found: false, titles: cards.map(c => (c.querySelector('.nm')||c).textContent.trim()).slice(0, 30) };
  const r = hit.getBoundingClientRect();
  return { found: true, title: (hit.querySelector('.nm') || hit).textContent.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
if (tile.found) {
  const { x, y } = tile;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
}
await sleep(5500);

const frame = await ev(`(() => {
  const f = ${F}; if (!f) return { ok: false, why: 'no visible iframe' };
  let w; try { w = f.contentWindow; } catch (e) { return { ok: false, why: 'cross-origin' }; }
  const c = w.document.querySelector('canvas');
  return { ok: !!(w && w.__arcade), src: f.getAttribute('src') || '', canvas: !!c, size: c && { w: c.width, h: c.height },
    state: w.__arcade ? w.__arcade.state() : null };
})()`);

// real in-frame drag: press on the canvas, move horizontally, release
const dragFrame = async (dx) => ev(`(() => {
  const f = ${F}, w = f.contentWindow, doc = f.contentDocument;
  const canvas = doc.querySelector('canvas');
  const r = canvas.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mk = (type, x, y, buttons) => new w.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: buttons ? 0 : -1, buttons });
  canvas.dispatchEvent(mk('pointerdown', cx, cy, 1));
  for (let i = 1; i <= 6; i++) canvas.dispatchEvent(mk('pointermove', cx + (${dx} * i) / 6, cy, 1));
  w.dispatchEvent(mk('pointerup', cx + ${dx}, cy, 0));
  doc.body.dispatchEvent(mk('pointerup', cx + ${dx}, cy, 0));
  return { ok: true };
})()`);

// swipe until the grid changes (a swipe into a wall is a legal no-op, so try both ways)
let swiped = null;
const before = frame.state && JSON.stringify(frame.state.grid);
for (const dx of [-420, 420, -420, 420]) {
  await dragFrame(dx); await sleep(350);
  const now = await ev(`(() => { const f=${F}; return f.contentWindow.__arcade.state(); })()`);
  if (JSON.stringify(now.grid) !== before) { swiped = now; break; }
}

// prove the win sheet through the real board: 1024 + 1024 -> merge to 2048
await ev(`(() => { const f=${F}; f.contentWindow.__arcade.config ? 0 : 0; return f.contentWindow.__arcade.setup([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 0); })()`);
await sleep(400);
await dragFrame(-420);
await sleep(600);
const end = await ev(`(() => { const f=${F}, w=f.contentWindow, d=f.contentDocument;
  return { state: w.__arcade.state(), sheet: { open: d.getElementById('over').classList.contains('open'), title: d.getElementById('overTitle').textContent } }; })()`);
const shotWin = await shot('catalog-2048-tile-win');
const errors = errorsOf();

const checks = {
  tileFound: !!tile.found,
  iframeOpened: !!frame && frame.ok === true && /games\/arcade\/(2048|flow)/.test(frame.src || ''),
  canvasRendered: !!frame && frame.canvas === true && frame.size && frame.size.w > 100,
  booted: !!(frame.state && frame.state.tiles === 2 && frame.state.over === false),
  swipeMoves: !!swiped && swiped.tiles >= 3,
  winSheet: !!(end && end.state.won === true && end.sheet.open === true && /2048/.test(end.sheet.title)),
  noErrors: !errors,
};
console.log(JSON.stringify({ checks, errors, tile, frame: frame && { src: frame.src, canvas: frame.canvas, size: frame.size, tiles: frame.state && frame.state.tiles },
  afterSwipe: swiped && { tiles: swiped.tiles, score: swiped.score, grid: swiped.grid },
  end: end && { won: end.state.won, over: end.state.over, grid: end.state.grid, sheet: end.sheet },
  shots: [shotWin] }, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'CATALOG GATE PASS' : 'CATALOG GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
