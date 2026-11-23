#!/usr/bin/env node
// Interaction gate for the Cards With Cats port. Real CDP mouse clicks and a portrait touch pass:
// the picker round-trip on every hand card, the pass-three flow, playing a legal card and the bots
// answering, an illegal card refused, the double-tap guard, both terminal sheets (win + loss) driven
// through a real one-trick QA position, the Oh Hell bid bar and its own terminal round, restart,
// the mode cycle, and a 390x844 layout check.
// usage: node cards-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/cards-with-cats/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(await readFile(f));
    } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
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
  if (cond) { T('ok   ' + msg); return true; }
  fails.push(msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  T('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/cats-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  if (!pt || pt.__err || typeof pt.x !== 'number' || !isFinite(pt.x)) throw new Error('bad point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__cats()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const handPt = (i) => ev(`window.__cats.handPoint(${i})`);
const btnPt = (id) => ev(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width)}})()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
// poll a predicate over the hook until it is true
const until = async (fn, ms = 9000, step = 180) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};
const myTurn = () => until(async () => { const s = await state(); return s.phase === 'play' && s.toMove === 0 && s.hand.length ? s : null; }, 12000);

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__cats');
ok(hookType === 'function', 'debug hook is a function on the shipped page', hookType);
let s = await state();
if (s.__err) { T('STATE ERROR ' + s.__err); }
ok(s && s.hand.length === 13, 'boot: 13 cards in hand', s && s.hand && s.hand.length);
ok(s && s.counts.join() === '13,13,13,13', 'boot: all four seats dealt', s && s.counts);
ok(s && (s.phase === 'pass' || s.phase === 'play'), 'boot: match opens in a pass or play phase', s && s.phase);
const band = await ev('window.__cats.band()');
ok(band && band.lo > band.hi, 'HUD bands measured', band);

// the picker must resolve every hand card back to itself
const rt = await ev(`(()=>{const n=window.__cats().hand.length;const bad=[];for(let i=0;i<n;i++){const p=window.__cats.handPoint(i);const k=window.__cats.pick(p.x,p.y);if(k!==i)bad.push([i,k]);}return {n,bad};})()`);
ok(rt && rt.bad.length === 0, 'the hand picker resolves every card back to its own index', rt && rt.bad);

const cw = await ev(`(()=>{const c=document.querySelector('canvas');return c? c.width+'x'+c.height : null})()`);
ok(!!cw, 'a WebGL canvas is on the page', cw);
await shot('cards-boot');

// ---------- 2) double-tap guard (pass phase) ----------
// a fixed seed whose first deal is a pass hand, so the guard is measured on the pass selection
s = await ev(`window.__cats.setup({mode:'hearts', seed:11})`);
ok(s.phase === 'pass', 'the pass phase is reachable from a fixed deal', s.phase);
const dupRes = await ev(`(()=>{const p=window.__cats.handPoint(0);
  const t=(type)=>new PointerEvent(type,{clientX:p.x,clientY:p.y,bubbles:true,pointerId:1,pointerType:'mouse',isPrimary:true});
  const t0=performance.now();
  document.body.dispatchEvent(t('pointerdown'));document.body.dispatchEvent(t('pointerup'));
  document.body.dispatchEvent(t('pointerdown'));document.body.dispatchEvent(t('pointerup'));
  return Object.assign(window.__cats(), {p, gap: Math.round(performance.now()-t0)});})()`);
ok(dupRes && dupRes.dups >= 1, 'a same-point double pointerup is dropped as a duplicate', dupRes && { dups: dupRes.dups, taps: dupRes.taps, blocked: dupRes.blocked, sel: dupRes.sel.length, gap: dupRes.gap });
ok(dupRes && dupRes.sel.length === 1, 'the first tap selected exactly one card, the duplicate did not toggle it off', dupRes && { sel: dupRes.sel, taps: dupRes.taps, gap: dupRes.gap });

