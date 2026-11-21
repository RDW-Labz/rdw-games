#!/usr/bin/env node
// Interaction gate for the FaFa Runner port (FaFa Runner card, com.chenyifaer.fafarunner):
// real CDP mouse / keyboard / touch on the shipped page, state-hook assertions for lane
// changes, the jump, the slide, shard pickups, the loss, the dawn-gate win, restart, plus a
// 390x844 portrait pass. A canvas that merely exists is not a pass.
//
// usage: node fafa-gate.mjs [site-root]     (default /home/cluer/kaos/work/site)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/fafa-runner/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/fafa-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
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
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const url = `http://127.0.0.1:${port}/${FILE}`;
await S('Page.navigate', { url });
await sleep(5200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(360);
  return b;
};
const keyTap = async (code, key, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  await sleep(160);
};
const st = () => ev('window.__fafa()');
const poll = async (fn, ms = 4000, step = 160) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await fn(); if (s) return s; await sleep(step); }
  return null;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const consoleErrors = () => pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

// ---- 1) boot: the hook is a function and the wall-clock pump is running
const hookType = await ev('typeof window.__fafa');
const s0 = await st();
await sleep(1400);
const s1 = await st();
const shotBoot = await shot('fafa-gate-boot');
T('boot ' + JSON.stringify({ hookType, dist0: s0 && s0.dist, dist1: s1 && s1.dist, hp: s1 && s1.hp, objs: s1 && s1.objs, kinds: s1 && s1.kinds && s1.kinds.slice(0, 6) }));

// ---- 2) real clicks on the road: lane left, then lane right
const pL = await ev('window.__fafa.lanePoint(0)');
await click(pL); await sleep(260);
const sL = await st();
const pR = await ev('window.__fafa.lanePoint(2)');
await click(pR); await sleep(240);
await click(pR); await sleep(260);
const sR = await st();
T('lanes ' + JSON.stringify({ pL, sL: sL && sL.lane, pR, sR: sR && sR.lane, dups: sR && sR.dups, taps: sR && sR.taps }));

// ---- 3) tap the middle to jump, and read the arc out of the hook
const pJ = await ev('window.__fafa.jumpPoint()');
await click(pJ);
const sAir = await poll(async () => { const s = await st(); return s && s.y > 0.3 ? s : null; }, 2500, 100);
const sLanded = await poll(async () => { const s = await st(); return s && s.y === 0 && s.jumps > 0 ? s : null; }, 3000, 140);
const shotJump = await shot('fafa-gate-jump');
T('jump ' + JSON.stringify({ pJ, air: sAir && { y: sAir.y, vy: sAir.vy, jumps: sAir.jumps }, landed: sLanded && { y: sLanded.y, jumps: sLanded.jumps } }));

// ---- 4) keyboard slide under an overhead branch (QA position, branch 7m ahead)
await ev('window.__fafa.setup({dist: 150, hp: 3, spawn: [{kind: "branch", lane: 1, ahead: 7}]})');
await sleep(140);
const sPre = await st();
await keyTap('ArrowDown', 's', 40);
const sSlide = await st();
const sClear = await poll(async () => { const s = await st(); return s && s.hits === 0 && s.dist > 158 ? s : null; }, 3000, 160);
T('slide ' + JSON.stringify({ pre: sPre && sPre.dist, slides: sSlide && sSlide.slides, slideT: sSlide && sSlide.slideT, hits: sClear && sClear.hits }));

// ---- 5) shards: a real tap into the shard lane, then they are collected
await ev('window.__fafa.setup({dist: 200, lane: 0, spawn: [{kind: "shard", lane: 0, ahead: 8}, {kind: "shard", lane: 0, ahead: 11}]})');
await sleep(120);
const sPick = await poll(async () => { const s = await st(); return s && s.shards >= 2 ? s : null; }, 4000, 140);
T('shards ' + JSON.stringify({ shards: sPick && sPick.shards }));

// ---- 6) loss: one heart, a log in the lane. Straight into the sheet.
await ev('window.__fafa.setup({dist: 300, hp: 1, lane: 1, spawn: [{kind: "log", lane: 1, ahead: 7}]})');
await sleep(120);
const sLose = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 5000, 180);
const shotLose = await shot('fafa-gate-lose');
T('lose ' + JSON.stringify({ over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, title: sLose && sLose.title, sheet: sLose && sLose.sheet }));

// ---- 7) restart from the sheet (a real click on the sheet's own button)
await clickEl('overBtn');
const sNew = await st();
T('restart ' + JSON.stringify({ dist: sNew && sNew.dist, hp: sNew && sNew.hp, shards: sNew && sNew.shards, sheet: sNew && sNew.sheet }));

// ---- 8) win: the dawn gate at the end of the road
await ev('window.__fafa.setup({dist: 870})');
await sleep(140);
const sWin = await poll(async () => { const s = await st(); return s && s.over ? s : null; }, 6000, 180);
const shotWin = await shot('fafa-gate-win');
T('win ' + JSON.stringify({ over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, key: sWin && sWin.key, title: sWin && sWin.title, sheet: sWin && sWin.sheet }));

// ---- 9) the R key restarts from the win sheet
await keyTap('KeyR', 'r', 82);
await sleep(320);
const sRKey = await st();
T('r-key ' + JSON.stringify({ dist: sRKey && sRKey.dist, over: sRKey && sRKey.over, sheet: sRKey && sRKey.sheet }));

