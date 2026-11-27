#!/usr/bin/env node
// Deployed-face check for the SuperTuxKart port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the SuperTuxKart tile with a real mouse event, then
// steers inside the #frame iframe with a real arrow-key press and asserts the kart moved across the
// ribbon and the race clock advanced. Proves tile -> iframe -> playable on the artifact that shipped.
//
// usage: node scripts/supertuxkart-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 120000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/stk-face-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,860', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
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
  fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return false;
};
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
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face rendered its tiles');

const findTile = `(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/SuperTuxKart/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  const art=b.querySelector('.art');
  const bg=(art && (art.style.backgroundImage||getComputedStyle(art).backgroundImage))||'';
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.trim().slice(0,80), bg:bg.slice(0,200)};
})()`;
const tile = await ev(findTile);
ok(!!tile, 'no SuperTuxKart tile on the published face', tile);
if (tile) {
  console.log('  tile:', JSON.stringify(tile));
  ok(/supertuxkart\.png/i.test(tile.bg), 'the tile carries the captured in-game art, not a monogram plate', { bg: tile.bg });
  await sleep(400);
  const t2 = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/SuperTuxKart/i.test(e.textContent));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(t2.x, t2.y);

  const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('supertuxkart') ? f.src : ''})()", 20000);
  ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev("document.getElementById('frame')?.src"));
  console.log('  frame:', frameUrl);

  const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__stk === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
  ok(!!booted, 'the port did not boot inside the published player iframe');
  const st = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__stk())}catch(e){return 'X:'+e.message}})()");
  console.log('  in-frame state:', st);
  ok(st && st[0] === '{' && JSON.parse(st).laps === 3, 'the in-frame port reports a three-lap race', st);

  // real arrow-key steering inside the published iframe (focus the frame first: CDP input is
  // routed by focus, and a fresh iframe has none)
  const before = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__stk()))()"));
  const geom = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const b=f.contentWindow.__stk.bands();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+(b.top+b.bottom)/2)};})()`);
  await click(geom.x, geom.y);
  await ev("(()=>{try{document.getElementById('frame').contentWindow.focus()}catch(e){};return 1})()");
  await sleep(200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(600);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(200);
  const after = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__stk()))()"));
  console.log('  in-frame steer:', JSON.stringify({ lat0: before.lat, lat1: after.lat, t0: before.t, t1: after.t, steer: after.steer }));
  ok(after.lat > before.lat, 'a real arrow-key press inside the published iframe moves the kart', { before: before.lat, after: after.lat });
  ok(after.t > before.t, 'the race clock advances inside the iframe', { before: before.t, after: after.t });

  await mkdir(OUT, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const art = join(OUT, 'supertuxkart-live-face.png');
  await writeFile(art, Buffer.from(shot.data, 'base64'));
  console.log('  shot:', art);
}

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens SuperTuxKart and it races in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
