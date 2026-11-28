#!/usr/bin/env node
// Deployed-face check for the Werewolves port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — the tree wrangler uploaded), opens the library
// face in headless Chromium with SwiftShader WebGL, clicks the Werewolves tile with a real mouse
// event, then plays inside the #frame iframe with real mouse events. Proves the tile -> iframe ->
// playable path on the artifact that shipped, not just on the source tree.
//
// usage: node scripts/werewolves-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/wolf-face-'), RUNTIME = mkdtempSync('/tmp/wolf-frun-');
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
const tileOf = `(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/werewol/i.test(e.textContent));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:b.textContent.trim().slice(0,80)};})()`;
const tile = await poll(tileOf, 45000, 500);
ok(!!tile, 'the published face carries a Werewolves tile', tile);
console.error('  tiles: ' + await ev("[...document.querySelectorAll('button.tile')].length"));
console.error('  tile: ' + JSON.stringify(tile));
await sleep(500);
const t2 = await ev(tileOf);
await click(t2.x, t2.y);

const frameUrl = await poll("(()=>{const f=document.getElementById('frame');return f && f.src && /werewolves/.test(f.src) ? f.src : ''})()", 15000);
ok(!!frameUrl, 'clicking the tile points the player iframe at the port', await ev("document.getElementById('frame')?.src"));
console.error('  frame: ' + frameUrl);
const booted = await poll("(()=>{try{const w=document.getElementById('frame').contentWindow;return typeof w.__werewolves === 'function' ? 'live' : ''}catch(e){return ''}})()", 90000);
ok(!!booted, 'the port boots inside the published player iframe');
const frameState = () => ev("(()=>{try{return JSON.stringify(document.getElementById('frame').contentWindow.__werewolves())}catch(e){return 'X:'+e.message}})()");
const st0 = JSON.parse(await frameState());
console.error('  in-frame state: ' + JSON.stringify({ phase: st0.phase, night: st0.night, alive: st0.alive, role: st0.role }));
ok(st0.phase === 'night' && st0.night === 1, 'the published iframe opens on night one', st0 && { p: st0.phase, n: st0.night });
ok(st0.alive === 9, 'the published iframe deals a full nine-seat table', st0.alive);
ok(st0.role !== 'wolf', 'the visitor is on the village side in the published build');

// a real click on a control inside the iframe (map iframe box + element box into page coords)
const clickInFrame = async (expr, wait = 400) => {
  const pos = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const e=${expr};if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(r.x+b.x+b.width/2),y:Math.round(r.y+b.y+b.height/2)};})()`);
  if (!pos || pos.__err) return null;
  await click(pos.x, pos.y, wait);
  return pos;
};
const goBtn = "document.getElementById('frame').contentDocument.getElementById('go')";
const p1 = await clickInFrame(goBtn);
ok(!!p1, 'the primary button is reachable inside the published iframe', p1);
const st1 = JSON.parse(await frameState());
ok(st1.phase === 'dawn', 'a real click inside the published iframe resolves the night', { phase: st1.phase, report: st1.report });
ok(st1.alive === 8 || /barred/i.test(st1.report || ''), 'the pack took a seat (or a lantern stopped it)', { alive: st1.alive, report: st1.report });

await clickInFrame(goBtn);
const st2 = JSON.parse(await frameState());
ok(st2.phase === 'day', 'the published iframe gathers the table', { phase: st2.phase, day: st2.day });
const victim = st2.seats.find((s) => s.alive && s.i !== 0).i;
const seat = await ev(`(()=>{const f=document.getElementById('frame');const r=f.getBoundingClientRect();const w=f.contentWindow;const p=w.__werewolves.seatPoint(${victim});
  if(!p)return null;return {x:Math.round(r.x+p.x),y:Math.round(r.y+p.y),i:${victim}};})()`);
ok(!!seat, 'the published iframe exposes a seat to point at', seat);
await click(seat.x, seat.y, 500);
const st3 = JSON.parse(await frameState());
ok(st3.phase === 'dusk' || st3.over, 'a real seat click casts the day vote in the published iframe', { phase: st3.phase });
ok(Array.isArray(st3.tally) && st3.tally.length === 9, 'the published iframe records the tally', st3.tally);
ok(st3.lastPick === victim, 'the vote lands on the seat that was tapped', { lastPick: st3.lastPick, want: victim });

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'werewolves-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.error('  shot: ' + art);
console.error('  in-frame after: ' + JSON.stringify({ phase: st3.phase, alive: st3.alive, tally: st3.tally }));

// the tile art that shipped should be a real screenshot, not a monogram plate
const artCheck = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/werewol/i.test(e.textContent));if(!b)return null;const a=b.querySelector('.art');if(!a)return null;const st=getComputedStyle(a).backgroundImage;const m=st.match(/url\\("?(.+?)"?\\)/);return {url:m?m[1].replace(location.origin,''):st.slice(0,60), shot:a.classList.contains('shot')};})()`);
ok(!!artCheck && artCheck.shot && /art\/werewol/i.test(artCheck.url || ''), 'the tile carries real art on the face', artCheck);
console.error('  tile art: ' + JSON.stringify(artCheck));

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Werewolves and it plays in the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
