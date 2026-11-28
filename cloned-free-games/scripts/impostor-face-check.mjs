#!/usr/bin/env node
// Deployed-face check for the Impostor MX port: serves the EXACT published build
// (~/.cache/rdw-games-publish/site/stage/public — what wrangler uploaded), opens the library face in
// headless Chromium with SwiftShader WebGL, clicks the Impostor MX tile with a real mouse event, and
// then plays the round inside the #frame iframe with real pointer events: deal from the setup panel,
// peek a private card, call the debate, cast every vote, reach a verdict.
//
// usage: node scripts/impostor-face-check.mjs [published-dir]
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
const PROFILE = mkdtempSync('/tmp/im-face-'), RUNTIME = mkdtempSync('/tmp/im-frun-');
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
const ok = (c, msg, extra) => { if (!c) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))); } return !!c; };
const click = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(420);
};
const FRAME = "document.getElementById('frame')";
const FHOOK = `(()=>{try{const w=${FRAME}.contentWindow;return w.__impostor?JSON.stringify(w.__impostor()):''}catch(e){return ''}})()`;
const frameState = async () => { const s = await ev(FHOOK); return s ? JSON.parse(s) : null; };

await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
console.log('face root:', ROOT);

// the legacy flat URL still forwards to the folder build, inside the published tree
const fwd = await (await fetch(base + '/games/arcade/impostor-mx.html')).text();
ok(/location\.replace\("impostor-mx\/"/.test(fwd) && /rel="canonical" href="impostor-mx\/"/.test(fwd),
  'the flat /games/arcade/impostor-mx.html route does not forward to the folder build');
const portSrc = await (await fetch(base + '/games/arcade/impostor-mx/index.html')).text();
ok(/three@0\.169\.0/.test(portSrc) && /__impostor/.test(portSrc), 'the published port is not the 0.169.0 CDN build with the debug hook');

await cdp.send('Page.navigate', { url: base + '/' });
ok(!!(await poll("document.querySelectorAll('button.tile').length > 0", 60000)), 'the library face never rendered its tiles');
await sleep(1200);

// the tile the visitor sees, by the audited card's name
const tile = await ev(`(()=>{
  const b=[...document.querySelectorAll('button.tile')].find(e=>/Impostor\\s*MX/i.test(e.textContent));
  if(!b) return null; b.scrollIntoView({block:'center'});
  const r=b.getBoundingClientRect();
  return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:b.textContent.replace(/\\s+/g,' ').trim().slice(0,70)};
})()`);
ok(!!tile, 'no Impostor MX tile on the published face', await ev(`[...document.querySelectorAll('button.tile')].length`));
console.log('  tile:', JSON.stringify(tile));
if (tile) {
  await sleep(300);
  const t2 = await ev(`(()=>{const b=[...document.querySelectorAll('button.tile')].find(e=>/Impostor\\s*MX/i.test(e.textContent));const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(t2.x, t2.y);
}

const frameUrl = await poll(`(()=>{const f=${FRAME};return f && f.src && f.src.includes('impostor-mx') ? f.src : ''})()`, 15000);
ok(!!frameUrl, 'clicking the tile did not point the player iframe at the port', await ev(`${FRAME}?.src`));
console.log('  frame:', frameUrl);
const booted = await poll(FHOOK, 60000);
ok(!!booted, 'the port did not boot inside the published player iframe');
const st0 = await frameState();
console.log('  in-frame state:', JSON.stringify({ phase: st0?.phase, cards: st0?.cards, players: st0?.players }));
ok(st0 && st0.phase === 'lobby' && st0.cards >= 3, 'the in-frame port did not come up on its setup panel', st0?.phase);

// a real click on the in-frame DEAL button, mapped from the iframe box into page coordinates
const rect = await ev(`(()=>{const r=${FRAME}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
console.log('  frame rect:', JSON.stringify(rect));
const inFrame = async (expr) => (await ev(`(()=>{const w=${FRAME}.contentWindow;return (${expr});})()`));
const clickInFrame = async (x, y) => { await click(rect.x + x, rect.y + y); };
async function centreInFrame(sel) {
  return inFrame(`(()=>{const el=w.document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
}

const deal = await centreInFrame('#deal');
ok(!!deal, 'the in-frame setup panel has no visible Deal button', deal);
if (deal) await clickInFrame(deal.x, deal.y);
const dealt = await poll(`${FHOOK}`, 8000).then(frameState);
ok(dealt && dealt.phase === 'reveal' && dealt.seat === 0 && dealt.impostors.length === 1,
  'a real click on the published Deal button did not deal a table', dealt && { phase: dealt.phase, seat: dealt.seat });

// peek seat 0 by clicking its card in the iframe
const cp = await inFrame(`(()=>{const p=w.__impostor.cardPoint(w.__impostor().seat);return p?{x:Math.round(p.x),y:Math.round(p.y)}:null;})()`);
ok(!!cp, 'no card position for the active seat inside the iframe', cp);
if (cp) await clickInFrame(cp.x, cp.y);
const peeked = await poll(`(()=>{const s=${FHOOK};if(!s)return '';const j=JSON.parse(s);return j.flipped?JSON.stringify(j):''})()`, 8000).then((s) => (s ? JSON.parse(s) : null));
ok(!!peeked && peeked.face !== 'back', 'a real click on the in-frame card did not reveal the private word', peeked && { face: peeked.face });
console.log('  peeked:', JSON.stringify({ seat: peeked?.seat, face: peeked?.face, word: peeked?.word }));

// hand the phone on: flip every remaining seat, then call the debate
for (let i = 0; i < (dealt?.players || 5); i++) {
  const s = await frameState();
  if (!s || s.phase !== 'reveal') break;
  const p = await inFrame(`(()=>{const p=w.__impostor.cardPoint(w.__impostor().seat);return p?{x:Math.round(p.x),y:Math.round(p.y)}:null;})()`);
  if (!p) break;
  if (!s.flipped) await clickInFrame(p.x, p.y);
  await sleep(180);
  const s2 = await frameState();
  if (s2 && s2.flipped) {
    const p2 = await inFrame(`(()=>{const q=w.__impostor.cardPoint(w.__impostor().seat);return q?{x:Math.round(q.x),y:Math.round(q.y)}:null;})()`);
    if (p2) await clickInFrame(p2.x, p2.y);
    await sleep(180);
  }
}
const debate = await frameState();
ok(debate && debate.phase === 'debate' && debate.seen.length === debate.players, 'the published table never reached the debate', debate && { phase: debate.phase, seen: debate.seen });

const voteBtn = await centreInFrame('#vote');
ok(!!voteBtn, 'no visible Call the vote button in the published debate', voteBtn);
if (voteBtn) await clickInFrame(voteBtn.x, voteBtn.y);
const voting = await poll(`(()=>{const s=${FHOOK};if(!s)return '';const j=JSON.parse(s);return j.phase==='vote'?JSON.stringify(j):''})()`, 8000).then((s) => (s ? JSON.parse(s) : null));
ok(!!voting && voting.seat === 0, 'a real click did not open the published vote', voting && voting.phase);

// cast every ballot with a real click on the target card
let guard = 0;
while (guard++ < 20) {
  const s = await frameState();
  if (!s || s.phase !== 'vote') break;
  const target = s.impostors.includes(s.seat) ? [...Array(s.players).keys()].find((i) => i !== s.seat && !s.impostors.includes(i)) : s.impostors[0];
  const p = await inFrame(`(()=>{const p=w.__impostor.cardPoint(${target});return p?{x:Math.round(p.x),y:Math.round(p.y)}:null;})()`);
  if (!p) break;
  await clickInFrame(p.x, p.y);
  await sleep(220);
}
const verdict = await poll(`(()=>{const s=${FHOOK};if(!s)return '';const j=JSON.parse(s);return j.phase==='result'?JSON.stringify(j):''})()`, 10000).then((s) => (s ? JSON.parse(s) : null));
ok(!!verdict && verdict.result === 'crew' && verdict.ejected === verdict.impostors[0],
  'the published round did not reach a crew verdict', verdict && { result: verdict.result, ejected: verdict.ejected, imp: verdict.impostors });
console.log('  verdict in frame:', JSON.stringify({ result: verdict?.result, why: verdict?.why, ejected: verdict?.ejected, tally: verdict?.tally }));

await mkdir(OUT, { recursive: true });
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
const art = join(OUT, 'impostor-live-face.png');
await writeFile(art, Buffer.from(shot.data, 'base64'));
console.log('  shot:', art);

const bad = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.method === 'Runtime.exceptionThrown'
    ? (e.params.exceptionDetails.exception?.description || 'exception')
    : `${e.params.entry.text} <${e.params.entry.url || ''}>`)
  .filter((t) => !/favicon|ERR_ABORTED/i.test(t));
ok(bad.length === 0, 'the published face logged errors', bad.slice(0, 3));

console.log(fails ? `\nFAIL: ${fails} face assertion(s)` : '\nPASS — the published face opens Impostor MX and a full round plays inside the player iframe');
kill(); srv.close();
process.exit(fails ? 1 : 0);
