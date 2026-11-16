#!/usr/bin/env node
// Catalog gate for a same-origin arcade port: click the library tile, then drive a REAL drag
// inside the resulting iframe (PointerEvents built inside the frame document) and assert the
// game's own state hook changed. A blank/blocked iframe cannot pass this.
// usage: node catalog-flow-gate.mjs <siteRoot> [tileTitleSubstring] [shotPrefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site');
const TILE = process.argv[3] || 'Flow';
const PREFIX = process.argv[4] || 'catalog-flow';
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
const PROFILE = mkdtempSync('/tmp/gcat-');
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
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || '')
  .filter(Boolean).slice(0, 4).join(' | ');
const urlsOf = () => cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.url || '').filter(Boolean).slice(0, 6);

const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// 1) find and click the catalog tile by its visible title
const tile = await ev(`(() => {
  const t = ${JSON.stringify(TILE)}.toLowerCase();
  const cards = [...document.querySelectorAll('button.tile, .tile')].filter((e) => e.getClientRects().length);
  const hit = cards.find((e) => (e.querySelector('.nm') || e).textContent.toLowerCase().includes(t));
  if (!hit) return { found: false, count: cards.length };
  const r = hit.getBoundingClientRect();
  return { found: true, title: (hit.querySelector('.nm') || hit).textContent.trim().slice(0, 60), tag: hit.tagName,
           x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

const clickAt = async (x, y) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
if (tile.found) await clickAt(tile.x, tile.y);
await sleep(5000);

// 2) the tile must have opened a same-origin iframe whose game actually booted
const frame = await ev(`(() => {
  const f = [...document.querySelectorAll('iframe')].find((e) => e.offsetParent || e.getClientRects().length);
  if (!f) return { ok: false, why: 'no visible iframe' };
  let w; try { w = f.contentWindow; } catch (e) { return { ok: false, why: 'cross-origin frame' }; }
  const src = f.getAttribute('src') || '';
  const has = !!(w && w.__flow);
  let canvas = null, size = null;
  try { canvas = w.document.querySelector('canvas'); } catch (e) {}
  if (canvas) size = { w: canvas.width, h: canvas.height };
  return { ok: has, src, hasHook: has, canvas: !!canvas, size,
           bodyText: (w.document.body.innerText || '').trim().slice(0, 120) };
})()`);

// 3) real drags inside the frame, built on the frame's own coordinate map
const dragFrame = async (cells) => ev(`(() => {
  const f = [...document.querySelectorAll('iframe')].find((e) => e.offsetParent || e.getClientRects().length);
  const w = f.contentWindow, doc = f.contentDocument;
  const canvas = doc.querySelector('canvas');
  const P = cells => cells;
  const cells = P(${JSON.stringify(cells)});
  const mk = (type, x, y, buttons) => new w.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: buttons ? 0 : -1, buttons });
  const first = w.__flow.tilePoint(cells[0][0], cells[0][1]);
  canvas.dispatchEvent(mk('pointerdown', first.x, first.y, 1));
  for (const [r, c] of cells.slice(1)) {
    const p = w.__flow.tilePoint(r, c);
    canvas.dispatchEvent(mk('pointermove', p.x, p.y, 1));
  }
  const last = w.__flow.tilePoint(cells[cells.length - 1][0], cells[cells.length - 1][1]);
  w.dispatchEvent(mk('pointerup', last.x, last.y, 0));
  return { ok: true, n: cells.length };
})()`);

const sol = await ev(`(() => {
  const f = [...document.querySelectorAll('iframe')].find((e) => e.offsetParent || e.getClientRects().length);
  const w = f && f.contentWindow;
  if (!w || !w.__flow || !w.__flow.solution) return null;
  return { before: w.__flow(), solution: w.__flow.solution() };
})()`);

let afterOne = null, afterAll = null, sheet = null;
if (sol && sol.solution) {
  await dragFrame(sol.solution[0]);
  await sleep(400);
  afterOne = await ev(`(() => { const f=[...document.querySelectorAll('iframe')].find(e=>e.offsetParent||e.getClientRects().length); return f.contentWindow.__flow(); })()`);
  for (const path of sol.solution.slice(1)) { await dragFrame(path); await sleep(300); }
  await sleep(600);
  afterAll = await ev(`(() => { const f=[...document.querySelectorAll('iframe')].find(e=>e.offsetParent||e.getClientRects().length);
    const w=f.contentWindow, d=f.contentDocument; return { state: w.__flow(),
      sheet: { open: d.getElementById('over').classList.contains('open'), title: d.getElementById('overTitle').textContent },
      canvas: !!d.querySelector('canvas') }; })()`);
}
const shotWin = await shot(`${PREFIX}-tile-win`);
const errors = errorsOf();

const checks = {
  tileFound: !!tile.found,
  iframeOpened: !!frame && frame.ok === true && /games\/arcade\//.test(frame.src || ''),
  canvasRendered: !!frame && frame.canvas === true && frame.size && frame.size.w > 100,
  booted: !!(sol && sol.before && sol.before.n > 0 && sol.before.pairs.length > 0),
  dragInFrame: !!(afterOne && afterOne.pairs[0].connected === true),
  wonInFrame: !!(afterAll && afterAll.state.won === true && afterAll.state.filled === afterAll.state.cells &&
    afterAll.sheet.open === true && /flowed/i.test(afterAll.sheet.title)),
  noErrors: !errors,
};
console.log(JSON.stringify({ checks, errors, urls: urlsOf(), tile, frame, sol: sol && { n: sol.before.n, pairs: sol.before.pairs.length, moves: sol.before.moves },
  afterOne: afterOne && { connected: afterOne.connected, moves: afterOne.moves, pair0: afterOne.pairs[0] },
  afterAll: afterAll && { won: afterAll.state.won, filled: afterAll.state.filled, cells: afterAll.state.cells, sheet: afterAll.sheet },
  shots: [shotWin] }, null, 1));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'CATALOG GATE PASS' : 'CATALOG GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(pass ? 0 : 1);
