#!/usr/bin/env node
// Deployed-face check for the Wesnoth port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, proves the tile carries the real in-game screenshot, clicks
// the tile with a real mouse event, and then plays the game inside the #frame iframe with real pointer
// events: lift a unit, march it, and open a recruit. Proves tile -> iframe -> playable on the artifact
// that shipped, not just on the source tree.
//
// usage: node scripts/wesnoth-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/wes-face-'), RUNTIME = mkdtempSync('/tmp/wes-frun-');
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
  fails++;
  console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const click = async (x, y, wait = 400) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(wait);
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');

const tileSel = `[...document.querySelectorAll('button.tile')].find(e=>/Battle for Wesnoth/i.test(e.textContent))`;
const tileArt = await ev(`(()=>{const b=${tileSel}; if(!b) return null;
  const art=b.querySelector('.art');
  return { has: !!art, img: art ? (art.style.backgroundImage||'') : '', shot: art ? art.classList.contains('shot') : false,
           text: b.textContent.replace(/\\s+/g,' ').trim().slice(0,80) };})()`);
ok(!!tileArt, 'no "The Battle for Wesnoth" tile on the published face', tileArt);
console.log('  tile:', JSON.stringify(tileArt));
ok(tileArt && /art\/wesnoth\.png/.test(tileArt.img), 'the tile carries the real in-game screenshot, not a monogram plate', tileArt && tileArt.img.slice(0, 120));
ok(tileArt && tileArt.shot === true, 'the tile is marked as a screenshot (class "shot")', tileArt && tileArt.shot);

const t2 = await ev(`(()=>{const b=${tileSel}; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()`);
await sleep(400);
const t3 = await ev(`(()=>{const b=${tileSel}; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()`);
await click(t3.x || t2.x, t3.y || t2.y, 600);

const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('wesnoth') ? f.src : ''})()", 20000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__wesnoth === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
ok(!!booted, 'the port boots inside the published player iframe');
const st = await ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__wesnoth())}catch(e){return 'X:'+e.message}})()");
console.log('  in-frame state:', st);
const H0 = st && st[0] === '{' ? JSON.parse(st) : {};
ok(H0.army && H0.army[0] === 3 && H0.army[1] === 3, 'the published port opens a live 3-v-3 battle', H0.army);
ok(H0.turn === 0 && H0.over === false, 'the published port is waiting for the visitor', { turn: H0.turn, over: H0.over });

// a real click chain inside the published iframe: lift a unit, march it
const geo = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;
  const s=w.__wesnoth.state(); const u=s.units.find(x=>x.side===0&&x.kind==='spearman');
  const rc=w.__wesnoth.reach(u.id).sort((a,b)=>b.cost-a.cost)[0];
  return {fx:r.x, fy:r.y, u:{q:u.q,r:u.r,id:u.id}, dest:{q:rc.q,r:rc.r,cost:rc.cost}};})()`);
ok(geo && geo.u, 'found the visitor spearman inside the published frame', geo);
const pt = async (q, r) => ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();
  const p=f.contentWindow.__wesnoth.hexPoint(${q},${r}); return p?{x:r.x+p.x,y:r.y+p.y}:null;})()`);
const p1 = await pt(geo.u.q, geo.u.r);
await click(p1.x, p1.y, 450);
const hLift = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__wesnoth()))()"));
ok(hLift.sel === geo.u.id, 'a real click in the published iframe lifts the unit', { sel: hLift.sel, want: geo.u.id });
const p2 = await pt(geo.dest.q, geo.dest.r);
await click(p2.x, p2.y, 600);
const hMove = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__wesnoth()))()"));
const movedU = hMove.units.find((u) => u.id === geo.u.id);
ok(movedU && movedU.q === geo.dest.q && movedU.r === geo.dest.r, 'a real click in the published iframe marches it',
  { want: geo.dest, got: movedU && [movedU.q, movedU.r] });

// the recruit button inside the frame (a DOM click, mapped through the iframe box)
const rb = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();
  const b=f.contentDocument.getElementById('r-bowman'); const br=b.getBoundingClientRect();
  return {x:Math.round(r.x+br.x+br.width/2), y:Math.round(r.y+br.y+br.height/2), disabled:!!b.disabled};})()`);
ok(rb && rb.disabled === false, 'the in-frame recruit button is live', rb);
await click(rb.x, rb.y, 600);
const hRec = JSON.parse(await ev("(()=>JSON.stringify(document.getElementById('frame').contentWindow.__wesnoth()))()"));
ok(hRec.army[0] === hMove.army[0] + 1, 'the in-frame recruit joins the published battle', { before: hMove.army[0], after: hRec.army[0] });

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'wesnoth-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.log('  shot:', art);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Wesnoth and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
