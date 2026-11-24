#!/usr/bin/env node
// Interaction gate for the Stronghold Protocol port. Real CDP mouse clicks on the shipped page:
// draft a hero from the shop, deploy it on a green cell, move it, upgrade it, send a wave and
// watch it fight, prove the win sheet and the lose sheet from QA positions, restart, the
// double-tap guard, picker round-trip on every deploy cell, and a 390x844 portrait pass.
// usage: node stronghold-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/stronghold-protocol/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
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
const PROFILE = mkdtempSync('/tmp/strong-gate-');
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
await sleep(4500);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const state = () => ev('window.__stronghold()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const cellPt = async (c, r) => ev(`window.__stronghold.cellPoint(${c},${r})`);
const clickCell = async (c, r, wait = 340) => {
  const p = await cellPt(c, r);
  if (!p || p.__err) return { err: p && p.__err, c, r };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 420) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const clickSel = async (sel, wait = 400) => {
  const b = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const poll = async (pred, tries = 40, ms = 500) => {
  for (let i = 0; i < tries; i++) {
    const s = await state();
    if (s && !s.__err && pred(s)) return s;
    await sleep(ms);
  }
  return null;
};

// ---------- 1. boot ----------
const s0 = await state();
ok(s0 && !s0.__err, 'the debug hook is live', s0);
ok(s0.phase === 'prep' && s0.over === false, 'boots into the draft phase', { phase: s0.phase, over: s0.over });
ok(s0.gold === 12 && s0.wall === 24 && s0.wave === 1, 'start purse, wall and wave', { gold: s0.gold, wall: s0.wall, wave: s0.wave });
ok(s0.shop.length === 3 && s0.shop.every(k => typeof k === 'string'), 'three heroes are offered', s0.shop);
ok(s0.shop.some(k => ['archer', 'frost', 'mage', 'ballista'].includes(k)), 'a shop always offers ranged fire', s0.shop);
ok(s0.units.length === 0 && s0.bench.length === 0 && s0.cap === 3, 'an empty roster with room for three', { units: s0.units.length, cap: s0.cap });
const bootShot = await shot('stronghold-boot');

// ---------- 2. picker round-trip on every deploy cell ----------
const roundTrip = await ev(`(()=>{const bad=[];for(const {c,r} of window.__stronghold.deployCells()){const p=window.__stronghold.cellPoint(c,r);const q=window.__stronghold.cellAt(p.x,p.y);if(!q||q.c!==c||q.r!==r)bad.push([c,r,q]);}return bad;})()`);
ok(Array.isArray(roundTrip) && roundTrip.length === 0, 'every deploy cell picks back to itself', roundTrip);
const foeRow = await ev(`(()=>{const p=window.__stronghold.cellPoint(3,0);return window.__stronghold.cellAt(p.x,p.y);})()`);
ok(foeRow && foeRow.r === 0, 'the enemy rows are pickable too (they are just not deployable)', foeRow);

// ---------- 3. draft, deploy, move, upgrade ----------
const offer0 = s0.shop[0];
const shopPt = await ev('window.__stronghold.shopPoint(0)');
await click(shopPt); await sleep(420);
let s1 = await state();
const cost = await ev(`window.__stronghold.rules().units[${JSON.stringify(offer0)}].cost`);
ok(s1.bench.length === 1 && s1.bench[0] === offer0, 'the shop tap buys into the bench', { bench: s1.bench, offer0 });
ok(s1.gold === 12 - cost, 'the buy charges the price', { gold: s1.gold, cost });

const benchPt = await ev('window.__stronghold.benchPoint(0)');
await click(benchPt); await sleep(300);
const s2 = await state();
ok(s2.selBench === 0, 'the bench chip selects the hero', { selBench: s2.selBench });

await clickCell(4, 4);
let s3 = await state();
ok(s3.units.length === 1 && s3.units[0].r === 4 && s3.units[0].c === 4, 'the hero deploys on the green cell', s3.units);
ok(s3.bench.length === 0, 'the bench is empty after the deploy');
const before = s3.inputs;
await clickCell(4, 3);
let s4 = await state();
ok(s4.units.length === 1 && s4.units[0].r === 3 && s4.units[0].c === 4, 'a placed hero moves to another green cell', s4.units);
ok(s4.inputs > before, 'the move counted as an input', { before, after: s4.inputs });

// an enemy-row tap is refused: no unit appears there
await clickCell(2, 0);
const s5 = await state();
ok(s5.units.length === 1, 'the enemy rows refuse a deploy', s5.units);

// upgrade the placed hero
s3 = await state();
const goldBefore = s3.gold, kind = s3.units[0].kind;
await clickEl('upgrade');
const s6 = await state();
const upCost = await ev(`window.__stronghold.rules().units[${JSON.stringify(kind)}].cost`);
ok(s6.units[0].lvl === 2, 'upgrade raises the hero a level', { units: s6.units, gold: s6.gold, goldBefore, upCost });

// recall sends it back to the bench, then re-deploy for the wave
await clickEl('recall');
const s7 = await state();
ok(s7.units.length === 0 && s7.bench.length === 1, 'recall returns the hero to the bench', { units: s7.units.length, bench: s7.bench });
await clickSel('#bench [data-bench="0"]');
await clickCell(3, 4);

// ---------- 4. a real wave fights itself ----------
const s8 = await state();
ok(s8.units.length === 1, 'the hero is back on the board', s8.units);
await clickEl('send', 300);
const s9 = await state();
ok(s9.phase === 'battle', 'Send wave starts the fight', s9.phase);
const midShot = await shot('stronghold-battle');
const killed = await poll((s) => s.kills >= 1 || s.wall < 24, 40, 400);
ok(killed !== null, 'the firing line engages the wave (a kill or a leak)', killed && { kills: killed.kills, leaks: killed.leaks, wall: killed.wall });
const resolved = await poll((s) => s.phase === 'prep' || s.over, 60, 500);
ok(resolved !== null, 'the wave resolves back to the draft phase', resolved && { phase: resolved.phase, wave: resolved.wave });

// ---------- 5. win sheet from a QA position ----------
const strong = [];
strong.push({ kind: 'guard', c: 3, r: 4, lvl: 3 }, { kind: 'guard', c: 2, r: 4, lvl: 3 }, { kind: 'guard', c: 4, r: 4, lvl: 3 });
strong.push({ kind: 'ballista', c: 3, r: 2, lvl: 3 }, { kind: 'mage', c: 2, r: 2, lvl: 3 }, { kind: 'mage', c: 4, r: 2, lvl: 3 });
strong.push({ kind: 'archer', c: 1, r: 3, lvl: 3 }, { kind: 'archer', c: 5, r: 3, lvl: 3 });
const setupWin = await ev(`window.__stronghold.setup(${JSON.stringify({ wave: 13, gold: 0, wall: 24, units: strong })})`);
ok(setupWin && setupWin.units === 8, 'the QA board loads a full roster on the last wave', setupWin);
await clickEl('send', 200);
let won = null;
for (let i = 0; i < 60; i++) {
  const r = await ev('window.__stronghold.step(1.0)');
  if (r && r.over) { won = r; break; }
  await sleep(120);
}
const winSheet = await sheet();
ok(won && won.result === 'win', 'the last wave is beaten from the QA position', won);
ok(winSheet.open && /holds/i.test(winSheet.title), 'the win sheet opens', winSheet);
const winShot = await shot('stronghold-win');

// ---------- 6. lose sheet ----------
await ev(`window.__stronghold.setup(${JSON.stringify({ wave: 0, gold: 0, wall: 2, units: [] })})`);
await clickEl('send', 200);
let lost = null;
for (let i = 0; i < 40; i++) {
  const r = await ev('window.__stronghold.step(1.0)');
  if (r && r.over) { lost = r; break; }
  await sleep(120);
}
const loseSheet = await sheet();
ok(lost && lost.result === 'lose', 'an undefended hold loses the run', lost);
ok(loseSheet.open && /fell/i.test(loseSheet.title), 'the lose sheet opens', loseSheet);
const loseShot = await shot('stronghold-lose');

// ---------- 7. restart from the sheet ----------
await clickEl('overBtn', 500);
const s10 = await state();
ok(s10.over === false && s10.wall === 24 && s10.gold === 12 && s10.wave === 1, 'Play again restarts the run', { over: s10.over, wall: s10.wall, gold: s10.gold, wave: s10.wave });

// ---------- 8. double-tap guard ----------
const dupBefore = (await state()).dups;
const p = await cellPt(3, 3);
await ev(`(()=>{const c=document.querySelector('body > canvas');const o={bubbles:true,clientX:${p.x},clientY:${p.y},pointerType:'touch',pointerId:7};c.dispatchEvent(new PointerEvent('pointerup',o));c.dispatchEvent(new PointerEvent('pointerup',o));return 1;})()`);
await sleep(220);
const s11 = await state();
ok(s11.dups > dupBefore, 'a same-point double tap is counted and dropped', { before: dupBefore, after: s11.dups });

// ---------- 9. portrait pass ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1100);
const bandInfo = await ev('window.__stronghold.band()');
const fitBad = await ev(`(()=>{const b=window.__stronghold.band();const bad=[];for(const {c,r} of window.__stronghold.deployCells()){const p=window.__stronghold.cellPoint(c,r);const q=window.__stronghold.cellAt(p.x,p.y);if(!q||q.c!==c||q.r!==r)bad.push(['pick',c,r,q]);if(p.y> b.botPx||p.y< b.topPx)bad.push(['band',c,r,p.y,Math.round(b.topPx),Math.round(b.botPx)]);}return bad;})()`);
ok(Array.isArray(fitBad) && fitBad.length === 0, 'in portrait every deploy cell is on screen, inside the HUD band, and picks back', fitBad);
const s12 = await state();
ok(s12.view === '390x844', 'the portrait viewport is live', s12.view);
await shot('stronghold-portrait');

// a real tap in portrait deploys a hero
await ev('window.__stronghold.setup({ wave: 0, gold: 20, units: [], bench: ["archer"] })');
await clickSel('#bench [data-bench="0"]');
const pp = await cellPt(3, 3);
await click(pp); await sleep(400);
const s13 = await state();
ok(s13.units.length === 1, 'a portrait tap deploys a hero', { units: s13.units, point: pp });

// ---------- 10. console errors ----------
const consoleErrors = pageCdp.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' '))
  .concat(pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.text || 'exception'));
ok(consoleErrors.length === 0, 'no console errors or uncaught exceptions', consoleErrors.slice(0, 3));

console.log('\nshots: ' + [bootShot, midShot, winShot, loseShot].join(' '));
if (fails.length) { console.log('\nSTRONGHOLD GATE FAIL (' + fails.length + ')'); fails.forEach((f) => console.log(' - ' + f)); proc.kill(); server.close(); process.exit(1); }
console.log('\nSTRONGHOLD GATE PASS');
proc.kill(); server.close();
process.exit(0);
