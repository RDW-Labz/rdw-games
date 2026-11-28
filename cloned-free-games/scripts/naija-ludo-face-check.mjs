#!/usr/bin/env node
// Deployed-face check for the Naija-Ludo port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the Naija-Ludo tile with a real mouse event, and
// then rolls and moves a token inside the #frame iframe with real pointer events. Proves the
// tile → iframe → playable path on the artifact that shipped, not just on the source tree.
//
// usage: node scripts/naija-ludo-face-check.mjs [published-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] || join(homedir(), '.cache/rdw-games-publish/site/stage/public'));
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const MISSES = [];
const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { MISSES.push(req.url); if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
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
const PROFILE = mkdtempSync('/tmp/ludo-face-'), RUNTIME = mkdtempSync('/tmp/ludo-frun-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,860', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME }, detached: true });
const kill = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } try { srv.close(); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });

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
  await sleep(420);
};

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);
await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');

// the tile the visitor sees, by the audited card's name
const tile = await ev(`(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Naija/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  const im=b.querySelector('img');
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.trim().slice(0,80), shot:im?(im.getAttribute('src')||''):'(no img)', bg:(getComputedStyle(b).backgroundImage||'').slice(0,60)};
})()`);
ok(!!tile, 'no Naija-Ludo tile on the published face', tile);
console.log('  tile:', JSON.stringify(tile));
await sleep(500);
const t2 = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/Naija/i.test(e.textContent));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await click(t2.x, t2.y);

// the iframe the tile opened has to be the port, and it has to come up
const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && f.src.includes('naija-ludo') ? f.src : ''})()", 20000);
ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.log('  frame:', frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__ludo === 'function' ? 'live' : ''}catch(e){return ''}})()", 90000);
ok(!!booted, 'the port did not boot inside the published player iframe');

const inFrame = (js) => ev(`(()=>{try{const w=document.getElementById('frame').contentWindow;const r=document.getElementById('frame').getBoundingClientRect();${js}}catch(e){return {err:String(e)}}})()`);
const s0 = await inFrame('return w.__ludo();');
ok(!!s0 && s0.phase === 'roll' && s0.turn === 0 && s0.tok.flat().every((q) => q === -1), 'the port inside the iframe did not open on a fresh board', s0 && { turn: s0.turn, phase: s0.phase, dice: s0.dice });

// roll a 6 and a 3 with a real click on the iframe's own Roll button, then tap the exit dot
const rollBtn = await inFrame("const b=w.document.getElementById('roll');const q=b.getBoundingClientRect();return {x:Math.round(r.left+q.x+q.width/2),y:Math.round(r.top+q.y+q.height/2),disabled:!!b.disabled};");
ok(!!rollBtn && rollBtn.disabled === false, 'the Roll button inside the published iframe is not live', rollBtn);
await inFrame('w.__ludo.forceDie(6,3); return 1;');
await click(rollBtn.x, rollBtn.y);
const rolled = await inFrame('return w.__ludo();');
ok(!!rolled && rolled.dice.join() === '6,3' && rolled.legal === 4, 'a real click on the published Roll button did not deal the forced 6 and 3', rolled && { dice: rolled.dice, legal: rolled.legal });
const dot = await inFrame("const p=w.__ludo.spendPoint(0);return {x:Math.round(r.left+p.x),y:Math.round(r.top+p.y)};");
await click(dot.x, dot.y);
const moved = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;const s=w.__ludo();return s.tok[0][0]===0 ? s : null}catch(e){return null}})()", 15000);
ok(!!moved && moved.tok[0][0] === 0 && moved.moves === 1, 'tapping the exit dot inside the published iframe did not bring a token out', moved && { tok0: moved.tok[0], moves: moved.moves });

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await mkdir(OUT, { recursive: true });
const shotPath = join(OUT, 'naija-ludo-live-face.png');
await writeFile(shotPath, Buffer.from(shot.data, 'base64'));

// no console errors from the port while it played
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text).filter(Boolean).slice(0, 3);
ok(errs.length === 0, 'the published page logged an error while playing', errs);

console.log(JSON.stringify({ misses: MISSES.slice(0,5), ok: fails === 0, fails, tile, frameUrl, rolled: rolled && rolled.dice, tok0: moved && moved.tok[0], shot: shotPath }, null, 1));
kill();
process.exit(fails ? 1 : 0);
