#!/usr/bin/env node
// Deployed-face check for the Super Retro Mega Wars port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — the tree wrangler uploaded), opens the library
// face in headless Chromium, clicks the tile with a real mouse event, then fires a real click at a
// rock inside the #frame iframe and asserts the in-frame score moved. Proves tile → iframe → play on
// the artifact that shipped, not just the source tree.
// usage: node srmw-face-check.mjs [published-dir]
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) console.log('ok   ' + msg);
  else { fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); console.log('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); }
  return !!cond;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/srmw-face-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1400,900', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageCdp = await CDP.attach(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const poll = async (expr, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await ev(expr); if (v) return v; await sleep(250); }
  return null;
};
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the published library face rendered its tiles');

const tile = await ev(`(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Super Retro Mega Wars/i.test(e.textContent));
  if(!b) return null;
  b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect(); const img=b.querySelector('img');
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.replace(/\\s+/g,' ').trim().slice(0,80), img:img&&img.getAttribute('src')};
})()`);
ok(!!tile, 'the Super Retro Mega Wars tile is on the published face', tile);
console.log('  tile:', JSON.stringify(tile));
await sleep(600);
const tapPt = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/Super Retro Mega Wars/i.test(e.textContent));if(!b)return null;const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
ok(!!tapPt && tapPt.y > 40 && tapPt.y < 880, 'the tile scrolls into the viewport before the click', tapPt);
const art = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/Super Retro Mega Wars/i.test(e.textContent));
  const img=b.querySelector('img'); const bg=getComputedStyle(b).backgroundImage;
  const kids=[...b.querySelectorAll('*')].map(e=>getComputedStyle(e).backgroundImage).join(' ');
  return {img:img&&img.getAttribute('src'), bg, kids: /super-retro-mega-wars/.test(kids)};})()`);
ok(!!art && (/super-retro-mega-wars\.png/.test(art.img || '') || /super-retro-mega-wars/.test(art.bg || '') || art.kids), 'the tile carries the gate screenshot as its art', art);

await click(tapPt);
const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('super-retro-mega-wars') ? f.src : ''})()", 15000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__srmw === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
ok(!!booted, 'the port boots inside the published player iframe');
const st0 = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__srmw())}catch(e){return 'X:'+e.message}})()");
console.log('  in-frame state:', String(st0).slice(0, 260));

// rig a guaranteed shot inside the published frame, then fire with a real click at the rock
await ev(`(()=>{const w=document.getElementById('frame').contentWindow;
  return w.__srmw.setup({mode:'asteroids', seed:7, t:0, dur:60, you:0, cpu:0, invuln:[9,9], cool:[0,9], shipX:0,
    rocks:[{x:0, z:-2.0, vx:0, vz:0.5, r:0.8}]});})()`);
await sleep(400);
const geom = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();
  const p=f.contentWindow.__srmw.rockPoint(0);return p?{x:r.x+p.x, y:r.y+p.y, w:r.width, h:r.height}:null;})()`);
ok(!!geom && !geom.__err, 'the in-frame rock projects into page space', geom);
if (geom && !geom.__err) await click(geom);
const scored = await poll("(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__srmw();return s&&s.you>0?JSON.stringify(s):''})()", 8000);
ok(!!scored, 'a real click inside the published iframe fires and scores', scored);
console.log('  in-frame after click:', String(scored).slice(0, 220));

const shot = await S('Page.captureScreenshot', { format: 'png' });
await mkdir(OUT, { recursive: true });
const out = join(OUT, 'srmw-live-face.png');
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('  shot:', out);

const errors = pageCdp.events.filter((e) => (e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon\.ico/.test(e.params.entry.url || ''))));
ok(errors.length === 0, 'console errors on the published face', errors.map((e) => JSON.stringify(e.params).slice(0, 200)));

proc.kill('SIGKILL');
srv.close();
if (fails.length) { console.log(`\nFAIL: ${fails.length} face assertion(s)`); process.exit(1); }
console.log('\nPASS — the published face opens Super Retro Mega Wars and it plays in the player iframe');
