#!/usr/bin/env node
// Deployed-face check for the Principia port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the Principia tile with a real mouse event, and
// then plays the game inside the #frame iframe with real pointer events. Proves the tile → iframe →
// playable path on the artifact that shipped, not just on the source tree.
//
// usage: node scripts/principia-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const SOLS = JSON.parse(await readFile('/home/cluer/cloned-free-games/.queue/principia-solutions.json', 'utf8')).solutions;
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
const PROFILE = mkdtempSync('/tmp/pp-face-'), RUNTIME = mkdtempSync('/tmp/pp-frun-');
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
  await sleep(400);
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');

// the tile the visitor sees, by the audited card's name
const tile = await ev(`(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Principia/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.trim().slice(0,60)};
})()`);
ok(!!tile, 'no Principia tile on the published face', tile);
console.log('  tile:', JSON.stringify(tile));
await sleep(400);
const t2 = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/Principia/i.test(e.textContent));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(t2.x, t2.y);

// the iframe the tile opened has to be the port, and it has to come up
const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('principia') ? f.src : ''})()", 15000);
ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__principia === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
ok(!!booted, 'the port did not boot inside the published player iframe');
const st = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__principia())}catch(e){return 'X:'+e.message}})()");
console.log('  in-frame state:', st);

// a real drag on the beam knob, mapped from the iframe's box into page coordinates
const geom = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;
  const k=w.__principia.leverPoint(0); return {fx:r.x, fy:r.y, kx:k.x, ky:k.y, w:r.width, h:r.height};})()`);
const angle0 = JSON.parse(st).angles[0];
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom.fx + geom.kx, y: geom.fy + geom.ky, button: 'none' });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geom.fx + geom.kx, y: geom.fy + geom.ky, button: 'left', clickCount: 1 });
for (const t of [0.25, 0.6, 1]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geom.fx + geom.kx - 40 * t, y: geom.fy + geom.ky + 150 * t, button: 'left' });
  await sleep(80);
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geom.fx + geom.kx - 40, y: geom.fy + geom.ky + 150, button: 'left', clickCount: 1 });
await sleep(300);
const after = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__principia()))()"));
console.log('  drag in frame:', angle0, '->', after.angles[0]);
ok(after.drags >= 1 && Math.abs(after.angles[0] - angle0) > 10, 'a real drag inside the published iframe does not tip the beam', { before: angle0, after: after.angles[0], drags: after.drags });

// play a proven build through the port's own Run button with a real click
await ev(`(document.getElementById('frame').contentWindow.__principia.setup({level:1, angles:[${SOLS[1].join(',')}]}), 1)`);
await sleep(300);
const rb = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const b=f.contentDocument.getElementById('run').getBoundingClientRect();
  return {x:Math.round(r.x+b.x+b.width/2), y:Math.round(r.y+b.y+b.height/2), disabled:f.contentDocument.getElementById('run').disabled};})()`);
ok(rb && rb.disabled === false, 'the in-frame Run button is disabled on a loadable build', rb);
await click(rb.x, rb.y);
const win = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__principia();return s.over?JSON.stringify(s):''})()", 25000);
ok(!!win, 'the proven build never finished inside the published iframe');
const w = win ? JSON.parse(win) : {};
console.log('  in-frame run:', JSON.stringify({ result: w.result, cause: w.cause, t: w.t, ball: w.ball, sheet: w.sheet }));
ok(w.result === 'win' && w.cause === 'pit', 'the published iframe did not land the marble in the pit', w);
await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'principia-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.log('  shot:', art);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Principia and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
