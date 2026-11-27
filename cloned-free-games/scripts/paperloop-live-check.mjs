#!/usr/bin/env node
// Live-face check for a published arcade tile: serves the staged deploy tree (what publish-site.sh
// uploaded), clicks the tile with a real mouse event, follows the forwarding page into the game
// folder, and asserts the in-frame state hook moves on real input.
//
// usage: node scripts/paperloop-live-check.mjs [staged-public-dir] [tile-title]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/.cache/rdw-games-publish/site/stage/public');
const TITLE = process.argv[3] || 'Paper Loop 2';
const SLUG = 'paper-loop-2';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.headersSent ? res.end() : res.writeHead(404).end('404'); }
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws attach failed')); });
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/pl2-live-');
const RUNTIME = mkdtempSync('/tmp/pl2-live-run-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1200,820', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('unhandledRejection', (e) => { console.error('REJECT ' + (e && e.message)); kill(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const port = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(target.webSocketDebuggerUrl);
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result?.value;
};
const poll = async (expr, ms = 40000, step = 150) => {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};
let fails = 0;
const ok = (c, m, x) => { if (!c) { fails++; console.error('  FAIL ' + m + (x === undefined ? '' : ' :: ' + JSON.stringify(x))); } };

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: base + '/' });
const face = await poll("document.querySelectorAll('button.tile').length > 0", 60000);
ok(!!face, 'the library face never rendered its tiles');

// the tile must be the published card, with the real shot, not a monogram
const tile = await ev(`(() => {
  const b = [...document.querySelectorAll('button.tile')].find((x) => x.innerText.toLowerCase().includes(${JSON.stringify(TITLE.toLowerCase())}));
  if (!b) return null;
  b.scrollIntoView({ block: 'center', inline: 'center' });
  const r = b.getBoundingClientRect();
  const art = b.querySelector('.art');
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: b.innerText.replace(/\\n/g, ' | '), shot: art ? getComputedStyle(art).backgroundImage : null };
})()`);
ok(!!tile, `the face has no tile for ${TITLE}`);
console.log('  tile:', JSON.stringify(tile));
ok(tile && tile.shot && /art\/.*\.png/.test(tile.shot), 'the tile has no screenshot art', tile?.shot);

// real click on the tile
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tile.x, y: tile.y, button: 'none', pointerType: 'mouse' });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tile.x, y: tile.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tile.x, y: tile.y, button: 'left', clickCount: 1, pointerType: 'mouse' });

const frame = await poll(`(() => {
  const f = [...document.querySelectorAll('iframe')].find((f) => /${SLUG}/.test(f.getAttribute('src') || ''));
  if (!f) return null;
  try { const w = f.contentWindow; return (w && typeof w.__paperloop === 'function' && w.__paperloop()) || null; } catch (e) { return null; }
})()`, 90000);
ok(!!frame, 'clicking the tile did not open a live game frame', await ev("location.href"));
if (frame) console.log('  frame:', JSON.stringify({ mode: frame.mode, share: frame.share, rivals: frame.rivals?.length, src: await ev(`[...document.querySelectorAll('iframe')][0].getAttribute('src')`) }));
ok(frame && frame.rivals && frame.rivals.length === 2, 'the frame booted without its rivals', frame?.rivals);
ok(frame && frame.share > 0, 'the frame booted without turf under the head', frame?.share);

// the frame's own URL, and it must be the folder, not the flat forwarding page
const inner = await ev(`(() => { const f=[...document.querySelectorAll('iframe')][0]; try { return f.contentWindow.location.pathname; } catch(e) { return 'x'; } })()`);
ok(inner === `/games/arcade/${SLUG}/`, 'the frame did not land on the game folder', inner);

// real pointer input inside the frame: press and hold, read the hook back
const box = await ev(`(() => { const r=[...document.querySelectorAll('iframe')][0].getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })()`);
const sx = box.x + Math.round(box.w / 2), sy = box.y + Math.round(box.h / 2);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy, button: 'none', pointerType: 'mouse' });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse' });
const playing = await poll(`(() => { const w=[...document.querySelectorAll('iframe')][0].contentWindow; const h=w.__paperloop(); return (h && h.out && h.trail >= 5) ? h : null; })()`, 40000);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse' });
ok(!!playing, 'a real press inside the live frame did not lay a ribbon', await ev(`(() => { const h=[...document.querySelectorAll('iframe')][0].contentWindow.__paperloop(); return {out:h.out, trail:h.trail, time:h.time}; })()`));
if (playing) console.log('  playing:', JSON.stringify({ out: playing.out, trail: playing.trail, heading: playing.you.heading }));

const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
await mkdir(OUT, { recursive: true });
const shot = join(OUT, 'paper-loop-2-live-face.png');
await writeFile(shot, Buffer.from(s.data, 'base64'));
console.log('  shot:', shot);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || 'exception').filter((t) => !/favicon|net::ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the page logged runtime errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} live-face assertion(s)` : '\nPASS — the published tile opens the game and it plays');
kill();
process.exit(fails ? 1 : 0);
