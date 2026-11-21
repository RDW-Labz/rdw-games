#!/usr/bin/env node
// Interaction gate for the Die Simulator port: real CDP mouse on the roll/bank buttons,
// state-hook assertions for roll / bank / bust / win / lose / restart, double-tap guard,
// keyboard, and a 390x844 touch pass. usage: node die-simulator-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/die-simulator/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/die-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-28));
const dport = new URL(endpoint).port;
const server = await serve();
const port = server.address().port;
T('serving ' + ROOT + ' on ' + port);
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('no page target');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const st = () => ev('window.__die && window.__die()');
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
};
const byId = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('shot ' + out);
  return out;
};
async function poll(fn, ms = 12000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);

// ---- 1) boot
const hookType = await ev('typeof window.__die');
ok(hookType === 'function', 'hook is a function (' + hookType + ')');
const s0 = await st();
ok(s0 && s0.phase === 'you' && s0.you === 0 && s0.house === 0, 'boot table is yours at 0-0: ' + JSON.stringify(s0 && { phase: s0.phase, you: s0.you, house: s0.house }));
const dieP = await ev('window.__die.diePoint()');
ok(dieP && dieP.x > 0 && dieP.y > 0, 'die point resolves: ' + JSON.stringify(dieP));
const overCanvas = await ev(`(()=>{const p=window.__die.diePoint();const e=document.elementFromPoint(p.x,p.y);return e?e.tagName:null;})()`);
ok(overCanvas === 'CANVAS', 'the die sits over the canvas (got ' + overCanvas + ')');
const shotBoot = await shot('die-simulator-gate-boot');

// ---- 2) a rigged roll moves the stake, and the die shows the rolled face
await ev('window.__die.rig([4])');
const rollP = await byId('roll');
await click(rollP);
await sleep(950);
const s1 = await st();
ok(s1.rolls === 1, 'one real click on Roll resolves one roll (rolls ' + s1.rolls + ')');
ok(s1.die === 4 && s1.stake === 4, 'the rigged 4 lands on the stake: ' + JSON.stringify({ die: s1.die, stake: s1.stake }));
ok(s1.inputs === 1, 'exactly one accepted input (inputs ' + s1.inputs + ', dups ' + s1.dups + ')');

// ---- 3) bank moves it into the score and hands the die to the house
await click(await byId('bank'));
await sleep(400);
const s2 = await st();
ok(s2.you === 4 && s2.stake === 0, 'bank scores the stake (you ' + s2.you + ', stake ' + s2.stake + ')');
ok(s2.phase === 'house', 'the die passed to the house (phase ' + s2.phase + ')');

// ---- 4) the house plays on its own and gives the die back
const back = await poll(async () => { const s = await st(); return (s.phase === 'you' || s.over) ? s : null; }, 20000);
ok(!!back, 'house turn resolved without a click: ' + JSON.stringify(back && { house: back.house, phase: back.phase, rolls: back.rolls, msg: back.msg }));
ok(back && back.house >= 0 && back.rolls > 1, 'house actually rolled the die (rolls ' + (back && back.rolls) + ')');
const shotMid = await shot('die-simulator-gate-mid');

// ---- 5) a 1 busts the turn and takes the stake
await ev('window.__die.setup({you:12,house:6})');
await ev('window.__die.rig([1])');
await click(await byId('roll'));
await sleep(950);
const s3 = await st();
ok(s3.busts === 1 && s3.stake === 0 && s3.die === 1, 'bust: ' + JSON.stringify({ busts: s3.busts, stake: s3.stake, die: s3.die, you: s3.you }));
ok(s3.you === 12, 'a bust cannot touch the banked score (you ' + s3.you + ')');

// ---- 6) keyboard rolls too
const kBefore = (await st()).rolls;
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
await sleep(900);
const s4 = await st();
ok(s4.rolls === kBefore + 1, 'Space rolls (rolls ' + kBefore + ' -> ' + s4.rolls + ')');

// ---- 7) win: bank over the target through the real buttons
await ev('window.__die.setup({you:38,house:10})');
await ev('window.__die.rig([6])');
await click(await byId('roll'));
await sleep(950);
const s5 = await st();
ok(s5.stake === 6, 'stake 38+6 is armed (' + s5.stake + ')');
await click(await byId('bank'));
await sleep(500);
const s6 = await st();
ok(s6.over === true && s6.won === true, 'banking past 40 wins (' + JSON.stringify({ over: s6.over, won: s6.won, you: s6.you }) + ')');
ok(s6.sheet && /take the table/i.test(s6.sheetTitle), 'win sheet reads "' + s6.sheetTitle + '"');
const shotWin = await shot('die-simulator-gate-win');

