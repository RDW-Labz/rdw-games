#!/usr/bin/env node
// Interaction gate for the Ember Depths port (Flare / Empyrean Campaign card): real CDP mouse on
// the arena floor, state-hook assertions for stride / blade / potion / wave win / loss / restart,
// plus a portrait touch pass. A canvas that merely exists is not proof.
//
// usage: node flare-gate.mjs [site-repo-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/flare-game/index.html';
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
const PROFILE = mkdtempSync('/tmp/flare-gate-');
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
const list = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
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
const clickGround = async (x, z, wait = 700) => {
  const p = await ev(`window.__flare.groundPoint(${x},${z})`);
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(350);
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
    await sleep(150);
  }
  return null;
};

// ---- 1) boot
console.log('boot');
const hookType = await ev('typeof window.__flare');
ok(hookType === 'function', 'the state hook is a function (the catalog gate requires it)', hookType);
const st0 = await ev('window.__flare()');
ok(st0 && !st0.__err, 'the hook answers with state', st0 && st0.__err);
ok(st0.p.hp === 100 && st0.p.potions === 3, 'the delve opens at full vitality with a full belt', { hp: st0.p.hp, potions: st0.p.potions });
ok(st0.wave === 0 && st0.enemies.length + st0.kills === 3, 'wave one fields three imps (the pump has been live, so some may already be down)', { wave: st0.wave, alive: st0.enemies.length, kills: st0.kills });
const kids = await ev('window.__flare.children()');
ok(kids > 8, 'the arena is built (floor, rim, slabs, hero, ring, horde)', kids);
const shotBoot = await shot('flare-gate-boot');
ok(!!shotBoot, 'boot screenshot written', shotBoot);

// ---- 2) stride: a real click on the floor moves the hero
console.log('stride');
const b0 = await ev('window.__flare()');
const tgt = { x: -3.4, z: 1.6 };
await clickGround(tgt.x, tgt.z, 900);
const b1 = await ev('window.__flare()');
const moved = Math.hypot(b1.p.x - b0.p.x, b1.p.z - b0.p.z);
ok(moved > 1.0, 'the hero strides toward the clicked floor point', { from: [b0.p.x, b0.p.z], to: [b1.p.x, b1.p.z], moved: +moved.toFixed(2) });
ok(b1.inputs >= 1 && b1.taps >= 1, 'the pointer event reached the board', { inputs: b1.inputs, taps: b1.taps });
ok(b1.p.steps > 1, 'the stride is measured in the rules', b1.p.steps);
const arrived = await poll(`(()=>{const s=window.__flare();return Math.abs(s.p.x-(${tgt.x}))<0.6 && Math.abs(s.p.z-(${tgt.z}))<0.6 ? s : null})()`, 6000);
ok(!!arrived, 'the hero arrives on the point', arrived && { x: arrived.p.x, z: arrived.p.z });
const shotStride = await shot('flare-gate-stride');

// ---- 3) the blade: an enemy inside reach takes damage from real time alone
console.log('blade');
const bset = await ev(`window.__flare.setup(${JSON.stringify({ seed: 21, enemies: [{ kind: 'skel', x: 1.7, z: 0 }] })})`);
ok(bset && !bset.__err, 'a QA enemy loads beside the hero', bset && bset.__err);
const hurt = await poll(`(()=>{const s=window.__flare();const e=s.enemies[0];return e && e.hp < 26 ? s : null})()`, 4000);
ok(!!hurt, 'the blade strikes without a click', hurt && hurt.enemies[0] && hurt.enemies[0].hp);
const killed = await poll(`(()=>{const s=window.__flare();return s.kills >= 1 ? s : null})()`, 8000);
ok(!!killed, 'the enemy is cut down', killed && killed.kills);
ok(killed && killed.kills === 1, 'the kill is counted', killed && killed.kills);

// ---- 4) potions
console.log('potion');
const pset = await ev(`window.__flare.setup(${JSON.stringify({ seed: 22, hp: 30, enemies: [] })})`);
ok(pset && pset.p.hp === 30 && pset.p.potions === 3, 'a wounded hero loads with an empty floor', { hp: pset && pset.p.hp, potions: pset && pset.p.potions });
await clickEl('potion');
const after = await ev('window.__flare()');
ok(after.p.hp === 70, 'a potion heals forty', { before: 30, after: after.p.hp });
ok(after.p.potions === 2, 'a potion spends a charge', after.p.potions);
await clickEl('potion');
const after2 = await ev('window.__flare()');
ok(after2.p.hp === 100 && after2.p.potions === 1, 'a second potion takes the hero to full', { hp: after2.p.hp, potions: after2.p.potions });

