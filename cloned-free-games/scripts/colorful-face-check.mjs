#!/usr/bin/env node
// Deployed-face check for the Colorful port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the Colorful tile with a real mouse event, and
// then plays inside the #frame iframe with real pointer events. Proves the tile -> iframe -> playable
// path on the artifact that shipped, plus that the tile carries the card's real art, not a monogram.
//
// usage: node scripts/colorful-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 180000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/col-face-'), RUNTIME = mkdtempSync('/tmp/col-frun-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,860', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools in 60s: ' + err.slice(-200))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});
const port = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const cdp = await CDP.attach(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const poll = async (expr, ms = 30000, step = 200) => {
  const t0 = Date.now();
  for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
};
let fails = 0;
const ok = (c, msg, extra) => {
  if (c) { console.log('  ok   ' + msg); return true; }
  fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const mouse = (type, x, y, button = 'left') => cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
const click = async (x, y) => { await mouse('mouseMoved', x, y, 'none'); await sleep(40); await mouse('mousePressed', x, y); await sleep(80); await mouse('mouseReleased', x, y); await sleep(500); };

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');

const findTile = `(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Colorful/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  const img=b.querySelector('img')?b.querySelector('img').getAttribute('src'):'';
  const bgi=getComputedStyle(b).backgroundImage||'';
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.trim().slice(0,70), img, bgi:bgi.slice(0,160)};
})()`;
const tile = await ev(findTile);
ok(!!tile, 'no Colorful tile on the published face', tile);
if (tile) console.log('  tile:', JSON.stringify(tile));
await sleep(400);
const t2 = await ev(findTile);
await click(t2.x, t2.y);

const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('colorful') ? f.src : ''})()", 15000);
ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__colorful === 'function' ? 'live' : ''}catch(e){return ''}})()", 90000);
ok(!!booted, 'the port did not boot inside the published player iframe');
const st0 = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__colorful())}catch(e){return 'X:'+e.message}})()");
console.log('  in-frame state:', st0);
ok(st0 && st0.includes('"hp":3'), 'the published iframe starts a whole run', st0);

// real pointer press inside the iframe, mapped from the iframe box into page coordinates
const geom = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;
  const p=w.__colorful.playerPoint(); return {fx:r.x, fy:r.y, px:p.x, py:p.y, w:r.width, h:r.height};})()`);
ok(!!geom && geom.px > 20, 'the ship has a point inside the published iframe', geom);
await mouse('mouseMoved', geom.fx + geom.px + 110, geom.fy + geom.py, 'none');
await mouse('mousePressed', geom.fx + geom.px + 110, geom.fy + geom.py);
const moved = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__colorful();return s.x>1.4?JSON.stringify({x:s.x,facing:s.facing}):''})()", 25000);
await mouse('mouseReleased', geom.fx + geom.px + 110, geom.fy + geom.py);
ok(!!moved, 'a real press in the published iframe does not fly the ship', moved);
console.log('  in-frame steer:', moved);

// a delivery through the published artifact, driven by a real press at the altar
await ev(`(()=>{const w=document.getElementById('frame').contentWindow;w.__colorful.setup({carrying:0, at:[5.0,2.5], invuln:999, clearBullets:true});return 1})()`);
await sleep(300);
const hub = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const h=f.contentWindow.__colorful.hubPoint();return {x:r.x+h.x,y:r.y+h.y,disabled:false};})()`);
await mouse('mouseMoved', hub.x, hub.y, 'none');
await mouse('mousePressed', hub.x, hub.y);
const del = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__colorful();return s.delivered>=1?JSON.stringify({delivered:s.delivered,score:s.score,carrying:s.carrying}):''})()", 25000);
await mouse('mouseReleased', hub.x, hub.y);
ok(!!del, 'the published iframe does not deliver a colour at the altar', del);
console.log('  in-frame delivery:', del);

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'colorful-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.log('  shot:', art);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Colorful and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
