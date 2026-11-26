#!/usr/bin/env node
// Interaction gate for the Feudal Tactics port. Real CDP mouse clicks on the hex board, with every
// assertion read from the page's own state hook: lift, march, merge, levy, a shielded hex that
// refuses a weaker troop, the cpu's turn moving land, a win and a loss reached by play, the end
// sheet's own button, and a portrait touch pass.
// usage: node feudal-gate.mjs [site-root] [shot-prefix]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PREFIX = process.argv[3] || 'feudal-gate';
const FILE = 'games/arcade/feudal-tactics/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 120000);
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
const PROFILE = mkdtempSync('/tmp/feudal-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 60000);
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
const until = async (fn, ms = 15000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

const booted = await until(async () => (await ev('typeof window.__feudal')) === 'function', 45000, 400);
T('boot hook after poll: ' + booted);
await sleep(1200);

const click = async (pt) => {
  if (!pt || pt.__err) return pt;
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return pt;
};
const pointOf = (q, r) => ev(`window.__feudal.tilePoint(${q}, ${r})`);
const clickTile = async (q, r, wait = 220) => {
  const p = await pointOf(q, r);
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 320) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:!!e.disabled};})()`);
  await click(b);
  await sleep(wait);
  return b;
};
const state = () => ev('window.__feudal.state()');
const H = () => ev('window.__feudal()');
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

// ---------- 0) island helpers for the fixtures ----------
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const K = (q, r) => q + ',' + r;
const mkGraph = (tiles) => {
  const set = new Map(tiles.map((t) => [K(t.q, t.r), { q: t.q, r: t.r }]));
  const nbs = (t) => DIRS.map(([dq, dr]) => set.get(K(t.q + dq, t.r + dr))).filter(Boolean);
  return { set, nbs };
};
const bfs = (g, root) => {
  const out = [root], seen = new Set([K(root.q, root.r)]);
  for (let i = 0; i < out.length; i++) {
    for (const n of g.nbs(out[i])) {
      const k = K(n.q, n.r);
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
  }
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__feudal');
const s0 = await state();
const h0 = await H();
const sheet0 = await sheet();
const shotBoot = await shot(`${PREFIX}-boot`);
T('boot ' + JSON.stringify({ hookType, tiles: s0 && s0.tiles.length, mine: h0 && h0.mine, theirs: h0 && h0.theirs, turn: h0 && h0.turn }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(s0 && s0.tiles.length >= 22, 'the island carries at least 22 hexes', s0 && s0.tiles.length);
ok(h0 && h0.turn === 0 && h0.round === 1 && h0.mine === 5 && h0.theirs === 5, 'the visitor moves first on a 5-vs-5 island', { turn: h0 && h0.turn, mine: h0 && h0.mine, theirs: h0 && h0.theirs });
ok(h0 && h0.savings[0] === 24, 'the treasury opens at 24', h0 && h0.savings);
ok(sheet0 && sheet0.open === false, 'no end sheet at boot', sheet0);
ok(h0 && h0.over === false, 'the game is live at boot');

// the picker round-trip: a hex's screen point must pick that hex back
const roundTrip = await ev(`(() => {
  const st = window.__feudal.state();
  const out = [];
  for (const t of st.tiles.slice(0, 40)) {
    const p = window.__feudal.tilePoint(t.q, t.r);
    const back = p ? window.__feudal.pickAt(p.x, p.y) : null;
    out.push(back ? (back.q === t.q && back.r === t.r) : false);
  }
  return { total: out.length, good: out.filter(Boolean).length };
})()`);
ok(roundTrip && roundTrip.good === roundTrip.total, 'every sampled hex picks back to itself (screen point -> hex)', roundTrip);

// ---------- 2) lift a troop, take an unclaimed hex next door ----------
const mineT = s0.tiles.filter((t) => t.owner === 0 && t.s === 2);
ok(mineT.length > 0, 'the visitor has a strength-2 troop to command', mineT.length);
const home = mineT[0];
const g0 = mkGraph(s0.tiles);
const nbs0 = g0.nbs({ q: home.q, r: home.r });
const neutralN = nbs0.find((n) => s0.tiles.find((t) => t.q === n.q && t.r === n.r).owner === 2);
ok(!!neutralN, 'there is an unclaimed hex beside the strength-2 troop', nbs0.length);
await clickTile(home.q, home.r, 300);
const hLift = await H();
ok(hLift.held && hLift.held.s === 2 && hLift.held.from === K(home.q, home.r), 'a real click lifts the troop into the hand', hLift.held);
ok(hLift.inputs >= 1, 'the accepted-tap counter moved', hLift.inputs);
const shotLift = await shot(`${PREFIX}-lift`);

await clickTile(neutralN.q, neutralN.r, 400);
const sTake = await state();
const takenTile = sTake.tiles.find((t) => t.q === neutralN.q && t.r === neutralN.r);
const hTake = await H();
T('march ' + JSON.stringify({ at: [neutralN.q, neutralN.r], owner: takenTile && takenTile.owner, s: takenTile && takenTile.s, mine: hTake.mine, held: hTake.held }));
ok(takenTile && takenTile.owner === 0, 'the marched hex is the visitor land now', takenTile);
ok(takenTile && takenTile.s === 2 && takenTile.acted === true, 'the troop landed and is spent for the turn', takenTile);
ok(hTake.held === null && hTake.mine === h0.mine + 1, 'the hand is empty and the realm grew by one hex', { held: hTake.held, mine: hTake.mine });
const shotMarch = await shot(`${PREFIX}-march`);

// ---------- 3) march a levy onto an empty hex, then merge two troops ----------
const levyClick = await clickEl('levy', 300);
const hLevy = await H();
ok(hLevy.held && hLevy.held.s === 1 && hLevy.held.from === null, 'the Levy button puts a strength-1 troop in the hand', hLevy.held);
ok(hLevy.savings[0] === hTake.savings[0] - 10, 'the levy costs ten of the treasury', { before: hTake.savings[0], after: hLevy.savings[0] });
const sLevy = await state();
const emptyOwn = sLevy.tiles.find((t) => t.owner === 0 && t.s === 0);
const levyPoint = await clickTile(emptyOwn.q, emptyOwn.r, 350);
const sPlaced = await state();
const placed = sPlaced.tiles.find((t) => t.q === emptyOwn.q && t.r === emptyOwn.r);
ok(placed && placed.s === 1 && placed.owner === 0, 'the levy lands on an empty hex of the realm', placed);

// merge: lift the fresh levy onto the strength-2 troop
const s3 = await state();
const target = s3.tiles.find((t) => t.owner === 0 && t.s === 2 && !(t.q === emptyOwn.q && t.r === emptyOwn.r))
  || s3.tiles.find((t) => t.owner === 0 && t.s >= 1 && !t.acted && !(t.q === emptyOwn.q && t.r === emptyOwn.r));
await clickTile(emptyOwn.q, emptyOwn.r, 280);
await clickTile(target.q, target.r, 400);
const sMerged = await state();
const mergedTile = sMerged.tiles.find((t) => t.q === target.q && t.r === target.r);
const hMerged = await H();
T('merge ' + JSON.stringify({ into: [target.q, target.r], was: target.s, now: mergedTile && mergedTile.s, held: hMerged.held }));
ok(mergedTile && mergedTile.s === target.s + 1 && hMerged.held === null, 'two troops merge into one stronger troop', { was: target.s, now: mergedTile && mergedTile.s });

// ---------- 4) end the turn: the cpu marches and hands it back ----------
const beforeTurn = await H();
const beforeCpuTiles = (await state()).tiles.filter((t) => t.owner === 1).length;
await clickEl('end', 400);
const inCpu = await H();
ok(inCpu.turn === 1 || inCpu.aiBusy, 'End turn hands the board to the enemy', { turn: inCpu.turn, aiBusy: inCpu.aiBusy });
const backToYou = await until(async () => { const h = await H(); return h.turn === 0 && !h.aiBusy && h.round >= 2 ? h : null; }, 25000, 300);
const afterTurn = backToYou || await H();
const afterState = await state();
const afterCpuTiles = afterState.tiles.filter((t) => t.owner === 1).length;
T('turn ' + JSON.stringify({ round: afterTurn.round, mine: afterTurn.mine, theirs: afterTurn.theirs, cpuTiles: [beforeCpuTiles, afterCpuTiles], cash: [beforeTurn.savings[0], afterTurn.savings[0]] }));
ok(!!backToYou, 'the cpu moves and the turn comes back to the visitor', { round: afterTurn.round, turn: afterTurn.turn });
ok(afterTurn.round >= 2, 'the round counter advances', afterTurn.round);
ok(afterCpuTiles >= beforeCpuTiles && afterTurn.theirs >= 5, 'the cpu still holds (and takes) its own land', { before: beforeCpuTiles, after: afterCpuTiles });
ok(afterTurn.savings[0] !== beforeTurn.savings[0], 'taxes and wages moved the visitor treasury overnight', { before: beforeTurn.savings[0], after: afterTurn.savings[0] });
const shotPlay = await shot(`${PREFIX}-play`);

// ---------- 5) a shielded hex refuses a weaker troop (real clicks) ----------
{
  const st = await state();
  const g = mkGraph(st.tiles);
  const order = bfs(g, g.set.values().next().value);
  // find an enemy hex that (a) touches a second enemy hex and (b) touches a hex we can make ours
  let eA = null, eB = null, attacker = null;
  for (const cand of order) {
    const near = g.nbs(cand);
    const mate = near[0];
    const atk = near.find((n) => n !== mate);
    if (mate && atk) { eA = cand; eB = mate; attacker = atk; break; }
  }
  if (!eA) { ok(false, 'the island offers a hex with two neighbours for the shield fixture'); throw new Error('no shield fixture'); }
  const players = g.nbs(eA).filter((n) => n !== eB);
  const list = st.tiles.map((t) => ({ q: t.q, r: t.r, owner: 2, s: 0 }));
  const put = (t, owner, s) => { const e = list.find((x) => x.q === t.q && x.r === t.r); e.owner = owner; e.s = s || 0; return e; };
  for (const t of players) put(t, 0);
  // an enemy pair side by side: strength 2 shielding each other, everything else unclaimed
  put(eA, 1, 2); put(eB, 1, 2);
  // the visitor's strength-1 troop next to eA
  put(attacker, 0, 1);
  const built = await ev(`window.__feudal.setTiles(${JSON.stringify(list)})`);
  await sleep(700);
  const prot = await ev(`window.__feudal.protection(${eA.q}, ${eA.r})`);
  const before = await H();
  ok(built && built.over === false, 'the shield fixture is a live game', built);
  const atkPt = await pointOf(attacker.q, attacker.r);
  const picked = await ev(`window.__feudal.pickAt(${Math.round(atkPt.x)}, ${Math.round(atkPt.y)})`);
  T('shield click ' + JSON.stringify({ built, atkPt, picked, attacker, taps: before.taps, inputs: before.inputs, blocked: before.blocked, dups: before.dups, over: before.over, aiBusy: before.aiBusy }));
  await clickTile(attacker.q, attacker.r, 400);
  const afterLift = await H();
  T('shield after lift ' + JSON.stringify({ held: afterLift.held, taps: afterLift.taps, inputs: afterLift.inputs, blocked: afterLift.blocked, dups: afterLift.dups }));
  const heldBefore = await H();
  const canGo = await ev(`window.__feudal.canConquer(${eA.q}, ${eA.r})`);
  await clickTile(eA.q, eA.r, 400);
  const afterBlocked = await state();
  const eAfter = afterBlocked.tiles.find((t) => t.q === eA.q && t.r === eA.r);
  const hBlocked = await H();
  T('shield ' + JSON.stringify({ pair: [[eA.q, eA.r], [eB.q, eB.r]], attacker: [attacker.q, attacker.r], protector: prot, canConquer: canGo, ownerAfter: eAfter && eAfter.owner, blocked: hBlocked.blocked, held: hBlocked.held }));
  ok(!!(eA && eB && attacker), 'the fixture found an enemy pair beside the visitor realm', { eA, eB, attacker });
  ok(prot === 2, 'the enemy pair shields at 2', prot);
  ok(heldBefore.held && heldBefore.held.s === 1, 'a strength-1 troop is in the hand', heldBefore.held);
  ok(canGo === false, 'a strength-1 troop cannot break a strength-2 shield');
  ok(eAfter && eAfter.owner === 1, 'the shielded hex stays in enemy hands after the click', eAfter);
  ok(hBlocked.blocked >= 1, 'the refused click is counted as blocked', hBlocked.blocked);
  ok(hBlocked.held !== null, 'the troop stays in the hand after the refusal', hBlocked.held);
  const shotShield = await shot(`${PREFIX}-shield`);
}

// ---------- 6) a win reached by a real march ----------
{
  const st = await state();
  const g = mkGraph(st.tiles);
  const homeT = [...g.set.values()].sort((a, b) => g.nbs(b).length - g.nbs(a).length)[0];
  const order = bfs(g, homeT);
  const players = order.slice(0, 7);
  const enemies = order.slice(-2);
  const list = st.tiles.map((t) => ({ q: t.q, r: t.r, owner: 2, s: 0 }));
  const put = (t, owner, s) => { const e = list.find((x) => x.q === t.q && x.r === t.r); e.owner = owner; e.s = s || 0; return e; };
  for (const t of players) put(t, 0);
  for (const t of enemies) put(t, 1);
  // a neutral hex beside the visitor's realm, with a strength-2 troop next to it
  let target = null, fromT = null;
  for (const t of players) {
    for (const n of g.nbs(t)) {
      const e = list.find((x) => x.q === n.q && x.r === n.r);
      if (e.owner === 2) { target = n; fromT = t; break; }
    }
    if (target) break;
  }
  ok(!!target && !!fromT, 'the win fixture has an unclaimed hex on the frontier', { target, fromT });
  put(fromT, 0, 2);
  const built = await ev(`window.__feudal.setTiles(${JSON.stringify(list)})`);
  await sleep(500);
  const preWin = await H();
  T('win fixture ' + JSON.stringify({ mine: preWin.mine, theirs: preWin.theirs, neutral: preWin.neutral, target }));
  ok(preWin.mine === 7 && preWin.theirs === 2, 'the fixture is 7 hexes to 2 with one unclaimed frontier hex', { mine: preWin.mine, theirs: preWin.theirs });
  await clickTile(fromT.q, fromT.r, 260);
  await clickTile(target.q, target.r, 500);
  const winState = await H();
  const winSheet = await sheet();
  T('win ' + JSON.stringify({ over: winState.over, result: winState.result, why: winState.why, mine: winState.mine, theirs: winState.theirs, sheet: winSheet && winSheet.title }));
  ok(winState.over === true && winState.result === 'win', 'taking the last frontier hex wins the crown', { over: winState.over, result: winState.result, mine: winState.mine, theirs: winState.theirs });
  ok(winSheet && winSheet.open && /crown|island/i.test(winSheet.title), 'the win sheet opens with its own title', winSheet);
  const shotWin = await shot(`${PREFIX}-win`);
}

// ---------- 7) a loss reached through the cpu's turn ----------
{
  const st = await state();
  const g = mkGraph(st.tiles);
  const homeT = [...g.set.values()].sort((a, b) => g.nbs(b).length - g.nbs(a).length)[0];
  const order = bfs(g, homeT);
  const players = order.slice(0, 2);
  const enemies = order.slice(2, 6);
  const list = st.tiles.map((t) => ({ q: t.q, r: t.r, owner: 2, s: 0 }));
  const put = (t, owner, s) => { const e = list.find((x) => x.q === t.q && x.r === t.r); e.owner = owner; e.s = s || 0; return e; };
  for (const t of players) put(t, 0, 1);
  // a strength-2 enemy beside each of the visitor's two hexes
  let placed = 0;
  for (const p of players) {
    const n = g.nbs(p).find((x) => enemies.indexOf(x) >= 0);
    if (n) { put(n, 1, 2); placed++; }
  }
  for (const e of enemies) { const cur = list.find((x) => x.q === e.q && x.r === e.r); if (cur.owner !== 1) put(e, 1); }
  const built = await ev(`window.__feudal.setTiles(${JSON.stringify(list)})`);
  await sleep(500);
  const preLose = await H();
  T('lose fixture ' + JSON.stringify({ mine: preLose.mine, theirs: preLose.theirs, attackers: placed }));
  ok(preLose.mine === 2 && preLose.theirs === 4 && preLose.over === false, 'the fixture is 2 hexes to 4, still live', { mine: preLose.mine, theirs: preLose.theirs, over: preLose.over });
  await clickEl('end', 400);
  const lost = await until(async () => { const h = await H(); return h.over && !h.aiBusy ? h : null; }, 30000, 300);
  const loseSheet = await sheet();
  T('lose ' + JSON.stringify({ over: lost && lost.over, result: lost && lost.result, why: lost && lost.why, sheet: loseSheet && loseSheet.title }));
  ok(lost && lost.over && lost.result === 'lose', 'the enemy takes the realm and the game ends in a defeat', { over: lost && lost.over, result: lost && lost.result, why: lost && lost.why });
  ok(loseSheet && loseSheet.open && /lost|enemy/i.test(loseSheet.title), 'the loss sheet opens with its own title', loseSheet);
  const shotLose = await shot(`${PREFIX}-lose`);

  // the sheet's own button must restart (the backdrop covers the bottom bar)
  await clickEl('overBtn', 700);
  const restarted = await H();
  const restartedSheet = await sheet();
  ok(restarted.over === false && restarted.round === 1 && restarted.mine === 5, 'Play again deals a fresh island', { over: restarted.over, round: restarted.round, mine: restarted.mine });
  ok(restartedSheet && restartedSheet.open === false, 'the sheet closes on restart', restartedSheet);
}

// ---------- 8) portrait touch pass ----------
{
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(1200);
  const geom = await ev(`(() => {
    const c = document.querySelector('canvas').getBoundingClientRect();
    const st = window.__feudal.state();
    const top = document.querySelector('.top').getBoundingClientRect();
    const bot = document.querySelector('.bottom').getBoundingClientRect();
    const pts = st.tiles.map((t) => window.__feudal.tilePoint(t.q, t.r));
    return { canvas: { x: c.x, y: c.y, w: c.width, h: c.height }, top: top.bottom, bot: bot.top, pts: pts.slice(0, 40) };
  })()`);
  const inside = geom.pts.every((p) => p && p.x > 0 && p.x < 390 && p.y > geom.top && p.y < geom.bot);
  T('portrait ' + JSON.stringify({ canvas: geom.canvas, top: geom.top, bot: geom.bot, first: geom.pts[0] }));
  ok(inside, 'every sampled hex projects into the band the hud leaves on a 390x844 phone', geom);
  const hNow = await H();
  const sNow = await state();
  const t1 = sNow.tiles.find((t) => t.owner === 0 && t.s > 0 && !t.acted);
  const ptP = await pointOf(t1.q, t1.r);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ptP.x, y: ptP.y, id: 1 }] });
  await sleep(80);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
  const hTouch = await until(async () => { const h = await H(); return h.held ? h : null; }, 5000, 250);
  ok(hTouch && hTouch.held.s === t1.s, 'a finger tap lifts a troop on the portrait board', { held: hTouch && hTouch.held, want: t1.s });
  const shotPortrait = await shot(`${PREFIX}-portrait`);
}

// ---------- 9) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 240));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the whole run', errText);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + Object.entries(SHOTS).map(([k, v]) => k + '=' + v).join(' '));
if (fails.length) { console.error(`\nFEUDAL GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('FEUDAL GATE PASS');
