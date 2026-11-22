#!/usr/bin/env node
// Interaction gate for the Water Sort port. Real CDP mouse clicks on the tubes (no synthetic
// in-page events): select a tube, pour the solver's own next move through the real board, play a
// whole level to the win sheet, restart from the sheet's own button, burn the move budget to the
// loss sheet, the double-tap guard, and a 390x844 portrait touch pass.
// usage: node water-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/water-sort/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
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
const PROFILE = mkdtempSync('/tmp/water-gate-');
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
const until = async (fn, ms = 12000, step = 200) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
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
const pointOf = (i) => ev(`window.__water.tubePoint(${i})`);
const clickTube = async (i, wait = 200) => {
  const p = await pointOf(i);
  if (!p || p.__err) return { err: p && p.__err, p };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 400) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) return null;
  await click(b);
  await sleep(wait);
  return b;
};
const state = () => ev('window.__water()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__water');
const rules = await ev('window.__water.rules()');
const s0 = await state();
const shotBoot = await shot('water-gate-boot');
T('boot ' + JSON.stringify({ hookType, rules, tubes: s0 && s0.tubes.length, movesLeft: s0 && s0.movesLeft, level: s0 && s0.level }));
ok(hookType === 'function', 'the state hook is a function (the catalog gate reads typeof frame.__hook)', hookType);
ok(rules && rules.CAP === 4 && rules.levels === 5, 'four units per tube, five levels', rules);
ok(s0 && s0.level === 0 && s0.tubes.length === 5 && !s0.won, 'boots a 3-colour deal with two empty tubes', s0 && { tubes: s0.tubes, won: s0.won });
ok(s0 && s0.movesLeft === s0.budget && s0.movesLeft > s0.opt, 'the move budget is larger than the optimal line', s0 && { budget: s0.budget, opt: s0.opt });

// ---------- 2) a real click selects, a second pours ----------
const pt0 = await clickTube(0, 260);
const sSel = await state();
T('select ' + JSON.stringify({ pt0, sel: sSel && sSel.sel, inputs: sSel && sSel.inputs }));
ok(sSel && sSel.sel === 0 && sSel.inputs >= 1, 'a real click on tube 0 selects it', sSel && { sel: sSel.sel, inputs: sSel.inputs });

const next = await ev('window.__water.nextMove()');
ok(next && next.move, 'the live board reports its next solving move', next);
let poured = null;
if (next && next.move) {
  const [a, b] = next.move;
  const selNow = (await state()).sel;
  if (selNow !== a) await clickTube(a, 200);   // clicking the already-selected tube would deselect
  const before = await state();
  await clickTube(b, 320);
  const after = await state();
  poured = { a, b, before: { moves: before.moves, t: before.tubes[a] }, after: { moves: after.moves, t: after.tubes[b], left: after.movesLeft } };
  ok(after.moves === before.moves + 1 && after.movesLeft === before.movesLeft - 1, 'the second click pours and spends one move', poured);
  ok(JSON.stringify(after.tubes) !== JSON.stringify(before.tubes), 'the board contents changed on the pour', poured.after);
}
const shotPlay = await shot('water-gate-play');

// ---------- 3) play the level to the win sheet with real clicks ----------
await ev('window.__water.setup(0)');
await sleep(400);
let taps = 0, wonNow = false;
while (taps < 90) {
  const st = await state();
  if (st.over) { wonNow = st.result === 'win'; break; }
  const nm = await ev('window.__water.nextMove()');
  if (!nm || !nm.move) break;
  await clickTube(nm.move[0], 130);
  await clickTube(nm.move[1], 130);
  taps += 2;
}
const winState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 8000);
const winSheet = await sheet();
T('win ' + JSON.stringify({ taps, over: winState && winState.over, result: winState && winState.result, won: winState && winState.won, sheet: winSheet }));
ok(winState && winState.over && winState.result === 'win' && winState.won, 'playing the solving line through the real board wins', winState && { result: winState.result, won: winState.won, solved: winState.solved });
ok(winSheet && winSheet.open && /level clear|every deal sorted/i.test(winSheet.title), 'the win sheet opens with its own title', winSheet);
ok(taps > 0 && taps < 90, 'the level took a real number of clicks, not a shortcut', taps);
const shotWin = await shot('water-gate-win');

// ---------- 4) the sheet's own button starts the next deal ----------
await clickEl('overBtn');
const sNext = await state();
const closedAfterWin = await sheet();
T('next ' + JSON.stringify({ level: sNext && sNext.level, over: sNext && sNext.over, sheet: closedAfterWin }));
ok(sNext && sNext.level === 1 && !sNext.over && sNext.moves === 0, 'Next deal opens level 2 clean', sNext && { level: sNext.level, over: sNext.over, moves: sNext.moves });
ok(closedAfterWin && !closedAfterWin.open, 'the sheet closes on the restart', closedAfterWin);

