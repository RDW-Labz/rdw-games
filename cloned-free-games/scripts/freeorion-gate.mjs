#!/usr/bin/env node
// Interaction gate for the FreeOrion port. Real CDP mouse clicks on the starmap, with every
// assertion read from the page's own state hook: pick a star, order a lane, end the turn and watch
// the fleet arrive, settle an unclaimed world with the colony button, take an enemy world by orbit,
// a win on the rival capital, a loss on your own, the end sheet's own button, and a portrait touch.
// usage: node freeorion-gate.mjs [site-root] [shot-prefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PREFIX = process.argv[3] || 'freeorion-gate';
const FILE = 'games/arcade/freeorion/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
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
const PROFILE = mkdtempSync('/tmp/freeorion-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { T('fatal ' + (e && e.message)); kill(); process.exit(1); });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 90000);
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
const until = async (fn, ms = 20000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
const booted = await until(async () => (await ev('typeof window.__freeorion')) === 'function', 60000, 400);
T('boot hook after poll: ' + booted);
await sleep(1500);

const click = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return pt;
};
const pointOf = (id) => ev(`window.__freeorion.starPoint(${id})`);
const clickStar = async (id, wait = 260) => { const p = await pointOf(id); await click(p); await sleep(wait); return p; };
const clickEl = async (id, wait = 320) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled};})()`);
  await click(b);
  await sleep(wait);
  return b;
};
const H = () => ev('window.__freeorion()');
const ST = () => ev('window.__freeorion.state()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const SHOTS = {};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  SHOTS[name] = out;
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__freeorion');
const h0 = await H();
const s0 = await ST();
const sheet0 = await sheet();
T('boot ' + JSON.stringify({ hookType, systems: s0 && s0.systems.length, worlds: h0 && h0.worlds, pp: h0 && h0.pp, turn: h0 && h0.turn }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(s0 && s0.systems.length === 13, 'the galaxy carries thirteen stars', s0 && s0.systems.length);
ok(h0 && h0.worlds.mine === 3 && h0.worlds.theirs === 3 && h0.worlds.neutral === 7, 'the opening is 3-3-7', h0 && h0.worlds);
ok(h0 && h0.pp[0] === 6 && h0.turn === 0 && h0.round === 1, 'your first turn opens with six industry', h0 && { pp: h0.pp, turn: h0.turn, round: h0.round });
ok(h0 && h0.over === false, 'the campaign is live at boot');
ok(sheet0 && sheet0.open === false, 'no end sheet at boot', sheet0);
const shotBoot = await shot(`${PREFIX}-boot`);

// the picker round-trip: a star's screen point must pick that star back
const roundTrip = await ev(`(() => {
  const ids = window.__freeorion.state().systems.map((s) => s.id);
  const out = ids.map((id) => { const p = window.__freeorion.starPoint(id); const b = p ? window.__freeorion.pickAt(p.x, p.y) : null; return b === id; });
  return { total: out.length, good: out.filter(Boolean).length };
})()`);
ok(roundTrip && roundTrip.good === roundTrip.total, 'every star picks back to itself (screen point -> star)', roundTrip);

// ---------- 2) pick a stack, order a lane, end the turn, watch it arrive ----------
const cap = s0.cap[0];
const lane = s0.systems[cap].links[0];
await clickStar(cap, 320);
const hSel = await H();
ok(hSel.sel === cap, 'a real click picks up the fleets at your capital', { sel: hSel.sel, want: cap });
ok(hSel.inputs >= 1 && hSel.taps >= 1, 'the accepted-tap counter moved', { inputs: hSel.inputs, taps: hSel.taps });
const shotSel = await shot(`${PREFIX}-select`);

const before = await ST();
const fleetsAtCap = before.fleets.filter((f) => f.owner === 0 && f.at === cap).length;
await clickStar(lane, 400);
const hOrder = await H();
T('order ' + JSON.stringify({ lane, orders: hOrder.orders, sel: hOrder.sel }));
ok(hOrder.orders.length === fleetsAtCap && hOrder.orders.every((o) => o.to === lane), 'tapping a linked star gives every fleet at the capital that one order', hOrder.orders);
ok(hOrder.sel === null, 'the hand empties once the order is placed');
const shotOrder = await shot(`${PREFIX}-order`);

const ppBefore = hOrder.pp[0];
await clickEl('end', 600);
const afterTurn = await H();
const sAfter = await ST();
T('end turn ' + JSON.stringify({ round: afterTurn.round, pp: [ppBefore, afterTurn.pp[0]], worlds: afterTurn.worlds, atLane: sAfter.fleets.filter((f) => f.owner === 0 && f.at === lane).length, lastRound: afterTurn.lastRound }));
ok(afterTurn.round === 2, 'End turn advances the round', afterTurn.round);
ok(sAfter.fleets.filter((f) => f.owner === 0 && f.at === lane).length === fleetsAtCap,
  'the ordered fleets are orbiting the destination after the turn resolves', { at: sAfter.fleets.filter((f) => f.owner === 0).map((f) => f.at) });
ok(afterTurn.pp[0] > ppBefore, 'industry is collected at the end of the round', { before: ppBefore, after: afterTurn.pp[0] });
ok(afterTurn.over === false, 'one round does not end the campaign');
const shotPlay = await shot(`${PREFIX}-play`);

// ---------- 3) a colony ship settles an unclaimed world (real click on Settle) ----------
{
  const st = await ST();
  const neutral = st.systems.filter((s) => s.owner === -1).map((s) => s.id);
  const capId = st.cap[0];
  const own = {}; own[capId] = 0; own[st.cap[1]] = 1;
  // your capital plus its nearest three worlds, everything else unclaimed
  const mine = [capId, ...st.systems[capId].links];
  for (const id of mine) own[id] = 0;
  own[st.cap[1]] = 1;
  const free = st.systems.find((s) => s.links.includes(capId) && s.owner === -1 && s.id !== st.cap[1]);
  const fleets = [{ owner: 0, at: capId, ships: 3, kind: 'war' }, { owner: 0, at: capId, ships: 1, kind: 'colony' },
    { owner: 1, at: st.cap[1], ships: 4, kind: 'war' }];
  // park the colony ship on a world nobody owns
  const target = free ? free.id : neutral.find((id) => id !== st.cap[1]);
  fleets.push({ owner: 0, at: target, ships: 1, kind: 'colony' });
  const built = await ev(`window.__freeorion.setup(${JSON.stringify({ own, cap: st.cap, fleets, pp: [12, 12] })})`);
  await sleep(700);
  const hPre = await H();
  T('settle fixture ' + JSON.stringify({ built, target, canSettle: hPre.canSettle, mine: hPre.worlds.mine }));
  ok(built && built.over === false, 'the settle fixture is a live game', built);
  ok(hPre.canSettle === true, 'the page offers Settle with a colony ship over an unclaimed world');
  const settleBtn = await clickEl('settle', 500);
  const hPost = await H();
  const sPost = await ST();
  T('settled ' + JSON.stringify({ target, owner: sPost.systems[target].owner, mine: [hPre.worlds.mine, hPost.worlds.mine], settles: hPost.settles }));
  ok(!settleBtn.disabled, 'the Settle button is enabled when a colony ship is in orbit');
  ok(sPost.systems[target].owner === 0, 'the world is yours after the click', sPost.systems[target]);
  ok(hPost.worlds.mine === hPre.worlds.mine + 1 && hPost.settles === 1, 'the accepted settle is counted once', { before: hPre.worlds.mine, after: hPost.worlds.mine, settles: hPost.settles });
  const shotSettle = await shot(`${PREFIX}-settle`);
}

// ---------- 4) taking an enemy world by holding its orbit ----------
{
  const st = await ST();
  const capId = st.cap[0], enemyCap = st.cap[1];
  // a rival world one lane from your capital, held by a single ship
  const target = st.systems[capId].links.find((id) => id !== enemyCap) ?? st.systems.find((s) => s.id !== capId && s.id !== enemyCap).id;
  const own = { [capId]: 0, [enemyCap]: 1, [target]: 1 };
  const fleets = [
    { owner: 0, at: capId, ships: 6, kind: 'war' },
    { owner: 1, at: enemyCap, ships: 3, kind: 'war' },
    { owner: 1, at: target, ships: 1, kind: 'war' },
  ];
  const built = await ev(`window.__freeorion.setup(${JSON.stringify({ own, cap: [capId, enemyCap], fleets, pp: [20, 20] })})`);
  await sleep(700);
  const hPre = await H();
  const strength = await ev(`(() => ({ mine: window.__freeorion.strength(${capId}, 0), theirs: window.__freeorion.strength(${target}, 1) }))()`);
  T('capture fixture ' + JSON.stringify({ built, capId, target, enemyCap, strength, worlds: hPre.worlds, linked: (await ST()).systems[capId].links }));
  ok(built && built.over === false, 'the capture fixture is a live game', built);
  ok(hPre.worlds.mine === 1 && hPre.worlds.theirs === 2, 'the capture fixture holds one world each side of the fight', hPre.worlds);
  ok(strength && strength.mine === 9 && strength.theirs === 2, 'six hulls over your capital (nine with its bonuses) face a lone defender', strength);
  // send the six-ship stack onto the rival world
  await clickStar(capId, 300);
  await clickStar(target, 400);
  const hOrder2 = await H();
  T('capture order ' + JSON.stringify(hOrder2.orders));
  ok(hOrder2.orders.length === 1 && hOrder2.orders[0].to === target, 'the order onto the rival world is accepted', hOrder2.orders);
  await clickEl('end', 700);
  const sPost = await ST();
  const hPost = await H();
  T('capture result ' + JSON.stringify({ targetOwner: sPost.systems[target].owner, worlds: hPost.worlds, log: sPost.log }));
  ok(sPost.systems[target].owner === 0, 'uncontested orbit flips the rival world to you', sPost.systems[target]);
  ok(hPost.worlds.mine === 2, 'the empire grew by the captured world', hPost.worlds);
  const shotCapture = await shot(`${PREFIX}-capture`);
}

// ---------- 5) a win on the rival capital ----------
{
  const st = await ST();
  const capId = st.cap[0], enemyCap = st.cap[1];
  const staging = st.systems[enemyCap].links[0];
  const own = { [capId]: 0, [staging]: 0, [enemyCap]: 1 };
  const fleets = [
    { owner: 0, at: capId, ships: 2, kind: 'war' },
    { owner: 0, at: staging, ships: 9, kind: 'war' },
    { owner: 1, at: enemyCap, ships: 2, kind: 'war' },
  ];
  const built = await ev(`window.__freeorion.setup(${JSON.stringify({ own, cap: [capId, enemyCap], fleets, pp: [20, 20] })})`);
  await sleep(700);
  const hPre = await H();
  T('win fixture ' + JSON.stringify({ built, staging, worlds: hPre.worlds }));
  ok(built && built.over === false, 'the win fixture is a live game', built);
  await clickStar(staging, 300);
  await clickStar(enemyCap, 500);
  await clickEl('end', 900);
  const hWin = await H();
  const winSheet = await sheet();
  T('win ' + JSON.stringify({ over: hWin.over, result: hWin.result, why: hWin.why, worlds: hWin.worlds, sheet: winSheet && winSheet.title }));
  ok(hWin.over === true && hWin.result === 'win', 'taking the rival capital wins the campaign', { over: hWin.over, result: hWin.result, why: hWin.why });
  ok(winSheet && winSheet.open && /yours|capital|rival/i.test(winSheet.title), 'the win sheet opens with its own title', winSheet);
  const shotWin = await shot(`${PREFIX}-win`);
}

// ---------- 6) a loss on your own capital, then the sheet's own button ----------
{
  const st = await ST();
  const capId = st.cap[0], enemyCap = st.cap[1];
  const staging = st.systems[capId].links[0];
  const own = { [capId]: 0, [staging]: 1, [enemyCap]: 1 };
  const fleets = [
    { owner: 0, at: capId, ships: 1, kind: 'war' },
    { owner: 1, at: staging, ships: 9, kind: 'war' },
  ];
  const built = await ev(`window.__freeorion.setup(${JSON.stringify({ own, cap: [capId, enemyCap], fleets, pp: [4, 20] })})`);
  await sleep(700);
  const hPre = await H();
  T('lose fixture ' + JSON.stringify({ built, worlds: hPre.worlds }));
  ok(built && built.over === false, 'the loss fixture is a live game', built);
  await clickEl('end', 900);
  const hLose = await H();
  const loseSheet = await sheet();
  T('lose ' + JSON.stringify({ over: hLose.over, result: hLose.result, why: hLose.why, worlds: hLose.worlds, sheet: loseSheet && loseSheet.title }));
  ok(hLose.over === true && hLose.result === 'lose', 'the rival takes your capital and the campaign ends in defeat', { over: hLose.over, result: hLose.result, why: hLose.why });
  ok(loseSheet && loseSheet.open && /fallen|gone|rival/i.test(loseSheet.title), 'the loss sheet opens with its own title', loseSheet);
  const shotLose = await shot(`${PREFIX}-lose`);

  await clickEl('overBtn', 900);
  const hRestart = await H();
  const restartedSheet = await sheet();
  ok(hRestart.over === false && hRestart.round === 1 && hRestart.worlds.mine === 3, 'Play again deals a fresh galaxy', { over: hRestart.over, round: hRestart.round, worlds: hRestart.worlds });
  ok(restartedSheet && restartedSheet.open === false, 'the sheet closes on restart', restartedSheet);
}

// ---------- 7) portrait touch pass ----------
{
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(1400);
  const geom = await ev(`(() => {
    const st = window.__freeorion.state();
    const top = document.querySelector('.top').getBoundingClientRect();
    const bot = document.querySelector('.bottom').getBoundingClientRect();
    const pts = st.systems.map((s) => window.__freeorion.starPoint(s.id));
    return { top: top.bottom, bot: bot.top, pts };
  })()`);
  const inside = geom.pts.every((p) => p && p.x > 4 && p.x < 386 && p.y > geom.top - 6 && p.y < geom.bot + 6);
  T('portrait ' + JSON.stringify({ top: geom.top, bot: geom.bot, first: geom.pts[0], last: geom.pts[12] }));
  ok(inside, 'every star projects into the band the hud leaves on a 390x844 phone', { top: geom.top, bot: geom.bot, pts: geom.pts });
  // prime the emulation with one neutral press, then a real finger tap on a star
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: Math.round(geom.top) + 6, id: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const st1 = await ST();
  const capId = st1.cap[0];
  const pCap = await pointOf(capId);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pCap.x, y: pCap.y, id: 2 }] });
  await sleep(80);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
  let hTouch = await H();
  if (hTouch.sel !== capId) {
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pCap.x, y: pCap.y, id: 3 }] });
    await sleep(90);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(450);
    hTouch = await H();
  }
  ok(hTouch.sel === capId, 'a finger tap picks up the capital fleets on the portrait map', { sel: hTouch.sel, want: capId, point: pCap });
  const shotPortrait = await shot(`${PREFIX}-portrait`);
}

// ---------- 8) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 240));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the whole run', errText);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + Object.entries(SHOTS).map(([k, v]) => k + '=' + v).join(' '));
if (fails.length) { console.error(`\nFREEORION GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('FREEORION GATE PASS');