// ---- 10) a playable-looking board: obstacles + shards ahead, screenshot for the tile art
await ev('window.__fafa.setup({dist: 420, spawn: [{kind: "log", lane: 0, ahead: 9}, {kind: "shard", lane: 2, ahead: 7}, {kind: "branch", lane: 1, ahead: 17}]})');
await sleep(500);
const sBoard = await st();
const shotBoard = await shot('fafa-gate-board');
T('board ' + JSON.stringify({ kinds: sBoard && sBoard.kinds, lane: sBoard && sBoard.lane }));

const errors1 = consoleErrors();

// ---- 11) portrait touch
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(5200);
const tapAt = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
const t0 = await st();
const tpL = await ev('window.__fafa.lanePoint(0)');
await tapAt(tpL);
const t1 = await st();
const tpJ = await ev('window.__fafa.jumpPoint()');
await tapAt(tpJ);
const tAir = await poll(async () => { const s = await st(); return s && s.y > 0.3 ? s : null; }, 2500, 100);
const shotTouch = await shot('fafa-gate-touch');
const lane0 = await ev('window.__fafa.lanePoint(0)');
const lane2 = await ev('window.__fafa.lanePoint(2)');
T('touch ' + JSON.stringify({ t0: t0 && t0.lane, t1: t1 && t1.lane, air: tAir && tAir.y, tpL, tpJ, lane0, lane2 }));
const errors2 = consoleErrors().split(' | ').filter((e) => e && !errors1.includes(e)).join(' | ');

const checks = {
  bootHook: hookType === 'function' && !!s0 && s0.over === false && s0.hp === 3,
  clockRuns: !!s1 && s1.dist > s0.dist && s1.dist < 60,
  obstaclesSpawn: !!s1 && s1.objs > 2 && (s1.kinds.includes('log') || s1.kinds.includes('branch')),
  laneLeft: !!sL && sL.lane === 0 && sL.inputs >= 1,
  laneRight: !!sR && sR.lane === 2 && sR.inputs >= 2,
  tapPointSane: !!pL && pL.x < 1280 * 0.3 && pL.y > 0 && pL.y < 800 && !!pR && pR.x > 1280 * 0.7,
  jumped: !!sAir && sAir.jumps === 1 && sAir.y > 0.3,
  landed: !!sLanded && sLanded.y === 0,
  slid: !!sSlide && sSlide.slides === 1 && sSlide.slideT > 0.1,
  clearedBranch: !!sClear && sClear.hits === 0 && sClear.hp === 3,
  shardsPicked: !!sPick && sPick.shards >= 2,
  lost: !!sLose && sLose.over === true && sLose.won === false && sLose.hp === 0 && sLose.sheet === true && /run ends/i.test(sLose.title),
  restarted: !!sNew && sNew.dist < 30 && sNew.hp === 3 && sNew.shards === 0 && sNew.sheet === false && sNew.over === false,
  won: !!sWin && sWin.over === true && sWin.won === true && sWin.why === 'dawn' && sWin.sheet === true && /dawn legend/i.test(sWin.title),
  keyRestart: !!sRKey && sRKey.dist < 30 && sRKey.over === false && sRKey.sheet === false,
  boardLive: !!sBoard && sBoard.kinds.length >= 3 && sBoard.over === false,
  touchLane: !!t1 && t1.lane === 0 && t1.inputs >= 1,
  touchJump: !!tAir && tAir.y > 0.3,
  touchPointsOnScreen: !!tpL && tpL.x > 6 && tpL.x < 384 && tpL.y > 6 && tpL.y < 838 &&
    !!lane0 && lane0.x < 390 * 0.3 && !!lane2 && lane2.x > 390 * 0.7 && !!tpJ && tpJ.x > 100 && tpJ.x < 290,
  noErrors: !errors1 && !errors2,
};

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({
  checks, failed, errors1, errors2,
  s0: { dist: s0 && s0.dist, hp: s0 && s0.hp, objs: s0 && s0.objs },
  s1: { dist: s1 && s1.dist, objs: s1 && s1.objs, kinds: s1 && s1.kinds },
  pL, pR, pJ, sL: { lane: sL && sL.lane, inputs: sL && sL.inputs }, sR: { lane: sR && sR.lane, inputs: sR && sR.inputs },
  sAir: { y: sAir && sAir.y, jumps: sAir && sAir.jumps }, sLanded: { y: sLanded && sLanded.y },
  sSlide: { slides: sSlide && sSlide.slides, slideT: sSlide && sSlide.slideT }, sClear: { hits: sClear && sClear.hits, hp: sClear && sClear.hp },
  sPick: { shards: sPick && sPick.shards },
  sLose: { over: sLose && sLose.over, won: sLose && sLose.won, why: sLose && sLose.why, title: sLose && sLose.title },
  sNew: { dist: sNew && sNew.dist, hp: sNew && sNew.hp, shards: sNew && sNew.shards, sheet: sNew && sNew.sheet },
  sWin: { over: sWin && sWin.over, won: sWin && sWin.won, why: sWin && sWin.why, title: sWin && sWin.title },
  sRKey: { dist: sRKey && sRKey.dist, over: sRKey && sRKey.over },
  sBoard: { kinds: sBoard && sBoard.kinds },
  t0: t0 && { lane: t0.lane, dist: t0.dist }, t1: t1 && { lane: t1.lane, inputs: t1.inputs }, tAir: tAir && { y: tAir.y },
  tpL, tpJ, lane0, lane2,
  shots: [shotBoot, shotJump, shotLose, shotWin, shotBoard, shotTouch],
}, null, 0));
console.log(failed.length ? 'GATE FAIL' : 'GATE PASS');
proc.kill('SIGKILL'); server.close();
process.exit(failed.length ? 1 : 0);
