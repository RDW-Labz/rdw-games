#!/usr/bin/env node
// Deployed-face check for the Quadplay · HexFlipper port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the Quadplay tile with a real mouse event, and
// then plays the game inside the #frame iframe with real mouse events. Proves the tile → iframe →
// playable path on the artifact that shipped, not just on the source tree.
//
// usage: node scripts/quadplay-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/qp-face-'), RUNTIME = mkdtempSync('/tmp/qp-frun-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,860', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
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
const click = async (x, y, wait = 350) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(wait);
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.error('face root: ' + ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face rendered its tiles');

// the tile the visitor sees, by the audited card's name
const tileOf = `(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/quadplay/i.test(e.textContent));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:b.textContent.trim().slice(0,60)};})()`;
const tile = await ev(tileOf);
ok(!!tile, 'the published face carries a Quadplay tile', tile);
console.error('  tile: ' + JSON.stringify(tile));
await sleep(500);
const t2 = await ev(tileOf);
await click(t2.x, t2.y);

const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && /quadplay/.test(f.src) ? f.src : ''})()", 15000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.error('  frame: ' + frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__quadplay === 'function' ? 'live' : ''}catch(e){return ''}})()", 60000);
ok(!!booted, 'the port boots inside the published player iframe');
const frameState = () => ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__quadplay())}catch(e){return 'X:'+e.message}})()");
const st0 = JSON.parse(await frameState());
console.error('  in-frame state: ' + JSON.stringify({ you: st0.you, cpu: st0.cpu, neutral: st0.neutral, turn: st0.turn, arrows: st0.arrows }));
ok(st0.you === 1 && st0.cpu === 1 && st0.neutral === 59, 'the published iframe opens a fresh 1/1/59 comb', st0);
ok(st0.turn === 0 && st0.over === false, 'the published iframe is live on the visitor\'s turn');

// a real click on a hex you hold, twice (aim, then fire), mapped from the iframe box into page coords
const aimAt = async () => ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;
  const i=w.__quadplay.bestShot(); const p=w.__quadplay.tilePoint(i);
  return {x:Math.round(r.x+p.x), y:Math.round(r.y+p.y), i, fx:r.x, fy:r.y};})()`);
const a1 = await aimAt();
ok(a1 && a1.i >= 0, 'the published iframe exposes a firing hex', a1);
await click(a1.x, a1.y, 300);
const aimed = JSON.parse(await frameState());
ok(aimed.cursor === a1.i, 'a real click inside the published iframe aims from that hex', { cursor: aimed.cursor, want: a1.i });
await click(a1.x, a1.y, 400);
const fired = JSON.parse(await frameState());
ok(fired.plies >= 1, 'a second real click fires inside the published iframe', fired.plies);
const replied = await poll(`(()=>{const w=document.getElementById('frame').contentWindow;const s=w.__quadplay();return (s.plies>=${aimed.plies + 2}||s.over) && !s.cpuBusy ? 'y':'':''})()`, 25000);
const after = JSON.parse(await frameState());
ok(!!replied, 'the cpu answers inside the published iframe', { plies: after.plies, turn: after.turn, busy: after.cpuBusy });
ok(after.you + after.cpu + after.neutral === 61, 'the comb still carries 61 hexes after the shots', [after.you, after.cpu, after.neutral]);
ok(after.hud.you === String(after.you) && after.hud.cpu === String(after.cpu), 'the published HUD follows the board', after.hud);

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'quadplay-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.error('  shot: ' + art);
console.error('  in-frame after: ' + JSON.stringify({ result: after.result, plies: after.plies, you: after.you, cpu: after.cpu }));

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Quadplay and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