// ---------- 5) burn the budget to the loss sheet ----------
// A short QA budget (the port's own setup hook, same pattern as a chess setup(fen)) so the loss is
// reached in a handful of honest pours: every pour below is a real click that spends a real move.
await ev('window.__water.setup(0, 3)');
await sleep(400);
let burns = 0;
while (burns < 40) {
  const st = await state();
  if (st.over) break;
  const mv = await ev('window.__water.legalMoves()');
  if (!mv || !mv.length) { T('burn: no legal pour at ' + burns); break; }
  const [from, to] = mv[mv.length - 1];
  T('burn ' + burns + ' pour ' + from + '->' + to + ' left=' + st.movesLeft);
  await clickTube(from, 130);
  await clickTube(to, 220);
  burns += 2;
}
const loseState = await until(async () => { const s = await state(); return s && s.over ? s : null; }, 6000);
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ burns, over: loseState && loseState.over, result: loseState && loseState.result, left: loseState && loseState.movesLeft, sheet: loseSheet }));
ok(loseState && loseState.over && loseState.result === 'lose', 'spending the move budget ends the deal as a loss', loseState && { result: loseState.result, movesLeft: loseState.movesLeft });
ok(loseState && loseState.movesLeft === 0, 'the loss lands exactly at zero moves left', loseState && loseState.movesLeft);
ok(loseSheet && loseSheet.open && /out of moves/i.test(loseSheet.title), 'the loss sheet opens with its own title', loseSheet);
const shotLose = await shot('water-gate-lose');

// Back up closes the sheet without restarting; the bottom bar is then reachable again.
await clickEl('overBack');
const sBack = await state();
const sheetBack = await sheet();
T('backup ' + JSON.stringify({ over: sBack && sBack.over, sheet: sheetBack }));
ok(sheetBack && !sheetBack.open, 'Back up closes the sheet', sheetBack);
await clickEl('restart');
const sRestart = await state();
T('restart ' + JSON.stringify({ over: sRestart && sRestart.over, movesLeft: sRestart && sRestart.movesLeft, budget: sRestart && sRestart.budget }));
ok(sRestart && !sRestart.over && sRestart.moves === 0 && sRestart.movesLeft === sRestart.budget, 'Restart re-deals the level at full budget', sRestart && { over: sRestart.over, movesLeft: sRestart.movesLeft, budget: sRestart.budget });

// ---------- 6) the double-tap guard ----------
await ev('window.__water.setup(0)');
await sleep(300);
const stDup = await state();
const dupIdx = stDup.tubes.findIndex((t) => t.length > 0);   // an empty tube rejects the tap honestly
const beforeDup = await state();
const dupPoint = await pointOf(dupIdx);
await ev(`(()=>{const p=${JSON.stringify(dupPoint)};
  const c=document.querySelector('canvas');
  const mk=(t)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,pointerId:9,pointerType:'touch',isPrimary:true});
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  return true;})()`);
await sleep(350);
const afterDup = await state();
T('dup ' + JSON.stringify({ before: beforeDup.inputs, after: afterDup.inputs, dups: afterDup.dups }));
ok(afterDup.dups >= 1 && afterDup.inputs === beforeDup.inputs + 1, 'a same-point double tap is counted once', { before: beforeDup.inputs, after: afterDup.inputs, dups: afterDup.dups });

// ---------- 7) portrait touch ----------
await ev('window.__water.setup(2)');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(1200);
const geom = await ev(`(()=>{const b=window.__water.band();
  const wrap=document.querySelector('.top').getBoundingClientRect();
  const bot=document.querySelector('.bottom').getBoundingClientRect();
  return {hi:b.hi,lo:b.lo,pts:b.points,topPx:wrap.bottom,botPx:bot.top};})()`);
const allInside = geom.pts.every((p) => p && p.x > 4 && p.x < 386 && p.y > geom.topPx && p.y < geom.botPx);
T('portrait ' + JSON.stringify({ topPx: geom.topPx, botPx: geom.botPx, first: geom.pts[0], last: geom.pts[geom.pts.length - 1], n: geom.pts.length }));
ok(allInside, 'every tube projects into the band the hud leaves on a 390x844 phone', geom.pts);
const ptP = await clickTube(1, 400);
const sPortrait = await until(async () => { const s = await state(); return s && s.sel === 1 ? s : null; }, 5000);
ok(sPortrait !== null, 'a touch on the portrait board selects a tube', { ptP, sel: sPortrait && sPortrait.sel });
const shotPortrait = await shot('water-gate-portrait');

// ---------- 8) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 240));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the whole run', errText);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + [shotBoot, shotPlay, shotWin, shotLose, shotPortrait].join(' '));
if (fails.length) { console.error(`\nWATER GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('WATER GATE PASS');