// ---- 5) a wave cleared with one blow wins the delve
console.log('win');
const wset = await ev(`window.__flare.setup(${JSON.stringify({ seed: 23, wave: 4, enemies: [{ kind: 'imp', x: 1.3, z: 0, hp: 1 }] })})`);
ok(wset && !wset.__err && wset.wave === 4, 'the last wave loads with a single dying imp', wset && wset.wave);
const won = await poll('(()=>{const s=window.__flare();return s.over && s.result==="win" ? s : null})()', 9000);
ok(!!won, 'clearing the fifth wave wins the delve', won && won.result);
ok(won && won.sheet === true && /Floor cleared/.test(won.title || ''), 'the win sheet names the result', won && won.title);
const shotWin = await shot('flare-gate-win');

// ---- 6) losing
console.log('lose');
const lset = await ev(`window.__flare.setup(${JSON.stringify({ seed: 24, hp: 8, enemies: [{ kind: 'demon', x: 0.95, z: 0, cd: 0 }] })})`);
ok(lset && !lset.__err && lset.p.hp === 8, 'a nearly-drained hero faces a demon', lset && lset.p.hp);
const lost = await poll('(()=>{const s=window.__flare();return s.over && s.result==="lose" ? s : null})()', 9000);
ok(!!lost, 'the horde drains the hero and the delve ends', lost && lost.result);
ok(lost && lost.sheet === true && /You fall/.test(lost.title || ''), 'the loss sheet names the result', lost && lost.title);
ok(lost && lost.p.hp === 0, 'vitality stops at zero', lost && lost.p.hp);
const shotLose = await shot('flare-gate-lose');

// ---- 7) restart from the sheet, then the R key
console.log('restart');
await clickEl('overBtn');
await sleep(600);
const rst = await ev('window.__flare()');
ok(!rst.over && rst.result === null && rst.sheet === false, 'Delve again clears the sheet', { over: rst.over, sheet: rst.sheet });
ok(rst.p.hp === 100 && rst.p.potions === 3 && rst.wave === 0, 'Delve again fields a fresh hero', { hp: rst.p.hp, potions: rst.p.potions, wave: rst.wave });
ok(rst.enemies.length === 3 && rst.kills === 0, 'the first wave is back with no kills', { n: rst.enemies.length, kills: rst.kills });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(700);
const rst2 = await ev('window.__flare()');
ok(rst2.kills === 0 && rst2.wave === 0 && rst2.p.hp === 100, 'R starts a new delve too', { kills: rst2.kills, hp: rst2.p.hp });
const errMain = await errorsNow();
ok(!errMain, 'no console errors on the desktop pass', errMain);

// ---- 8) the flat forwarder
console.log('forwarder');
await S('Page.navigate', { url: `${base}/games/arcade/flare-game.html` });
await sleep(2200);
const where = await ev('location.pathname');
ok(/\/games\/arcade\/flare-game\/$/.test(where || ''), 'games/arcade/flare-game.html forwards into the port folder', where);

// ---- 9) portrait touch
console.log('portrait');
cdpEvents().length = 0;
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `${base}/${FILE}` });
await sleep(5400);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
};
const p0 = await ev('window.__flare()');
ok(p0 && !p0.__err && p0.enemies.length + p0.kills === 3, 'the hook answers on the phone viewport', p0 && { alive: p0.enemies.length, kills: p0.kills });
const corners = await ev('(()=>[-8,0,8].map(x=>window.__flare.groundPoint(x,0)).concat([window.__flare.groundPoint(0,-8),window.__flare.groundPoint(0,8)]))()');
const inView = corners.every((p) => p && p.x > 2 && p.x < 388 && p.y > 60 && p.y < 800);
ok(inView, 'the whole arena projects inside the phone viewport, clear of both bars', corners);
const pt = await ev('window.__flare.groundPoint(-4, 2)');
await tap(pt);
await sleep(600);
const p1 = await ev('window.__flare()');
const pmoved = Math.hypot(p1.p.x - p0.p.x, p1.p.z - p0.p.z);
ok(pmoved > 0.8, 'a finger tap strides the hero on the phone', +pmoved.toFixed(2));
ok(p1.dups >= 0 && p1.inputs >= 1, 'the touch reached the port', { inputs: p1.inputs, dups: p1.dups });
const shotPhone = await shot('flare-gate-phone');
ok(!!shotPhone, 'portrait screenshot written', shotPhone);
const errPhone = await errorsNow();
ok(!errPhone, 'no console errors on the portrait pass', errPhone);

console.log(fails ? `\nGATE FAIL ${fails} assertion(s)` : '\nGATE PASS');
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
