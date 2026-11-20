#!/usr/bin/env node
// Catalog gate for the One Line port: click the built library tile, prove it opens the port in the
// iframe, then drag a real stroke inside the frame and read the port's own hook.
// usage: node oneline-catalog-gate.mjs [stageRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site/stage/public');
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.headersSent ? res.end() : res.writeHead(404).end('404'); }
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

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
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/oneline-cat-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,900', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-200))));
});
const list = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
const cdp = await CDP.attach(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
  return r.result?.value;
};
await S('Runtime.enable'); await S('Page.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: base + '/index.html' });
await sleep(4500);

const checks = {};
// 1. the tile exists on the face and scrolls into view before measuring
const tile = await ev(`(() => {
  const tiles = [...document.querySelectorAll('button.tile')];
  const t = tiles.find((b) => /one.?line/i.test((b.querySelector('.nm') || {}).textContent || ''));
  if (!t) return { found: false, names: tiles.map((b) => (b.querySelector('.nm') || {}).textContent).slice(0, 90) };
  t.scrollIntoView({ block: 'center' });
  const r = t.getBoundingClientRect();
  return { found: true, name: (t.querySelector('.nm') || {}).textContent, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
checks.tileFound = !!(tile && tile.found);
T('tile ' + JSON.stringify(tile).slice(0, 160));

if (tile && tile.found) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await S('Input.dispatchMouseEvent', { type, x: tile.x, y: tile.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  }
  await sleep(3500);
}
// 2. an iframe opened on the port
const frame = await ev(`(() => { const f = document.querySelector('iframe'); if (!f) return null;
  const r = f.getBoundingClientRect(); return { src: f.getAttribute('src'), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
checks.iframeOpened = !!(frame && frame.src && /one-line-puzzle/.test(frame.src) && frame.w > 100);
T('frame ' + JSON.stringify(frame));

// 3. the port is live inside the frame (hook is a function) and a real drag changes its state
const pre = await ev(`(() => { const w = document.querySelector('iframe').contentWindow; return typeof w.__oneline === 'function' ? w.__oneline() : null; })()`);
checks.hookInFrame = !!(pre && pre.filled === 0 && pre.cells === 25);
const dragState = await ev(`(() => {
  const w = document.querySelector('iframe').contentWindow, d = w.document, cv = d.querySelector('canvas');
  if (!cv) return { __err: 'no canvas in frame' };
  const sol = w.__oneline.solution().slice(0, 14);
  const pt = (r, c) => w.__oneline.tilePoint(r, c);
  const mk = (t, x, y, b) => new w.PointerEvent(t, { pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true,
    cancelable: true, clientX: x, clientY: y, button: 0, buttons: b });
  const a = pt(sol[0][0], sol[0][1]);
  const targets = [...new Set([d.elementFromPoint(a.x, a.y), cv])].filter(Boolean);
  targets.forEach((el) => el.dispatchEvent(mk('pointerdown', a.x, a.y, 1)));
  for (let i = 1; i < sol.length; i++) { const p = pt(sol[i][0], sol[i][1]); cv.dispatchEvent(mk('pointermove', p.x, p.y, 1)); }
  const z = pt(sol[sol.length - 1][0], sol[sol.length - 1][1]);
  [...new Set([d.elementFromPoint(z.x, z.y), d.body])].filter(Boolean).forEach((el) => el.dispatchEvent(mk('pointerup', z.x, z.y, 0)));
  return w.__oneline();
})()`);
checks.playsInFrame = !!(dragState && dragState.filled >= 10 && dragState.over === false);
T('drag ' + JSON.stringify(dragState).slice(0, 200));

const s = await S('Page.captureScreenshot', { format: 'png' });
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/oneline-catalog.png`, Buffer.from(s.data, 'base64'));

const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => (e.params.exceptionDetails?.exception?.description || '').slice(0, 200)).slice(0, 4);
checks.noErrors = errors.length === 0;

console.log(JSON.stringify({ checks, tile, frame, pre, dragState, errors, shot: `${OUT}/oneline-catalog.png` }, null, 1));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'ONELINE CATALOG GATE PASS' : 'ONELINE CATALOG GATE FAIL');
cdp.ws.close(); proc.kill('SIGKILL'); server.close();
process.exit(ok ? 0 : 1);
