#!/usr/bin/env node
// Deployed-face check for the Destination Sol port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — the tree wrangler uploaded), opens the library
// face in headless Chromium, clicks the tile with a real mouse event, then plays inside the #frame
// iframe: cuts a rock with a held mouse button and sells the hold at the pad. Proves
// tile -> iframe -> play on the artifact that shipped, not just the source tree.
// usage: node destinationsol-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const NAME = /Destination\s+Sol/i;
const SLUG = 'destination-sol';
const ART = /destination-sol\.png/i;

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
const PROFILE = mkdtempSync('/tmp/destsol-face-');
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

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 90000)), 'the published library face rendered its tiles');

const findTile = `(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>${NAME}.test(e.textContent));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`;
const tilePt = await ev(findTile);
ok(!!tilePt, 'the Destination Sol tile is on the published face', tilePt);
await sleep(700);
const art = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>${NAME}.test(e.textContent));if(!b)return null;
  const img=b.querySelector('img'); const bg=getComputedStyle(b).backgroundImage;
  const kids=[...b.querySelectorAll('*')].map(e=>getComputedStyle(e).backgroundImage).join(' ');
  const all = (bg || '') + ' ' + kids;
  return {text:b.textContent.replace(/\\s+/g,' ').trim().slice(0,90), img:img&&img.getAttribute('src'), bg:bg.slice(0,120),
          shot: ${ART}.test(all), all: all.slice(0,160), live: !/queued|quarantin|coming/i.test(b.textContent)};})()`);
ok(!!art && (art.shot || ART.test(art.img || '')), 'the tile carries the gate screenshot as its art', art);
ok(!!art && art.live, 'the tile reads as playable, not queued', art && art.text);
console.log('  tile:', JSON.stringify(art));

const pt = await ev(findTile);
ok(!!pt && pt.y > 40 && pt.y < 880, 'the tile scrolls into the viewport before the click', pt);
await click(pt);
const frameUrl = await poll(`(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('${SLUG}') ? f.src : ''})()`, 20000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const hookIn = `(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__destsol === 'function' ? 'live' : ''}catch(e){return ''}})()`;
ok(!!(await poll(hookIn, 90000)), 'the port boots inside the published player iframe');
const st0 = await ev("(()=>{try{return document.getElementById('frame').contentWindow.__destsol()}catch(e){return {__err:e.message}}})()");
ok(!!st0 && !st0.__err && st0.hull === 100 && st0.over === false && st0.rocks >= 8, 'the in-frame run boots at full hull with a live belt', st0 && { hull: st0.hull, rocks: st0.rocks, wave: st0.wave, credits: st0.credits });
console.log('  in-frame state:', JSON.stringify(st0 && { t: st0.t, wave: st0.wave, hull: st0.hull, rocks: st0.rocks, field: st0.field }));

// real held mouse inside the published iframe: point at a rock, cut it, collect the ore
const inFrame = (expr) => `(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;return (${expr})(w,r);})()`;
await ev(inFrame(`(w)=>w.__destsol.setup({hold:true,noPirates:true,noRocks:true,player:{x:-4.1,z:3.2,a:-Math.PI/2},rocks:[{kind:'iron',x:-4.1,z:-1.0}]})`));
const rockP = await ev(inFrame(`(w,r)=>{const p=w.__destsol.rockPoint(0);return p?{x:r.x+p.x,y:r.y+p.y}:null;}`));
ok(!!rockP && !rockP.__err && rockP.x > 0 && rockP.y > 0, 'a rock inside the frame projects into page space', rockP);
if (rockP && !rockP.__err) {
  await mouse('mouseMoved', rockP.x, rockP.y);
  await mouse('mousePressed', rockP.x, rockP.y);
  const mined = await poll(inFrame(`(w)=>{const s=w.__destsol();return s.mined>=1?JSON.stringify({mined:s.mined,shots:s.shots,ore:s.ore}):''}`), 26000);
  await mouse('mouseReleased', rockP.x, rockP.y);
  ok(!!mined, 'a real mouse hold inside the published iframe cuts a rock', mined);
  console.log('  in-frame after mining:', String(mined).slice(0, 200));
}

// the pad pays the hold, in the published iframe
await ev(inFrame(`(w)=>w.__destsol.setup({hold:true,noPirates:true,noRocks:true,hull:62,cargo:{iron:5},player:{x:0.5,z:0.5}})`));
await ev(inFrame(`(w)=>w.__destsol.release()`));
const paid = await poll(inFrame(`(w)=>{const s=w.__destsol();return s.credits>0?JSON.stringify({credits:s.credits,sold:s.sold,hull:s.hull}):''}`), 26000);
ok(!!paid, 'the pad pays the hold inside the published iframe', paid);
console.log('  in-frame after docking:', String(paid).slice(0, 200));

await mkdir(OUT, { recursive: true });
const shot = await S('Page.captureScreenshot', { format: 'png' });
const out = join(OUT, 'destsol-face.png');
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('  shot:', out);

console.log(fails.length ? '\nFAIL — ' + fails.length + ' check(s) failed on the published face' : '\nPASS — the published face opens Destination Sol and it plays in the player iframe');
try { proc.kill('SIGKILL'); } catch {}
srv.close();
process.exit(fails.length ? 1 : 0);