// ---- 8) lose: the house banks past 40 with the rigged die
await ev('window.__die.setup({you:5,house:33,phase:"house"})');
await ev('window.__die.rig([6,6])');
await ev('window.__die.startHouse()');
const lost = await poll(async () => { const s = await st(); return s.over ? s : null; }, 15000);
ok(!!lost, 'house turn reached a terminal state: ' + JSON.stringify(lost && { over: lost.over, won: lost.won, house: lost.house }));
ok(lost && lost.won === false && lost.house >= 40, 'house wins at 40+: ' + JSON.stringify(lost && { house: lost.house, won: lost.won }));
ok(lost && /house takes it/i.test(lost.sheetTitle), 'lose sheet reads "' + (lost && lost.sheetTitle) + '"');

// ---- 9) restart from the sheet's own button
await click(await byId('overBtn'));
await sleep(500);
const s7 = await st();
ok(s7.you === 0 && s7.house === 0 && s7.rolls === 0 && s7.phase === 'you' && !s7.sheet, 'Play again resets the table: ' + JSON.stringify({ you: s7.you, house: s7.house, rolls: s7.rolls, phase: s7.phase, sheet: s7.sheet }));

// ---- 10) double-tap guard: two pointerups in one tick roll once
const before = (await st()).inputs;
await ev(`(()=>{const p=window.__die.rollPoint();const t=document.elementFromPoint(p.x,p.y);
  const mk=(ty)=>new PointerEvent(ty,{clientX:p.x,clientY:p.y,pointerId:1,bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true});
  for(const el of new Set([t,document.querySelector('canvas')])){el.dispatchEvent(mk('pointerdown'));el.dispatchEvent(mk('pointerup'));}
  return true;})()`);
await sleep(950);
const s8 = await st();
ok(s8.dups >= 1, 'the second same-point tap was dropped (dups ' + s8.dups + ')');
ok(s8.inputs === before + 1, 'two simultaneous taps = one roll (inputs ' + before + ' -> ' + s8.inputs + ')');

const errors1 = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
ok(!errors1, 'no console errors on desktop: ' + (errors1 || 'none'));

// ---- 11) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5400);
const fit = await ev(`(()=>{const d=window.__die.diePoint(),r=window.__die.rollPoint();
  const ce=document.elementFromPoint(d.x,d.y), re=document.elementFromPoint(r.x,r.y);
  return {d,r,ce:ce&&ce.tagName,re:re&&re.textContent.trim(),h:innerHeight,w:innerWidth,tray:window.__die.camera()};})()`);
ok(fit && fit.d.x >= 0 && fit.d.x <= fit.w && fit.d.y >= 0 && fit.d.y <= fit.h, 'die point is inside the portrait viewport: ' + JSON.stringify(fit && fit.d));
ok(fit && fit.ce === 'CANVAS', 'die point hits the canvas in portrait (' + (fit && fit.ce) + ')');
ok(fit && /Roll/i.test(fit.re || ''), 'roll point hits the Roll button in portrait (' + (fit && fit.re) + ')');
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fit.r.x, y: fit.r.y, radiusX: 9, radiusY: 9, force: 1 }] });
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(1000);
const s9 = await st();
ok(s9 && s9.rolls === 1 && s9.stake > 0, 'a portrait finger on Roll rolls the die: ' + JSON.stringify(s9 && { rolls: s9.rolls, stake: s9.stake, die: s9.die }));
const shotTouch = await shot('die-simulator-gate-touch');

const errors2 = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
  .slice(0, 4).join(' | ');
ok(!errors2, 'no console errors in portrait: ' + (errors2 || 'none'));

console.log('\nshots: ' + [shotBoot, shotMid, shotWin, shotTouch].join(' '));
proc.kill('SIGKILL');
server.close();
if (fails) { console.log(`\nFAIL: ${fails} assertion(s) failed`); process.exit(1); }
console.log('PASS die-simulator gate: roll/bank/bust/win/lose/restart, house turn, keyboard, double-tap guard, portrait touch');
process.exit(0);