// ---------- 3) pass three ----------
s = await state();
if (s.phase === 'pass') {
  let guard = 0;
  while (s.sel.length < 3 && guard++ < 14) {
    const idx = s.handIds.findIndex((c) => !s.sel.includes(c));
    await click(await handPt(Math.max(0, idx)));
    await sleep(150);
    s = await state();
  }
  ok(s.sel.length === 3, 'three cards selected for the pass', { sel: s.sel, taps: s.taps, blocked: s.blocked });
  const pp = await btnPt('passBtn');
  await click(pp);
  await sleep(300);
  s = await state();
  ok(s.phase === 'play', 'the Pass 3 button commits the pass and starts play', s.phase);
  ok(s.counts.join() === '13,13,13,13', 'every seat still holds 13 after the pass', s.counts);
  ok(s.sel.length === 0, 'the selection clears on the pass', s.sel);
} else {
  T('skip pass flow (this deal opens on hold)');
}

// ---------- 4) play a legal card, bots answer ----------
let turn = await myTurn();
ok(!!turn, 'the turn comes to the visitor', turn && { phase: turn.phase, toMove: turn.toMove });
if (turn) {
  const legalIdx = turn.hand.findIndex((nm) => turn.legal.includes(nm));
  ok(legalIdx >= 0, 'the hook lists at least one legal card', turn.legal);
  const before = turn.counts[0];
  await click(await handPt(legalIdx));
  await sleep(250);
  s = await state();
  ok(s.counts[0] === before - 1, 'a tap on a legal card takes it out of the hand', { before, after: s.counts[0] });
  ok(s.trick.length >= 1, 'the card landed on the table', s.trick);
  // the bots answer on a wall clock, so poll for the trick to close
  const closed = await until(async () => { const x = await state(); return (x.trickNo > turn.trickNo || x.trick.length === 0 || x.phase === 'between') ? x : null; }, 12000);
  ok(!!closed, 'the two rivals answer and the trick resolves', closed && { trickNo: closed.trickNo, counts: closed.counts });
  await shot('cards-play');
}

// ---------- 5) an illegal card is refused ----------
turn = await myTurn();
if (turn) {
  const badIdx = turn.hand.findIndex((nm) => !turn.legal.includes(nm));
  if (badIdx >= 0) {
    const before = turn.counts[0];
    await click(await handPt(badIdx));
    await sleep(250);
    s = await state();
    ok(s.counts[0] === before, 'a card that does not follow suit is refused', { before, after: s.counts[0] });
    ok(s.illegal >= 1, 'the refusal is counted', s.illegal);
  } else T('skip illegal check: every card is legal in this position');
}

// ---------- 6) terminal sheet: win ----------
s = await ev(`window.__cats.setup({mode:'hearts', scores:[5,52,40,38], oneCardLeft:true})`);
ok(s && s.hand.length === 1 && s.phase === 'play', 'QA position: one trick left with a rival already over the target', s && { hand: s.hand.length, phase: s.phase, scores: s.scores });
await click(await handPt(0));
let sh = await until(async () => { const x = await sheet(); return x.open ? x : null; }, 12000);
ok(!!sh, 'the last trick ends the match and the end sheet opens', sh);
ok(sh && /lowest score/i.test(sh.title), 'the win sheet names the result', sh && sh.title);
s = await state();
ok(s.result === 'win', 'the match is recorded as a win for the visitor', s.result);
await shot('cards-win');

// ---------- 7) terminal sheet: loss ----------
s = await ev(`window.__cats.setup({mode:'hearts', scores:[55,10,40,38], oneCardLeft:true})`);
await click(await handPt(0));
sh = await until(async () => { const x = await sheet(); return x.open ? x : null; }, 12000);
ok(!!sh, 'a rival winning opens the end sheet too', sh);
s = await state();
ok(s.result === 'lose', 'the match is recorded as a loss', s.result);

