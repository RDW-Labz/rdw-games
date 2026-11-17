#!/usr/bin/env node
// Interaction gate for the Chess Clock port (Chess-Clock / Blitz-Fischer clock cards):
// real pointer presses on the two 3D clock faces, hook assertions for press/increment/
// hand-over, wall-clock flag -> win sheet, control cycle, restart, plus portrait touch.
// usage: node clock-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/chess-clock/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, normalize(p));
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

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/clock-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-30));
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
T('serving ' + port + ' root ' + ROOT);

const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
cdp.ws.close();
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const fails = [];
const check = (name, ok, detail) => { T(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); if (!ok) fails.push(name); };

// one synthetic press: down on the element under the point, up on body (kit + port listen there)
const tap = async (pt) => {
  await ev(`(()=>{const x=${pt.x},y=${pt.y};const t=document.elementFromPoint(x,y)||document.body;
    const o={bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:7,pointerType:'mouse',isPrimary:true,button:0,buttons:1};
    t.dispatchEvent(new PointerEvent('pointerdown',o));
    document.body.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));
    return t.tagName;})()`);
  await sleep(140);
};
const clickEl = async (id) => {
  const r = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;e.click();return true;})()`);
  await sleep(200);
  return r;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

// ---- 1) boot: hook live, clocks at the 3+2 control
const hookType = await ev('typeof window.__chessclock');
check('hook is a function', hookType === 'function', hookType);
const s0 = await ev('window.__chessclock()');
check('3+2 control loaded', s0 && s0.ws === 180 && s0.bs === 180 && s0.inc === 2000, s0 && [s0.ws, s0.bs, s0.inc]);
check('idle at boot', s0 && s0.running === false && s0.over === false && s0.turn === 'w', s0 && [s0.running, s0.turn]);
const shotBoot = await shot('chess-clock-gate-boot');
T('boot shot ' + shotBoot);

// ---- 2) press White's face: White banks the increment, Black's clock starts and drains
const pW = await ev('window.__chessclock.panelPoint("w")');
const pB = await ev('window.__chessclock.panelPoint("b")');
T('panel points ' + JSON.stringify({ pW, pB }));
check('faces are apart on screen', Math.abs(pW.y - pB.y) > 40, [pW.y, pB.y]);
await tap(pW);
const s1 = await ev('window.__chessclock()');
check('first press starts the clock', s1.running === true && s1.moves === 1 && s1.turn === 'b', s1 && [s1.running, s1.moves, s1.turn]);
check('increment banked on the presser', s1.ws > s0.ws, [s0.ws, s1.ws]);
await sleep(1300);
const s2 = await ev('window.__chessclock()');
check('running clock drains on wall time', s2.bs < s1.bs - 0.5, [s1.bs, s2.bs]);
check('idle clock holds', Math.abs(s2.ws - s1.ws) < 0.15, [s1.ws, s2.ws]);
check('faces carry their own readouts', /^3:0\d$/.test(s2.shown.w) && /^2:5\d$/.test(s2.shown.b), s2.shown);
check('only the running side is lit', s2.active === 'b', s2.active);

// ---- 3) press Black's face: hand-over back to White
await tap(pB);
const s3 = await ev('window.__chessclock()');
check('second press hands over', s3.turn === 'w' && s3.moves === 2, s3 && [s3.turn, s3.moves]);
check('black banked its increment', s3.bs > s2.bs, [s2.bs, s3.bs]);
const shotMid = await shot('chess-clock-gate-pressed');
T('mid shot ' + shotMid);

// ---- 4) control cycle resets the clocks and relabels the HUD
const label0 = await ev('document.getElementById("ctrl").textContent');
await clickEl('ctrlBtn');
const c1 = await ev('window.__chessclock()');
const label1 = await ev('document.getElementById("ctrl").textContent');
check('control cycles', c1.preset !== '3+2' && label1 === c1.preset, [label0, label1]);
check('cycle restarts the clocks', c1.running === false && c1.moves === 0 && c1.ws === c1.bs, c1 && [c1.preset, c1.ws, c1.bs]);
const pre = c1.preset;
let wrapped = false;
for (let i = 0; i < 5; i++) { await clickEl('ctrlBtn'); const s = await ev('window.__chessclock()'); if (s.preset === pre) { wrapped = true; break; } }
const c2 = await ev('window.__chessclock()');
check('control wraps back around', wrapped && c2.preset === pre, [pre, c2.preset]);

// ---- 5) flag: White short of time and on the move -> Black wins on time
await ev('window.__chessclock.setup({w:300,b:60000,turn:"w",running:true,moves:9})');
for (let i = 0; i < 30; i++) { await sleep(200); const s = await ev('window.__chessclock()'); if (s && s.over) break; }
const f1 = await ev('window.__chessclock()');
const sheet = await ev('(()=>({open:document.getElementById("over").classList.contains("open"),title:document.getElementById("overTitle").textContent,text:document.getElementById("overText").textContent}))()');
check('flag ends the game', f1.over === true && f1.running === false && f1.flagged === 'w', f1 && [f1.over, f1.flagged]);
check('win sheet names the winner', sheet.open === true && /Black wins/.test(sheet.title), sheet);
check('flagged face reads zero', f1.shown.w === '0:00.0', f1.shown);
const shotFlag = await shot('chess-clock-gate-flag');
T('flag shot ' + shotFlag);

// ---- 6) a press after the flag does nothing; restart clears it
const before = await ev('window.__chessclock()');
await tap(pW);
const after = await ev('window.__chessclock()');
check('no presses after the flag', after.moves === before.moves && after.over === true, [before.moves, after.moves]);
await clickEl('overBtn');
const r1 = await ev('window.__chessclock()');
const presetBase = await ev('(()=>{const p=document.getElementById("ctrl").textContent;return Number(p.split("+")[0])*60;})()');
check('restart clears the sheet', r1.over === false && r1.sheet === false && r1.moves === 0 && r1.ws === r1.bs && Math.abs(r1.ws - presetBase) < 1, r1 && [r1.over, r1.ws, r1.bs, presetBase]);

// ---- 7) R restarts mid-game
await tap(pW);
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const r2 = await ev('window.__chessclock()');
check('R restarts', r2.running === false && r2.moves === 0, r2 && [r2.running, r2.moves]);

// ---- 8) duplicate-dispatch guard (catalog gate double-fires each pointerup)
const dup = await ev(`(()=>{const p=window.__chessclock.panelPoint('w');const o={bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,pointerId:9,pointerType:'mouse',isPrimary:true,button:0,buttons:0};
  document.body.dispatchEvent(new PointerEvent('pointerup',o));document.body.dispatchEvent(new PointerEvent('pointerup',o));
  return window.__chessclock();})()`);
check('echo press dropped', dup.moves === 1 && dup.dups >= 1, [dup.moves, dup.dups]);

// ---- 9) console errors before the portrait pass
const errors1 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .filter((t) => t && !/favicon/i.test(t))
  .slice(0, 4);
check('no console errors', errors1.length === 0, errors1);

// ---- 10) portrait 390x844 touch: the two faces stay framed and a finger press works
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);
const m = await ev('(()=>{const p=window.__chessclock.panelPoint("w");return {p,w:innerWidth,h:innerHeight,ok:window.__chessclock()};})()');
check('portrait: white face on screen', m.p.x > 10 && m.p.x < m.w - 10 && m.p.y > 10 && m.p.y < m.h - 10, m.p);
const pT = await ev('window.__chessclock.panelPoint("w")');
await ev(`(()=>{const x=${pT.x},y=${pT.y};const t=document.elementFromPoint(x,y)||document.body;
  const o={bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:11,pointerType:'touch',isPrimary:true,button:0,buttons:1};
  t.dispatchEvent(new PointerEvent('pointerdown',o));
  document.body.dispatchEvent(new PointerEvent('pointerup',{...o,pointerType:'touch',buttons:0}));
  return true;})()`);
await sleep(600);
const t1 = await ev('window.__chessclock()');
check('portrait touch presses the clock', t1.running === true && t1.moves === 1, t1 && [t1.running, t1.turn]);
const shotPortrait = await shot('chess-clock-gate-portrait');
T('portrait shot ' + shotPortrait);

const errors2 = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;

proc.kill('SIGKILL');
server.close();

console.log(JSON.stringify({
  slug: 'chess-clock',
  shots: { boot: shotBoot, pressed: shotMid, flag: shotFlag, portrait: shotPortrait },
  fails,
  errors1,
  exceptions: errors2,
  verdict: fails.length === 0 && errors1.length === 0 ? 'PASS' : 'FAIL',
  final: await Promise.resolve(t1),
}, null, 1));
process.exit(fails.length === 0 && errors1.length === 0 ? 0 : 1);
