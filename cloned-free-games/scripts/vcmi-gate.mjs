#!/usr/bin/env node
// Interaction gate for the Hex Fields port (VCMI card): real CDP mouse on the hex field,
// state-hook assertions for select / march / wait / defend / attack / win / lose / restart,
// plus a portrait touch pass. A canvas that merely exists is not proof.
//
// usage: node vcmi-gate.mjs [site-repo-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/vcmi/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { console.log('  ok   ' + msg); return true; }
  fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};

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
  return new Promise((ok2) => s.listen(0, '127.0.0.1', () => ok2(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok2, bad) => { ws.onopen = ok2; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok: o, bad: b } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? b(new Error(msg.error.message)) : o(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok2, bad) => {
      this.p.set(id, { ok: ok2, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/vcmi-gate-');
const proc = spawn(bin, [
  '--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  '--window-size=1280,800', '--no-first-run', `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const cdpEvents = () => pageCdp.events;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const errorsNow = () => cdpEvents().filter((e) => e.method === 'Runtime.exceptionThrown'
  || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text
    || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 5).join(' | ');

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `${base}/${FILE}` });
await sleep(5200);

const click = async (pt) => {
  if (!pt || pt.x == null || pt.y == null || Number.isNaN(pt.x) || Number.isNaN(pt.y)) throw new Error('bad point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const hexClick = async (c, r) => {
  const p = await ev(`window.__vcmi.hexPoint(${c},${r})`);
  await click(p);
  await sleep(300);
  return p;
};
// a real press+release at a DOM button: a synthesised PointerEvent alone does not fire 'click'
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const poll = async (expr, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(200);
  }
  return null;
};

// ---- 1) boot
console.log('boot');
const hookType = await ev('typeof window.__vcmi');
ok(hookType === 'function', 'the state hook is a function (the catalog gate requires it)', hookType);
const st0 = await ev('window.__vcmi()');
ok(st0 && !st0.__err, 'the hook answers with state', st0 && st0.__err);
ok(st0.round === 1 && st0.stacks.length === 10, 'a ten-stack battle is on the field', { round: st0.round, n: st0.stacks.length });
ok(st0.you === 24 && st0.foe === 27, 'both armies mustered', { you: st0.you, foe: st0.foe });
ok(st0.sel >= 0 && st0.sel === st0.current, 'the acting stack is pre-selected so its march is visible', { sel: st0.sel, cur: st0.current });
ok(Array.isArray(st0.reach) && st0.reach.length > 0, 'the selected stack shows reachable hexes', st0.reach && st0.reach.length);
const kids = await ev('window.__vcmi.children()');
ok(kids > 60, 'the board is built (63 cells + 10 stacks + ring)', kids);
const shotBoot = await shot('vcmi-gate-boot');
ok(!!shotBoot, 'boot screenshot written', shotBoot);

// ---- 2) march: a real click on a reachable hex moves the stack and spends its action
console.log('march');
const before = await ev('window.__vcmi()');
const st = before.stacks.find((s) => s.id === before.sel);
const dest = before.reach.find(([c, r]) => c !== st.c || r !== st.r);
await hexClick(dest[0], dest[1]);
const mid = await ev('window.__vcmi()');
const moved = mid.stacks.find((s) => s.id === before.sel);
ok(moved && moved.c === dest[0] && moved.r === dest[1], 'the stack marched to the clicked hex', { want: dest, got: [moved.c, moved.r] });
ok(mid.moves >= 1, 'the action was counted', mid.moves);
ok(mid.inputs >= 1 && mid.taps >= 1, 'the pointer event reached the board', { inputs: mid.inputs, taps: mid.taps });
ok(mid.turn === 1 || mid.turn === 0, 'the turn passed along the order', mid.turn);
const back = await poll('(()=>{const s=window.__vcmi();return s.turn===0 && !s.over ? s : null})()');
ok(back, 'the warband replies and hands the turn back', back && back.turn);
ok(!back.over, 'the battle is still live after the first exchange');
const shotMid = await shot('vcmi-gate-march');

// ---- 3) wait re-orders without spending the round
console.log('wait / defend');
const b2 = await ev('window.__vcmi()');
const curId = b2.current;
await clickEl('wait');
const a2 = await ev('window.__vcmi()');
ok(a2.order[a2.order.length - 1] === curId, 'Wait sends the acting stack to the end of the round', { tail: a2.order[a2.order.length - 1], was: curId });
ok(a2.round === b2.round, 'Wait does not roll the round', { was: b2.round, now: a2.round });
const w2 = await poll('(()=>{const s=window.__vcmi();return s.turn===0 && !s.over ? s : null})()');
ok(!!w2, 'the turn still comes back after a wait');

const b3 = await ev('window.__vcmi()');
const defenderId = b3.current;
await clickEl('defend');
const a3 = await ev('window.__vcmi()');
const df = a3.stacks.find((s) => s.id === defenderId);
ok(df && df.defending === true, 'Defend raises that stack\'s guard', df && df.defending);
const w3 = await poll('(()=>{const s=window.__vcmi();return s.turn===0 && !s.over ? s : null})()');
ok(!!w3, 'the turn returns after a defend');

// ---- 4) a strike that wins: QA position, real click on the enemy stack
console.log('win');
const WIN = {
  stacks: [
    { side: 0, kind: 'cavaliers', c: 2, r: 3, n: 2 },
    { side: 1, kind: 'goblins', c: 3, r: 3, n: 1 },
  ],
};
const wset = await ev(`window.__vcmi.setup(${JSON.stringify(WIN)})`);
ok(wset && !wset.__err, 'the QA win position loads', wset && wset.__err);
ok(wset.sel >= 0, 'the quarter-master pre-selects your stack in the QA position', wset.sel);
await hexClick(3, 3);
const afterWin = await ev('window.__vcmi()');
ok(afterWin.over === true && afterWin.result === 'win', 'charging the last stack ends the battle as a win', { over: afterWin.over, result: afterWin.result });
ok(afterWin.sheet === true && /Field taken/.test(afterWin.title || ''), 'the win sheet names the result', afterWin.title);
ok(afterWin.moves >= 1, 'the winning strike was a real move', afterWin.moves);
const shotWin = await shot('vcmi-gate-win');

// ---- 5) losing: the warband strikes first and breaks your army
console.log('lose');
const LOSE = {
  stacks: [
    { side: 0, kind: 'goblins', c: 3, r: 3, n: 1 },
    { side: 1, kind: 'cyclops', c: 4, r: 3, n: 2 },
  ],
  turnSide: 1,
};
const lset = await ev(`window.__vcmi.setup(${JSON.stringify(LOSE)})`);
ok(lset && !lset.__err, 'the QA loss position loads', lset && lset.__err);
const lostState = await poll('(()=>{const s=window.__vcmi();return s.over && s.result==="lose" ? s : null})()', 9000);
ok(!!lostState, 'the warband\'s strike breaks the army and the battle ends as a loss', lostState && lostState.result);
ok(lostState && lostState.sheet === true && /Army broken/.test(lostState.title || ''), 'the loss sheet names the result', lostState && lostState.title);
const shotLose = await shot('vcmi-gate-lose');

// ---- 6) restart from the sheet, then the R key
console.log('restart');
await clickEl('overBtn');
await sleep(500);
const rst = await ev('window.__vcmi()');
ok(!rst.over && rst.result === null && rst.sheet === false, 'Play again clears the sheet', { over: rst.over, sheet: rst.sheet });
ok(rst.round === 1 && rst.stacks.length === 10 && rst.moves === 0, 'Play again fields a fresh battle', { round: rst.round, stacks: rst.stacks.length, moves: rst.moves });
ok(rst.you === 24 && rst.foe === 27, 'the fresh battle has the full armies', { you: rst.you, foe: rst.foe });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const rst2 = await ev('window.__vcmi()');
ok(rst2.moves === 0 && rst2.round === 1 && !rst2.over, 'R fields a new battle too', { moves: rst2.moves, round: rst2.round });

const errMain = await errorsNow();
ok(!errMain, 'no console errors on the desktop pass', errMain);

// ---- 7) the flat forwarder keeps the old URL working
console.log('forwarder');
await S('Page.navigate', { url: `${base}/games/arcade/vcmi.html` });
await sleep(2200);
const where = await ev('location.pathname');
ok(/\/games\/arcade\/vcmi\/$/.test(where || ''), 'games/arcade/vcmi.html forwards into the port folder', where);

// ---- 8) portrait touch
console.log('portrait');
cdpEvents().length = 0;
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `${base}/${FILE}` });
await sleep(5400);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
const p0 = await ev('window.__vcmi()');
ok(p0 && !p0.__err && p0.sel >= 0, 'the hook answers on the phone viewport');
const corners = await ev('(()=>[window.__vcmi.hexPoint(0,0),window.__vcmi.hexPoint(8,6)])()');
const inside = corners.every((p) => p && p.x > 4 && p.x < 386 && p.y > 60 && p.y < 790);
ok(inside, 'the whole field projects inside the phone viewport (and clear of the bars)', corners);
const pst = p0.stacks.find((s) => s.id === p0.sel);
const pdest = p0.reach.find(([c, r]) => c !== pst.c || r !== pst.r);
const pt = await ev(`window.__vcmi.hexPoint(${pdest[0]},${pdest[1]})`);
await tap(pt);
const p1 = await ev('window.__vcmi()');
const pm = p1.stacks.find((s) => s.id === p0.sel);
ok(pm && pm.c === pdest[0] && pm.r === pdest[1], 'a finger tap marches the stack on the phone', { want: pdest, got: [pm && pm.c, pm && pm.r] });
const shotPhone = await shot('vcmi-gate-phone');
ok(!!shotPhone, 'portrait screenshot written', shotPhone);
const errPhone = await errorsNow();
ok(!errPhone, 'no console errors on the portrait pass', errPhone);

console.log(fails ? `\nGATE FAIL ${fails} assertion(s)` : '\nGATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
