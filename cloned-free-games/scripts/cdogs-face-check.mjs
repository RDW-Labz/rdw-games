#!/usr/bin/env node
// Deployed-face check for the C-Dogs SDL port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library
// face in headless Chromium with SwiftShader WebGL, clicks the C-Dogs tile with a real mouse
// event, then plays the game inside the #frame iframe with real pointer presses.
//
// usage: node scripts/cdogs-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/cdogs-face-'), RUNTIME = mkdtempSync('/tmp/cdogs-frun-');
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
const ok = (c, msg, extra) => { if (!c) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); } else console.error('  ok   ' + msg); return !!c; };
const click = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.error('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face renders its tiles');

// the tile the visitor sees, by the audited card's name
const tile = await ev(`(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/C-Dogs/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.trim().replace(/\\s+/g,' ').slice(0,70)};
})()`);
ok(!!tile, 'a C-Dogs tile is on the published face', tile);
console.error('  tile:', JSON.stringify(tile));
await sleep(400);
const t2 = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/C-Dogs/i.test(e.textContent));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(t2.x, t2.y);

// the iframe the tile opened has to be the port, and it has to come up
const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('cdogs-sdl') ? f.src : ''})()", 15000);
ok(!!frameUrl, 'the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.error('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__cdogs === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
ok(!!booted, 'the port boots inside the published player iframe');
const st = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__cdogs())}catch(e){return 'X:'+e.message}})()");
console.error('  in-frame state:', st);
const s0 = st && st[0] === '{' ? JSON.parse(st) : {};
ok(s0.level === 1 && s0.hostiles >= 4 && s0.hp === 100, 'the iframe dealt a real mission 1 floor', { level: s0.level, hostiles: s0.hostiles, hp: s0.hp });
const shotFace = await (async () => {
  await mkdir(OUT, { recursive: true });
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, 'cdogs-live-face.png');
  await writeFile(f, Buffer.from(s.data, 'base64'));
  return f;
})();
console.error('  shot:', shotFace);

// a real press inside the iframe: set a one-hostile fixture, tap the hostile, let the rifle work
const setup = await ev(`(()=>{const w=document.getElementById('frame').contentWindow;return JSON.stringify(w.__cdogs.setup({player:[6,2],exit:[6,16],enemies:[[6,11,44]],hp:100}))})()`);
ok(setup && setup[0] === '{', 'the in-frame fixture takes', setup);
await sleep(300);
const pt = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const p=f.contentWindow.__cdogs.enemyPoint(0);
  return {x:Math.round(r.x+p.x), y:Math.round(r.y+p.y), w:r.width, h:r.height};})()`);
ok(pt && pt.x > 0 && pt.x < 1280 && pt.y > 0 && pt.y < 860, 'the hostile projects inside the published iframe', pt);
await click(pt.x, pt.y);
const killState = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__cdogs();return s.kills>=1?JSON.stringify(s):''})()", 45000);
ok(!!killState, 'a real press in the iframe kills the hostile', await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__cdogs()))()"));
const ks = killState ? JSON.parse(killState) : {};
console.error('  in-frame fight:', JSON.stringify({ shots: ks.shots, hits: ks.hits, kills: ks.kills, armed: ks.armed }));

// walk onto the hatch with a real press and clear the mission
const ep = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const p=f.contentWindow.__cdogs.exitPoint();
  return {x:Math.round(r.x+p.x), y:Math.round(r.y+p.y)};})()`);
await click(ep.x, ep.y);
const cleared = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__cdogs();return s.over?JSON.stringify(s):''})()", 45000);
const cs = cleared ? JSON.parse(cleared) : {};
ok(cs.result === 'clear' && cs.armed === true, 'the hatch clears the mission in the published iframe', { result: cs.result, armed: cs.armed, hp: cs.hp });
const shotPlay = await (async () => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, 'cdogs-live-play.png');
  await writeFile(f, Buffer.from(s.data, 'base64'));
  return f;
})();
console.error('  shot:', shotPlay);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logs no page errors', bad.slice(0, 3));

console.log(JSON.stringify({ pass: fails === 0, fails, tile, frame: frameUrl, bootState: s0, fight: ks, clear: cs, shots: { face: shotFace, play: shotPlay } }, null, 2));
kill(); srv.close();
process.exit(fails ? 1 : 0);
