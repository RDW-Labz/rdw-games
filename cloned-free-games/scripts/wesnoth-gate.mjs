#!/usr/bin/env node
// Interaction gate for the Wesnoth port. Real CDP mouse clicks on the hex field, every assertion read
// from the page's own state hook: a unit lifted and marched for its real move cost, a village taken
// (income + HUD), a blow struck on an adjacent orc, a recruit bought beside the keep, the cpu's turn
// resolved after End turn, a win and a loss reached by play, the end sheet's own button, and a
// 390x844 touch pass. Also refuses console exceptions.
//
// usage: node wesnoth-gate.mjs [site-root] [shot-prefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PREFIX = process.argv[3] || 'wesnoth-gate';
const FILE = 'games/arcade/wesnoth/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 180000);
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
const PROFILE = mkdtempSync('/tmp/wesnoth-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
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
const until = async (fn, ms = 30000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

const cleanup = () => { try { proc.kill('SIGKILL'); } catch {} try { server.close(); } catch {} };
process.on('unhandledRejection', (e) => { T('UNHANDLED ' + (e && e.message)); cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

const booted = await until(async () => (await ev('typeof window.__wesnoth')) === 'function', 60000, 400);
T('boot hook after poll: ' + booted);
await sleep(900);

const click = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return pt;
};
const tap = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await sleep(80);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return pt;
};
const pointOf = (q, r) => ev(`window.__wesnoth.hexPoint(${q}, ${r})`);
const clickHex = async (q, r, wait = 260) => { const p = await pointOf(q, r); await click(p); await sleep(wait); return p; };
const clickEl = async (id, wait = 350) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled};})()`);
  await click(b);
  await sleep(wait);
  return b;
};
const H = () => ev('window.__wesnoth()');
const st = () => ev('window.__wesnoth.state()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const hud = () => ev(`(()=>({gold:document.getElementById('gold').textContent,vill:document.getElementById('vill').textContent,army:document.getElementById('army').textContent,round:document.getElementById('round').textContent}))()`);
const reset = async (seed = 20261127) => { await ev(`window.__wesnoth.newGame(${seed})`); await sleep(500); };
const SHOTS = {};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  SHOTS[name] = out;
  return out;
};

// page-side geometry helpers: pick a pair of passable hexes `d` apart, and the units near a village
const findPair = (d) => ev(`(() => {
  const t = window.__wesnoth.state().tiles.filter((x) => x.t !== 'w' && x.t !== 'm');
  const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
  for (const a of t) for (const b of t) if (hd(a, b) === ${d}) return { a: { q: a.q, r: a.r }, b: { q: b.q, r: b.r } };
  return null;
})()`);
const findVillage = () => ev(`(() => {
  const ts = window.__wesnoth.state().tiles;
  const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
  const v = ts.find((x) => x.t === 'v');
  const nb = ts.filter((x) => x.t !== 'w' && x.t !== 'm' && hd(x, v) === 1)[0];
  return { v: { q: v.q, r: v.r }, nb: { q: nb.q, r: nb.r } };
})()`);
// a hex with at least two passable neighbours, far from both keeps: the duelling-yard fixture
const duelYard = () => ev(`(() => {
  const ts = window.__wesnoth.state().tiles;
  const ok = (x) => x && x.t !== 'w' && x.t !== 'm';
  const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
  const keeps = [{ q: 5, r: 6 }, { q: 2, r: 0 }];
  for (const b of ts) {
    if (!ok(b) || keeps.some((k) => hd(k, b) < 4)) continue;
    const nb = ts.filter((x) => ok(x) && hd(x, b) === 1);
    if (nb.length >= 2) return { a: { q: nb[0].q, r: nb[0].r }, b: { q: b.q, r: b.r }, c: { q: nb[1].q, r: nb[1].r } };
  }
  return null;
})()`);

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__wesnoth');
const h0 = await H();
const s0 = await st();
const sheet0 = await sheet();
const hud0 = await hud();
const shotBoot = await shot(`${PREFIX}-boot`);
T('boot ' + JSON.stringify({ hookType, tiles: s0 && s0.tiles.length, turn: h0 && h0.turn, gold: h0 && h0.gold, army: h0 && h0.army }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(s0 && s0.tiles.length === 77, 'the field carries 77 hexes', s0 && s0.tiles.length);
ok(h0 && h0.turn === 0 && h0.round === 1, 'the visitor moves first on round 1', { turn: h0 && h0.turn, round: h0 && h0.round });
ok(h0 && h0.gold[0] === 24 && h0.gold[1] === 22, 'the purses open at 24 / 22', h0 && h0.gold);
ok(h0 && h0.army[0] === 3 && h0.army[1] === 3 && h0.units.length === 6, 'three troops a side', h0 && h0.army);
ok(hud0 && hud0.gold === '24' && hud0.vill === '0 : 0' && hud0.army === '3 : 3', 'the HUD reads the same numbers', hud0);
ok(sheet0 && sheet0.open === false, 'no end sheet at boot', sheet0);
ok(h0 && h0.over === false, 'the game is live at boot');

// the picker round-trip: a hex's screen point must pick that hex back
const roundTrip = await ev(`(() => {
  const ts = window.__wesnoth.state().tiles;
  let good = 0, n = 0;
  for (const t of ts) {
    const p = window.__wesnoth.hexPoint(t.q, t.r);
    if (!p) continue;
    n++;
    const b = window.__wesnoth.pickAt(p.x, p.y);
    if (b && b.q === t.q && b.r === t.r) good++;
  }
  return { n, good };
})()`);
ok(roundTrip && roundTrip.good === roundTrip.n, 'every hex picks back to itself (screen point -> hex)', roundTrip);

// ---------- 2) lift a unit and march it ----------
const spear = s0.units.find((u) => u.kind === 'spearman');
const rc = await ev(`window.__wesnoth.reach(${spear.id})`);
const dest = rc.filter((c) => c.cost >= 1 && !s0.tiles.some((t) => t.t === 'v' && t.q === c.q && t.r === c.r))
  .sort((a, b) => b.cost - a.cost)[0];
ok(!!dest, 'a march destination exists', dest);
await clickHex(spear.q, spear.r, 300);
const hLift = await H();
ok(hLift.sel === spear.id && hLift.inputs >= 1, 'a real click lifts the unit (selected, tap counted)', { sel: hLift.sel, inputs: hLift.inputs });
const shotLift = await shot(`${PREFIX}-lift`);
await clickHex(dest.q, dest.r, 420);
const after = await st();
const moved = after.units.find((u) => u.id === spear.id);
ok(moved && moved.q === dest.q && moved.r === dest.r, 'a real click marches the unit onto the chosen hex',
  { want: dest, got: moved && [moved.q, moved.r] });
ok(moved && moved.mp === spear.mp - dest.cost, 'the march spent exactly the path cost', { mp: moved && moved.mp, cost: dest.cost });
const shotMarch = await shot(`${PREFIX}-march`);

// ---------- 3) take a village ----------
const vf = await findVillage();
await ev(`window.__wesnoth.setup(${JSON.stringify({
  units: [{ side: 0, kind: 'horseman', q: vf.nb.q, r: vf.nb.r }, { side: 0, kind: 'commander', q: 5, r: 6 }, { side: 1, kind: 'warlord', q: 2, r: 0 }],
  gold: [24, 22],
})})`);
await sleep(400);
const beforeV = await hud();
await clickHex(vf.nb.q, vf.nb.r, 300);
await clickHex(vf.v.q, vf.v.r, 420);
const vState = await st();
const vTile = vState.tiles.find((t) => t.t === 'v' && t.q === vf.v.q && t.r === vf.v.r);
const afterV = await hud();
ok(vTile && vTile.owner === 0, 'marching onto an unclaimed village takes it for you', vTile && vTile.owner);
ok(afterV && afterV.vill === '1 : 0', 'the village counter follows the flag', afterV && afterV.vill);
const inc = await ev('window.__wesnoth.income(0)');
ok(inc === 4, 'a held village pays 2 more a turn', inc);
ok(beforeV && beforeV.vill === '0 : 0', 'the village was unclaimed before the march', beforeV && beforeV.vill);

// ---------- 4) strike an adjacent orc ----------
const adj = await findPair(1);
await ev(`window.__wesnoth.setup(${JSON.stringify({
  units: [{ side: 0, kind: 'spearman', q: adj.a.q, r: adj.a.r }, { side: 1, kind: 'grunt', q: adj.b.q, r: adj.b.r },
    { side: 0, kind: 'commander', q: 5, r: 6 }, { side: 1, kind: 'warlord', q: 2, r: 0 }],
  gold: [24, 22],
})})`);
await sleep(400);
const s4 = await st();
const sp4 = s4.units.find((u) => u.kind === 'spearman');
const gr4 = s4.units.find((u) => u.kind === 'grunt');
await clickHex(sp4.q, sp4.r, 300);
const hSel4 = await H();
ok(hSel4.sel === sp4.id, 'the spearman is selected for the blow', hSel4.sel);
await clickHex(gr4.q, gr4.r, 500);
const s4b = await st();
const gr4b = s4b.units.find((u) => u.id === gr4.id);
const sp4b = s4b.units.find((u) => u.id === sp4.id);
ok(!gr4b || gr4b.hp < gr4.hp, 'the blow drew blood on the orc', { before: gr4.hp, after: gr4b && gr4b.hp });
ok(sp4b && sp4b.acted === true, 'striking spent the spearman for the turn', sp4b && sp4b.acted);
const shotStrike = await shot(`${PREFIX}-strike`);

// ---------- 5) recruit beside the keep ----------
await reset();
const beforeR = await H();
const rBtn = await clickEl('r-spearman', 450);
const afterR = await H();
ok(!rBtn.disabled, 'the recruit button is live at boot', rBtn);
ok(afterR.army[0] === beforeR.army[0] + 1, 'a recruit joins the army', { before: beforeR.army[0], after: afterR.army[0] });
ok(afterR.gold[0] === beforeR.gold[0] - 14, 'the recruit cost 14 gold', { before: beforeR.gold[0], after: afterR.gold[0] });
const recruit = afterR.units.filter((u) => u.side === 0).sort((a, b) => b.id - a.id)[0];
ok(recruit && recruit.acted === true, 'the fresh recruit cannot also act this turn', recruit && recruit.acted);

// ---------- 6) the cpu's turn ----------
await reset();
const beforeT = await st();
await clickEl('end', 500);
const busy = await H();
ok(busy.turn === 1 || busy.aiBusy === true, 'End turn hands the field to the cpu', { turn: busy.turn, aiBusy: busy.aiBusy });
const back = await until(async () => { const h = await H(); return h.turn === 0 && !h.aiBusy && h.round === 2; }, 40000, 400);
ok(!!back, 'the cpu resolves its whole turn and hands the field back (round 2)');
const afterT = await st();
const movedCount = afterT.units.filter((u) => {
  const b = beforeT.units.find((x) => x.id === u.id);
  return b && (b.q !== u.q || b.r !== u.r);
}).length;
const hurtCount = afterT.units.filter((u) => {
  const b = beforeT.units.find((x) => x.id === u.id);
  return b && u.hp < b.hp;
}).length;
ok(movedCount >= 1 || hurtCount >= 1, 'the cpu actually marched or struck on its turn', { movedCount, hurtCount });
const hudT = await hud();
ok(hudT && hudT.round === '2', 'the HUD round follows the turn cycle', hudT && hudT.round);

// ---------- 7) a win reached by play ----------
const yard = await duelYard();
ok(!!yard, 'a duelling yard exists (a hex with two free neighbours, far from the keeps)', yard);
let hW = null, sheetW = null, attempt = 0;
while ((!hW || hW.result !== 'win') && attempt < 4) {
  attempt++;
  await ev(`window.__wesnoth.setup(${JSON.stringify({
    seed: 300 + attempt,
    units: [
      { side: 0, kind: 'horseman', q: yard.a.q, r: yard.a.r },
      { side: 0, kind: 'spearman', q: yard.c.q, r: yard.c.r },
      { side: 0, kind: 'commander', q: 5, r: 6 },
      { side: 1, kind: 'warlord', q: yard.b.q, r: yard.b.r, hp: 3 },
      { side: 1, kind: 'grunt', q: 0, r: 0, acted: true },
    ],
    gold: [24, 22],
  })})`);
  await sleep(350);
  const sW = await st();
  const hor = sW.units.find((u) => u.kind === 'horseman');
  const spW = sW.units.find((u) => u.kind === 'spearman');
  const lord = sW.units.find((u) => u.kind === 'warlord');
  await clickHex(hor.q, hor.r, 260);
  await clickHex(lord.q, lord.r, 650);
  let h = await H();
  if (!h.over) {                       // a miss sends in the second attacker
    await clickHex(spW.q, spW.r, 260);
    await clickHex(lord.q, lord.r, 750);
    h = await H();
  }
  sheetW = await sheet();
  if (h.over) hW = h;
  T('win attempt ' + attempt + ': ' + JSON.stringify({ over: h.over, result: h.result, why: h.why }));
}
ok(hW && hW.over === true && hW.result === 'win', 'killing the warlord wins the battle', hW && { over: hW.over, result: hW.result, why: hW.why });
ok(!!hW && /field is yours/i.test(sheetW.title), 'the win sheet opens with its own words', sheetW);
const shotWin = await shot(`${PREFIX}-win`);
const pathBefore = await ev('location.pathname');
await clickEl('overBtn', 700);
const hRestart = await H();
const sheetAfter = await sheet();
ok(hRestart.over === false && hRestart.army[0] === 3 && hRestart.army[1] === 3, 'Play again rebuilds the battle in place',
  { over: hRestart.over, army: hRestart.army });
ok(sheetAfter && sheetAfter.open === false, 'the sheet closes on restart', sheetAfter);
ok((await ev('location.pathname')) === pathBefore, 'the sheet never navigates away from the port (sandboxed frame)');

// ---------- 8) a loss reached by play ----------
const adj3 = await findPair(1);
await ev(`window.__wesnoth.setup(${JSON.stringify({
  units: [{ side: 0, kind: 'commander', q: adj3.a.q, r: adj3.a.r, hp: 3 }, { side: 0, kind: 'spearman', q: 5, r: 6 },
    { side: 1, kind: 'warlord', q: adj3.b.q, r: adj3.b.r }],
  gold: [24, 22],
})})`);
await sleep(400);
const sL = await st();
const cmd = sL.units.find((u) => u.kind === 'commander');
ok(cmd && cmd.hp === 3, 'the fixture commander is on 3 hp', cmd && cmd.hp);
let hL = null, lost = null;
for (let round = 1; round <= 3 && !hL; round++) {
  await clickEl('end', 500);
  lost = await until(async () => { const h = await H(); return h.over === true; }, 40000, 300);
  hL = await H();
  T('loss round ' + round + ': ' + JSON.stringify({ over: hL.over, result: hL.result, why: hL.why, round: hL.round }));
  if (!hL.over) { hL = null; await sleep(600); }   // a miss: the warlord swings again next round
}
const sheetL = await sheet();
ok(!!hL && hL.result === 'lose', 'the cpu finishes a wounded commander and the battle is lost',
  hL && { over: hL.over, result: hL.result, why: hL.why });
ok(!!hL && /broken/i.test(sheetL.title), 'the loss sheet opens', sheetL);
const shotLose = await shot(`${PREFIX}-lose`);
await clickEl('overBtn', 700);

// ---------- 9) console cleanliness ----------
const exc = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const logErr = pageCdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/.test(e.params.entry.url || ''));
ok(exc.length === 0, 'no uncaught exceptions in the page', exc.map((e) => e.params.exceptionDetails.text).slice(0, 3));
ok(logErr.length === 0, 'no console errors in the page', logErr.map((e) => e.params.entry.text).slice(0, 3));

// ---------- 10) portrait touch ----------
await reset();
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
await tap({ x: 40, y: 760 });   // prime: a neutral press on the HUD band after the metrics change
await sleep(400);
const sP = await st();
const uP = sP.units.find((u) => u.kind === 'spearman');
const rcP = await ev(`window.__wesnoth.reach(${uP.id})`);
const destP = rcP.sort((a, b) => b.cost - a.cost)[0];
let p = await pointOf(uP.q, uP.r);
await tap(p);
await sleep(350);
const hTap = await H();
ok(hTap.sel === uP.id, 'a portrait touch lifts the unit', { sel: hTap.sel, inputs: hTap.inputs });
p = await pointOf(destP.q, destP.r);
await tap(p);
await sleep(450);
const sP2 = await st();
const uP2 = sP2.units.find((u) => u.id === uP.id);
ok(uP2 && uP2.q === destP.q && uP2.r === destP.r, 'a portrait touch marches it', { want: destP, got: uP2 && [uP2.q, uP2.r] });
const shotPortrait = await shot(`${PREFIX}-portrait`);

// ---------- report ----------
T('shots ' + JSON.stringify(SHOTS));
console.log(JSON.stringify({ gate: 'wesnoth', fails, shots: SHOTS, checks: 30 }, null, 1));
console.log(fails.length === 0 ? 'PASS — wesnoth gate' : 'FAIL — ' + fails.length + ' assertion(s) failed');
cleanup();
process.exit(fails.length === 0 ? 0 : 1);
