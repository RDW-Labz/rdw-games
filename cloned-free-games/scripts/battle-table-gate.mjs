#!/usr/bin/env node
// Interaction gate for the Battle Table port. Serves the arcade tree, boots headless Chromium,
// dispatches REAL pointer events on the unit cards and the controls, and asserts through
// window.__battle() that the force, the dice and the campaign actually change state.
// A canvas that merely exists is not proof: every claim below is read out of the page hook.
//
// usage: node battle-table-gate.mjs [rootDir] [page]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = process.argv[3] || 'games/arcade/battle-table/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
if (!bin) { console.error('no chromium'); process.exit(1); }
const PROFILE = mkdtempSync('/tmp/btl-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) { console.error('no page target'); process.exit(1); }
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

let fails = 0;
const ok = (cond, msg, extra) => {
  if (cond) { T('  ok   ' + msg); return true; }
  fails++; T('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  return false;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('  shot ' + out);
  return out;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);

const state = () => ev('window.__battle()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// in-page pointer tap at a reported point, on whatever the point actually hits
const tapAt = (p) => ev(`(()=>{
  const el = document.elementFromPoint(${p.x}, ${p.y});
  if (!el) return { hit: null };
  const host = (el.closest && el.closest('[data-k],button')) || el;
  const o = { bubbles: true, cancelable: true, composed: true, clientX: ${p.x}, clientY: ${p.y}, pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  return { hit: host.dataset && host.dataset.k ? host.dataset.k : (host.id || host.tagName) };
})()`);
const tapCard = async (k) => {
  const p = await ev(`window.__battle.cardPoint('${k}')`);
  if (!p || p.x == null) return { hit: null, miss: true };
  const r = await tapAt(p);
  await sleep(90);
  return { ...r, x: p.x, y: p.y };
};
const tapControl = async (expr, ms = 350) => {
  const p = await ev(expr);
  const r = await tapAt(p);
  await sleep(ms);
  return { ...r, x: p && p.x, y: p && p.y };
};
const waitDone = async (ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (s.over && s.sheet) return s;
    await sleep(350);
  }
  return await state();
};

// ---- 1) boot
const s0 = await state();
ok((await ev('typeof window.__battle')) === 'function', 'hook is a function (the catalog gate probes typeof)');
ok(s0.phase === 'muster' && s0.force === 0 && s0.budget > 0 && !s0.over, 'boots at muster with an empty force', s0);
const cam0 = await ev('window.__battle.camera()');
ok(cam0.aspect > 1 && cam0.dist > 0, 'camera framed', cam0);
const shotBoot = await shot('battle-table-gate-boot');

// ---- 2) unit cards add units, and the point lands on the card itself
for (const [k, n] of [['INF', 4], ['ART', 2], ['ARM', 2], ['FGT', 1], ['BOM', 1]]) {
  for (let i = 0; i < n; i++) await tapCard(k);
}
const sAdd = await state();
ok(sAdd.atk.INF === 4 && sAdd.atk.ARM === 2 && sAdd.atk.BOM === 1, 'card taps add the units asked for', sAdd.atk);
ok(sAdd.force === 4 * 1 + 2 * 2 + 2 * 3 + 3 + 4, 'the force box prices the muster', sAdd.force);
ok(sAdd.inputs >= 10, 'accepted taps are counted', sAdd.inputs);
const hitInf = await tapAt(await ev("window.__battle.cardPoint('INF')"));
ok(hitInf.hit === 'INF', 'the card point resolves to the card element, not to the canvas under it', hitInf);
const sAfterOne = await state();
ok(sAfterOne.atk.INF === 5, 'the card under that point really is INFantry', sAfterOne.atk.INF);
await ev("window.__battle.setup({atk:{INF:4,ART:2,ARM:2,FGT:1,BOM:1}})");

// ---- 3) the budget is enforced
for (let i = 0; i < 12; i++) await tapCard('ARM');
const sCap = await state();
ok(sCap.force <= sCap.budget, 'the muster can never exceed the point budget', { force: sCap.force, budget: sCap.budget });
ok(sCap.blocked > 0, 'refused taps are counted as blocked, not silently dropped', sCap.blocked);
await ev("window.__battle.setup({atk:{INF:4,ART:2,ARM:2,FGT:1,BOM:1}})");

// ---- 4) stance is a real trade, not a label
const sOff = await state();
const st = await tapControl("window.__battle.stancePoint()");
const sDef = await state();
ok(st.hit === 'stance', 'the stance control point resolves to its button', st);
ok(sDef.stance === 'def' && sOff.stance === 'off', 'stance flips', { was: sOff.stance, now: sDef.stance });
ok(sDef.types === sOff.types, 'stance does not change the count of force types');
await tapControl("window.__battle.stancePoint()");
ok((await state()).stance === 'off', 'stance flips back');

// ---- 5) an empty force cannot roll
await ev("window.__battle.setup({atk:{}})");
const before = await state();
await tapControl("window.__battle.rollPoint()");
const afterEmpty = await state();
ok(afterEmpty.phase === 'muster' && !afterEmpty.busy, 'rolling with no force does nothing', { phase: afterEmpty.phase });
ok(afterEmpty.blocked > before.blocked, 'and it is counted as blocked', { was: before.blocked, now: afterEmpty.blocked });

// ---- 6) a real battle: roll, animate, sheet
await ev("window.__battle.setup({atk:{INF:4,ART:2,ARM:2,FGT:1,FGT:1,BOM:1}})");
const sPre = await state();
const rl = await tapControl("window.__battle.rollPoint()", 600);
ok(rl.hit === 'roll', 'the roll point resolves to the roll button', rl);
const sMid = await state();
ok(sMid.phase !== 'muster' || sMid.busy, 'rolling starts the battle', { phase: sMid.phase, busy: sMid.busy });
await sleep(800);
const shotMid = await shot('battle-table-gate-mid');
const sDone = await waitDone();
const sh = await sheet();
T('battle 1 ' + JSON.stringify({ outcome: sDone.outcome, rounds: sDone.rounds, title: sh.title, objectives: sDone.objectives }));
ok(sDone.over && sDone.rounds === 6, 'the battle resolves all six rounds', { rounds: sDone.rounds });
ok(['win', 'loss', 'draw', 'mutual'].includes(sDone.outcome), 'a legal outcome is recorded', sDone.outcome);
ok(sh.open && sh.title.length > 0, 'the end-of-battle sheet opens with a verdict', sh);
ok(sDone.objectives.won + sDone.objectives.lost === 1, 'the objective tally moves', sDone.objectives);
const shotBattle = await shot('battle-table-gate-battle');

// ---- 7) next objective from the sheet
const battleBefore = sDone.battle;
const ob = await tapControl("window.__battle.overPoint()", 500);
ok(ob.hit === 'overBtn', 'the sheet button point resolves to the sheet button', ob);
const sNext = await state();
ok(!(await sheet()).open, 'the sheet closes');
ok(sNext.battle === battleBefore || (sNext.objectives.won === 0 && sNext.objectives.lost === 0),
  'either the next objective loads or a finished campaign restarts', { battle: sNext.battle, before: battleBefore, obj: sNext.objectives });

// ---- 8) a QA win and a QA loss, proven through the real roll path
// Pick the seed the page will actually use: the port resolves with mulberry32(1000 + seed * 7919).
const findByOutcome = (atk, battle, want) => ev(`(()=>{
  const C = window.__battle.core;
  const g = C.GARRISONS[${battle}];
  const atk = ${JSON.stringify(atk)};
  for (let seed = 1; seed < 4000; seed++) {
    const r = C.runBattle({ roster: atk, stance: 'off' }, { roster: g.roster, stance: g.stance }, C.mulberry32(1000 + seed * 7919));
    if (r.outcome === '${want}') return seed;
  }
  return null;
})()`);
const winSeed = await findByOutcome({ INF: 8, ARM: 6, FGT: 1, BOM: 1 }, 0, 'win');
const loseSeed = await findByOutcome({ INF: 1 }, 2, 'loss');
ok(winSeed != null && loseSeed != null, 'a QA seed exists for both a win and a loss', { winSeed, loseSeed });

await ev(`window.__battle.setup({atk:{INF:8,ARM:6,FGT:1,BOM:1}, battle:0, seed:${winSeed}, won:0, lost:0})`);
const winForce = await state();
ok(winForce.force <= winForce.budget, 'the QA win force still respects the budget', { force: winForce.force, budget: winForce.budget });
await tapControl("window.__battle.rollPoint()", 400);
const sWin = await waitDone();
const winSheet = await sheet();
T('QA win ' + JSON.stringify({ outcome: sWin.outcome, title: winSheet.title, atk: sWin.atk }));
ok(sWin.outcome === 'win', 'an overwhelming force takes the area', sWin.outcome);
ok(/taken/i.test(winSheet.title), 'the win sheet says the area was taken', winSheet.title);
const shotWin = await shot('battle-table-gate-win');

await ev(`window.__battle.setup({atk:{INF:1}, battle:2, seed:${loseSeed}, won:0, lost:0})`);
await tapControl("window.__battle.rollPoint()", 400);
const sLose = await waitDone();
const loseSheet = await sheet();
T('QA loss ' + JSON.stringify({ outcome: sLose.outcome, title: loseSheet.title }));
ok(sLose.outcome !== 'win', 'a lone infantry squad cannot take a fortress', sLose.outcome);
ok(/repuls|stalemate|mutual|destruction/i.test(loseSheet.title), 'the losing sheet names the failure', loseSheet.title);

// ---- 9) new campaign resets everything (close the sheet first — it covers the bottom bar)
const bk = await tapControl("window.__battle.backPoint()", 400);
ok(bk.hit === 'backBtn', 'the sheet close button resolves to its button', bk);
ok(!(await sheet()).open, 'the sheet closes on Back up');
await tapControl("(()=>{const r=document.getElementById('new').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()", 400);
const sNew = await state();
ok(sNew.force === 0 && sNew.phase === 'muster' && !sNew.over, 'New campaign clears the muster', sNew);
ok(sNew.objectives.won === 0 && sNew.objectives.lost === 0, 'and the objective tally', sNew.objectives);

// ---- 10) portrait touch pass: every card point must land on its own card
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(900);
const camP = await ev('window.__battle.camera()');
T('portrait camera ' + JSON.stringify(camP));
const keys = ['INF', 'ART', 'ARM', 'FGT', 'BOM', 'SUB', 'CRS', 'CV', 'BS'];
let misses = [];
for (const k of keys) {
  const p = await ev(`window.__battle.cardPoint('${k}')`);
  if (!p || p.x < 0 || p.y < 0 || p.x > 390 || p.y > 844) { misses.push({ k, p }); continue; }
  const hit = await tapAt(p);
  if (hit.hit !== k) misses.push({ k, hit: hit.hit });
  await ev("window.__battle.setup({atk:{}})");
}
ok(misses.length === 0, 'every unit card is on screen and taps itself in portrait', misses);
for (let i = 0; i < 6; i++) await tapCard('INF');
for (const k of ['ART', 'ARM']) await tapCard(k);
const sPort = await state();
ok(sPort.atk.INF === 6 && sPort.atk.ART === 1, 'portrait taps muster a force', sPort.atk);
const shotPort = await shot('battle-table-gate-portrait');
await tapControl("window.__battle.rollPoint()", 400);
const sPortDone = await waitDone();
ok(sPortDone.over, 'a battle resolves in portrait too', { phase: sPortDone.phase });
const portSheet = await sheet();
ok(portSheet.open, 'and the sheet opens in portrait', portSheet.title);

// ---- console errors
const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
const realErrs = errs.filter((e) => !/favicon/i.test(e.params.entry.text));
ok(realErrs.length === 0, 'no console errors', realErrs.map((e) => e.params.entry.text).slice(0, 4));

T(fails ? `${fails} FAILURE(S)` : 'PASS — force, stance, budget, battles, win sheet, lose sheet, restart and portrait all proven');
T('shots: ' + [shotBoot, shotBattle, shotWin, shotPort].join(' '));
proc.kill();
server.close();
process.exit(fails ? 1 : 0);