// ---------- 8) Oh Hell: bid bar + terminal round ----------
// a fresh Oh Hell match (not a QA position) so the bidding phase is genuinely live
s = await ev(`window.__cats.mode('ohhell')`);
ok(s.mode === 'ohhell' && s.trump, 'Oh Hell deals with a trump suit', s && { trump: s.trump, phase: s.phase });
ok(s.phase === 'bid', 'Oh Hell opens on a bidding phase', s.phase);
let bidBtn = null;
for (let t = 0; t < 40 && !bidBtn; t++) {
  bidBtn = await ev('window.__cats.bidPoint(1)');
  if (!bidBtn) { await sleep(300); }
}
ok(!!bidBtn, 'the bid bar offers a button when it is the visitor\'s turn to bid', bidBtn);
if (bidBtn) {
  await click(bidBtn);
  await sleep(250);
  s = await state();
  ok(s.bids[0] === 1, 'tapping a bid button records that bid', s && s.bids);
}
s = await ev(`window.__cats.setup({mode:'ohhell', round:5, scores:[0,0,0,0], oneCardLeft:true})`);
ok(s && s.hand.length === 1 && s.phase === 'play', 'QA position: the last round of Oh Hell with one card left', s && { phase: s.phase, hand: s.hand.length, round: s.round });
await click(await handPt(0));
sh = await until(async () => { const x = await sheet(); return x.open ? x : null; }, 12000);
ok(!!sh, 'the last Oh Hell round closes the match and opens its sheet', sh);
s = await state();
ok(s.over === true, 'the Oh Hell match reports over', s.over);
await shot('cards-ohhell');

// ---------- 9) restart + mode cycle (through the bottom bar) ----------
await ev(`(()=>{document.getElementById('overBack').click();return 1})()`);
await click(await btnPt('newBtn'));
await sleep(400);
s = await state();
ok(s.over === false && s.counts.every((c) => c === s.counts[0]) && s.counts[0] > 0, 'New deal restarts a fresh match in the same mode', { over: s.over, counts: s.counts, mode: s.mode });
ok(!(await sheet()).open, 'the end sheet is closed after a restart');
const modeBefore = s.mode;
await click(await btnPt('modeBtn'));
await sleep(400);
s = await state();
ok(s.mode !== modeBefore, 'the mode button switches the game', { before: modeBefore, after: s.mode });
ok(s.hand.length >= 1, 'the new mode deals a hand', s.hand.length);

// ---------- 10) console errors ----------
const errs = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
const logErr = pageCdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text);
const realErr = [...errs, ...logErr].filter((t) => t && !/favicon/i.test(t));
ok(realErr.length === 0, 'no console errors during the run', realErr.slice(0, 4));

// ---------- 11) portrait 390x844 ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4500);
await ev('window.__cats.handPoint(0)'); // prime the override
s = await state();
ok(s && s.view === '390x844', 'portrait viewport applied', s && s.view);
const pts = await ev(`(()=>{const n=window.__cats().hand.length;const out=[];for(let i=0;i<n;i++){const p=window.__cats.handPoint(i);out.push([p.x,p.y,window.__cats.pick(p.x,p.y)]);}return out;})()`);
const inView = pts.filter((p) => p[0] > 4 && p[0] < 386 && p[1] > 40 && p[1] < 760);
ok(inView.length === pts.length, 'every hand card sits inside the visible phone screen', { n: pts.length, in: inView.length });
ok(pts.every((p, i) => p[2] === i), 'the portrait picker round-trips every card', pts.filter((p, i) => p[2] !== i).slice(0, 4));
// prime with a neutral press on the HUD, then the real tap
await click({ x: 200, y: 60 });
await sleep(120);
let tapped = null;
for (let attempt = 0; attempt < 2 && !tapped; attempt++) {
  const p = await ev('window.__cats.handPoint(0)');
  await click(p);
  await sleep(320);
  s = await state();
  if (s.sel.length || s.counts[0] < 13) tapped = s;
}
ok(!!tapped, 'a phone tap on a card is accepted', tapped && { sel: tapped.sel.length });
await shot('cards-portrait');

server.close();
proc.kill('SIGTERM');
console.log('\n' + (fails.length ? 'CARDS GATE FAIL\n' + fails.map((f) => ' - ' + f).join('\n') : 'CARDS GATE OK'));
process.exit(fails.length ? 1 : 0);
