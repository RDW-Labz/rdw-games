#!/usr/bin/env node
// Deployed-face check for the Flicky Bee port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face
// in headless Chromium with SwiftShader WebGL, clicks the Flicky Bee tile with a real mouse event,
// then plays the game inside the #frame iframe with real pointer events: two flicks up the meadow,
// asserted through the port's own state hook. Proves tile -> iframe -> playable on the shipped
// artifact, not just in the source tree.
//
// usage: node scripts/flicky-bee-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/fb-face-'), RUNTIME = mkdtempSync('/tmp/fb-frun-');
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
const ok = (c, msg, extra) => { if (!c) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); } return !!c; };
const click = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(350);
};
const IN = "document.getElementById('frame').contentWindow";
const tileAt = `(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Flicky\\s*Bee/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.replace(/\\s+/g,' ').trim().slice(0,70)};
})()`;

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');

const tile = await ev(tileAt);
ok(!!tile, 'no Flicky Bee tile on the published face', tile);
console.log('  tile:', JSON.stringify(tile));
await sleep(400);
const t2 = await ev(tileAt);
if (t2) await click(t2.x, t2.y);

const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('flicky-bee') ? f.src : ''})()", 20000);
ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll(`(()=>{try{const w=${IN};return typeof w.__flicky === 'function' ? 'live' : ''}catch(e){return ''}})()`, 60000);
ok(!!booted, 'the port did not boot inside the published player iframe');
const s0 = await ev(`(()=>{try{return JSON.stringify(${IN}.__flicky())}catch(e){return 'X:'+e.message}})()`);
console.log('  in-frame state:', (s0 || '').slice(0, 240));
const st0 = JSON.parse(s0 || '{}');
ok(st0.idx === 0 && st0.course && st0.course.length === 25 && Array.isArray(st0.targets) && st0.targets.length === 2,
  'the port booted but its meadow is not the shipped one', { idx: st0.idx, targets: st0.targets });

// flick up two rungs with real mouse clicks inside the published iframe
const flickInFrame = async (label) => {
  const geom = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=${IN};
    const s=w.__flicky(); const p=w.__flicky.point(s.targets[0]);
    return {x:Math.round(r.x+p.x), y:Math.round(r.y+p.y), target:s.targets[0], idx:s.idx, fx:r.width, fy:r.height};})()`);
  ok(!!geom, label + ': could not map a bloom into page coordinates');
  if (!geom) return null;
  await click(geom.x, geom.y);
  const landed = await poll(`(()=>{const w=${IN};const s=w.__flicky();return (s.idx===${geom.target} && !s.inFlight) ? JSON.stringify(s) : ''})()`, 12000, 150);
  console.log('  ' + label + ':', JSON.stringify({ from: geom.idx, to: landed ? JSON.parse(landed).idx : null, target: geom.target, pt: { x: geom.x, y: geom.y } }));
  return landed ? JSON.parse(landed) : null;
};
const first = await flickInFrame('flick 1');
ok(!!first && first.idx === 2 && first.depth === 1 && first.honey >= 13 && first.visited[2] === true,
  'a real click inside the published iframe did not flick the bee onto the first bloom', first && { idx: first.idx, honey: first.honey, depth: first.depth });
const second = await flickInFrame('flick 2');
ok(!!second && second.depth === 2 && second.honey > (first ? first.honey : 0) && second.flights === 2,
  'a second real click inside the published iframe did not carry the bee up another rung', second && { idx: second.idx, depth: second.depth, honey: second.honey, flights: second.flights });

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'flicky-bee-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.log('  shot:', art);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Flicky Bee and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
