#!/usr/bin/env node
// Deployed-face check for the Asteroid's Revenge port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — the tree wrangler uploaded), opens the library
// face in headless Chromium, clicks the tile with a real mouse event, then drags inside the
// #frame iframe and asserts the in-frame asteroid moved and a ram killed. Proves
// tile -> iframe -> play on the artifact that shipped, not just the source tree.
// usage: node revenge-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const NAME = /Asteroid'?s\s+Revenge/i;
const SLUG = 'asteroid-s-revenge';

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 90000);
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
const PROFILE = mkdtempSync('/tmp/revenge-face-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1400,900', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 60000);
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
const mouse = async (type, x, y) => S('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, pointerType: 'mouse' });
const click = async (pt) => { await mouse('mouseMoved', pt.x, pt.y); await mouse('mousePressed', pt.x, pt.y); await mouse('mouseReleased', pt.x, pt.y); };
const drag = async (pt) => { await mouse('mouseMoved', pt.x, pt.y); await mouse('mousePressed', pt.x, pt.y); await sleep(120); await mouse('mouseReleased', pt.x, pt.y); };

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 90000)), 'the published library face rendered its tiles');

const findTile = `(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>${NAME}.test(e.textContent));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`;
const tilePt = await ev(findTile);
ok(!!tilePt, "the Asteroid's Revenge tile is on the published face", tilePt);
await sleep(700);
const art = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>${NAME}.test(e.textContent));if(!b)return null;
  const img=b.querySelector('img'); const bg=getComputedStyle(b).backgroundImage;
  const kids=[...b.querySelectorAll('*')].map(e=>getComputedStyle(e).backgroundImage).join(' ');
  const all = (bg || '') + ' ' + kids;
  return {text:b.textContent.replace(/\\s+/g,' ').trim().slice(0,90), img:img&&img.getAttribute('src'), bg:bg.slice(0,120),
          shot: /Asteroid-s-Revenge\\.png/i.test(all), all: all.slice(0,160)};})()`);
ok(!!art && (art.shot || /Asteroid-s-Revenge\.png/i.test(art.img || '')),
  'the tile carries the gate screenshot as its art', art);
console.log('  tile:', JSON.stringify(art));

const pt = await ev(findTile);
ok(!!pt && pt.y > 40 && pt.y < 880, 'the tile scrolls into the viewport before the click', pt);
await click(pt);
const frameUrl = await poll(`(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('${SLUG}') ? f.src : ''})()`, 20000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const hookIn = "(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__revenge === 'function' ? 'live' : ''}catch(e){return ''}})()";
ok(!!(await poll(hookIn, 90000)), 'the port boots inside the published player iframe');
const st0 = await ev("(()=>{try{return document.getElementById('frame').contentWindow.__revenge()}catch(e){return {__err:e.message}}})()");
ok(!!st0 && !st0.__err && st0.hull === 100 && st0.over === false, 'the in-frame run boots at full hull', st0 && { hull: st0.hull, wave: st0.wave, over: st0.over });
console.log('  in-frame state:', JSON.stringify(st0 && { t: st0.t, wave: st0.wave, hull: st0.hull, ships: st0.ships, field: st0.field }));

// real drag inside the published iframe: steer, then ram a rigged hull
const inFrame = (expr) => `(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;return (${expr})(w,r);})()`;
await ev(inFrame(`(w)=>w.__revenge.setup({hold:true,noQueue:true,x:0,y:-2})`));
await sleep(300);
const pLp = await ev(inFrame(`(w,r)=>{const p=w.__revenge.pointAt(-3.4,-2);return {x:r.x+p.x,y:r.y+p.y};}`));
ok(!!pLp && !pLp.__err, 'a world point inside the frame projects into page space', pLp);
if (pLp && !pLp.__err) await drag(pLp);
const steered = await poll(inFrame(`(w)=>w.__revenge().x < -1.2 ? w.__revenge().x : 0`), 20000);
ok(!!steered, 'a real mouse drag inside the published iframe steers the asteroid', steered);

await ev(inFrame(`(w)=>w.__revenge.setup({hold:true,noQueue:true,x:0,y:-2,ships:[{type:'scout',x:0,y:0.3}]})`));
await sleep(350);
const shipP = await ev(inFrame(`(w,r)=>{const p=w.__revenge.shipPoint(0);return p?{x:r.x+p.x,y:r.y+p.y}:null;}`));
if (shipP && !shipP.__err) await drag(shipP);
const killed = await poll(inFrame(`(w)=>{const s=w.__revenge();return s.kills>=1?JSON.stringify({kills:s.kills,score:s.score,hull:s.hull}):''}`), 26000);
ok(!!killed, 'a real drag inside the published iframe rams a hull and scores', killed);
console.log('  in-frame after ram:', String(killed).slice(0, 200));

const shot = await S('Page.captureScreenshot', { format: 'png' });
await mkdir(OUT, { recursive: true });
const out = join(OUT, 'revenge-live-face.png');
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('  shot:', out);

const errors = pageCdp.events.filter((e) => (e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon\.ico/.test(e.params.entry.url || ''))));
ok(errors.length === 0, 'console errors on the published face', errors.map((e) => JSON.stringify(e.params).slice(0, 200)));

proc.kill('SIGKILL');
srv.close();
if (fails.length) { console.log(`\nFAIL: ${fails.length} face assertion(s)`); process.exit(1); }
console.log("\nPASS — the published face opens Asteroid's Revenge and it plays in the player iframe");
