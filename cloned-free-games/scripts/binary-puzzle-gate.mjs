#!/usr/bin/env node
// Interaction gate for the Binary Puzzle port: real CDP mouse + touch on the 3D board, state-hook
// assertions for cycle / rule-slip / win / lose / restart / double-event guard, plus screenshots.
// usage: node binary-puzzle-gate.mjs <dir-containing-games/arcade/binary-puzzle>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/tmp/bpstage');
const FILE = 'games/arcade/binary-puzzle/index.html';
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

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/bp-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: PROFILE } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
});
T('devtools up');
// Attach to the existing page target: browser-level Target.createTarget hangs on this build.
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => cdp.send(m, p);
const server = await serve();
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6000);
T('page loaded');

const errorsOf = (from = 0) => cdp.events.slice(from).filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickCell = async (i) => {
  const p = await ev(`window.__binarypuzzle.cellPoint(${(i / 6) | 0},${i % 6})`);
  if (!p || p.__err) throw new Error('cellPoint failed ' + JSON.stringify(p));
  await click(p);
  await sleep(260);
  return p;
};
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(320); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 1) boot ----
const s0 = await ev('window.__binarypuzzle()');
const shotBoot = await shot('binary-puzzle-gate-boot');
const blanks = s0.values.map((v, i) => (v === -1 ? i : -1)).filter((i) => i >= 0);
const zeroBlank = blanks.find((i) => s0.solution[i] === 0);
const oneBlank = blanks.find((i) => s0.solution[i] === 1);
T(`boot level=${s0.level} blanks=${blanks.length} cam=${s0.camera}`);

// every given must agree with the solution
const givensAgree = s0.values.every((v, i) => v === -1 || v === s0.solution[i]);

// ---- 2) a real click on a blank cycles it, and the filled count moves ----
const pFirst = await clickCell(blanks[0]);
const sCycle1 = await ev('window.__binarypuzzle()');
await clickCell(blanks[0]);
const sCycle2 = await ev('window.__binarypuzzle()');
await clickCell(blanks[0]);
const sCycle3 = await ev('window.__binarypuzzle()');

// ---- 3) a given cell ignores clicks ----
const givenIdx = s0.values.findIndex((v, i) => v !== -1 && i >= 0);
await clickCell(givenIdx);
const sGiven = await ev('window.__binarypuzzle()');

// ---- 4) a placement that breaks a rule counts a slip and paints the cell ----
// Put three 1s in a row on the top rank where the puzzle leaves holes, using setCell through the
// page's own entry point first to find a violating spot, then do it with a real click.
const violPlan = await ev(`(()=>{
  const st = window.__binarypuzzle();
  for (const v of [0, 1]) {
    for (let i = 0; i < 36; i++) {
      if (st.values[i] !== -1) continue;
      if (window.__binarypuzzle.probe(i, v).length) return { i, v };
    }
  }
  return null;
})()`);
const sPreViol = await ev('window.__binarypuzzle()');
let sViol = null, violCell = null;
if (violPlan && violPlan.i >= 0) {
  violCell = violPlan.i;
  // cycle with real clicks until the value equals the planned one
  let guard = 0;
  while (guard++ < 4) {
    const cur = (await ev('window.__binarypuzzle()')).values[violPlan.i];
    if (cur === violPlan.v) break;
    await clickCell(violPlan.i);
  }
  sViol = await ev('window.__binarypuzzle()');
}
const shotMid = await shot('binary-puzzle-gate-slip');

// ---- 5) the double-event guard: two pointerups at one point in 70 ms is one tap ----
await ev(`window.__binarypuzzle.load(${JSON.stringify(s0.values.map((v) => (v === -1 ? '.' : v)).join(''))}, ${JSON.stringify(s0.solution.join(''))})`);
await sleep(400);
const dupBefore = await ev('window.__binarypuzzle()');
const dupTarget = dupBefore.values.findIndex((v) => v === -1);
const dupPoint = await ev(`window.__binarypuzzle.cellPoint(${(dupTarget / 6) | 0},${dupTarget % 6})`);
await ev(`(()=>{
  const o = { clientX: ${dupPoint.x}, clientY: ${dupPoint.y}, bubbles: true, pointerType: 'mouse', button: 0 };
  document.body.dispatchEvent(new PointerEvent('pointerdown', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  document.body.dispatchEvent(new PointerEvent('pointerup', o));
  return true;
})()`);
await sleep(300);
const dupAfter = await ev('window.__binarypuzzle()');

// ---- 6) win: load a board one cell short (blank where the answer is 0) and click it ----
const winSetup = await ev(`(()=>{
  const st = window.__binarypuzzle();
  const sol = st.solution;
  const gi = sol.findIndex((v, i) => v === 0 && st.given[i]);
  const target = sol.map((v, i) => (v === 0 && !st.given[i] ? i : -1)).find((i) => i >= 0);
  const blankIdx = st.values.findIndex((v) => v === -1);
  // blank one solvable cell: prefer a cell whose answer is 0 so a single click lands it
  const hole = sol.map((v, i) => (v === 0 ? i : -1)).find((i) => i >= 0);
  const vals = sol.map((v, i) => (i === hole ? '.' : String(v))).join('');
  window.__binarypuzzle.load(vals, sol.join(''));
  const st2 = window.__binarypuzzle();
  return { hole, empty: st2.empty, filled: st2.filled, over: st2.over, answer: sol[hole], givens: st2.given.filter(Boolean).length, target, blankIdx, gi };
})()`);
await sleep(400);
if (winSetup && winSetup.hole >= 0 && winSetup.givens > 30) {
  await clickCell(winSetup.hole);   // -1 -> 0, which is the answer
}
await sleep(400);
const sWin = await ev('window.__binarypuzzle()');
const winSheet = await sheet();
const shotWin = await shot('binary-puzzle-gate-win');

// ---- 7) lose: two slips already banked, then break a rule with real clicks ----
await ev(`window.__binarypuzzle.load(${JSON.stringify(s0.values.map((v) => (v === -1 ? '.' : v)).join(''))}, ${JSON.stringify(s0.solution.join(''))})`);
await sleep(400);
await ev('window.__binarypuzzle.setMistakes(2)');
const losePlan = await ev(`(()=>{
  const st = window.__binarypuzzle();
  for (const v of [0, 1]) {
    for (let i = 0; i < 36; i++) {
      if (st.values[i] !== -1) continue;
      if (window.__binarypuzzle.probe(i, v).length) return { i, v };
    }
  }
  return null;
})()`);
await ev('window.__binarypuzzle.setMistakes(2)');
if (losePlan && losePlan.i >= 0) {
  let g = 0;
  while (g++ < 4) {
    const st = await ev('window.__binarypuzzle()');
    if (st.over) break;
    if (st.values[losePlan.i] === losePlan.v) break;
    await clickCell(losePlan.i);
  }
  const st = await ev('window.__binarypuzzle()');
  if (st.over) await clickCell(losePlan.i); // no-op click on a locked board, proves the lock
}
await sleep(400);
const sLose = await ev('window.__binarypuzzle()');
const loseSheet = await sheet();
const shotLose = await shot('binary-puzzle-gate-lose');

// ---- 8) restart from the sheet, then the R key ----
await clickEl('overBtn');
await sleep(600);
const sNew = await ev('window.__binarypuzzle()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sR = await ev('window.__binarypuzzle()');

// ---- 9) portrait touch: tap a blank and watch it take a value ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const tState = await ev('window.__binarypuzzle()');
const tBlank = tState.values.findIndex((v) => v === -1);
const tPt = await ev(`window.__binarypuzzle.cellPoint(${(tBlank / 6) | 0},${tBlank % 6})`);
const tCorner = await ev(`window.__binarypuzzle.cellPoint(0,5)`);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
};
await tap(tPt);
const sTouch = await ev('window.__binarypuzzle()');
const shotTouch = await shot('binary-puzzle-gate-touch');
const errors = errorsOf();

const inScreen = (p, w, h) => p && !p.__err && p.x > 4 && p.x < w - 4 && p.y > 4 && p.y < h - 4;
const checks = {
  boot: !!s0 && s0.level === 0 && s0.over === false && s0.mistakes === 0 && blanks.length > 10 && s0.filled + blanks.length === 36,
  givensAgree,
  cycleFills: sCycle1.values[blanks[0]] === 0 && sCycle1.filled === s0.filled + 1,
  cycleNext: sCycle2.values[blanks[0]] === 1,
  cycleWraps: sCycle3.values[blanks[0]] === -1 && sCycle3.filled === s0.filled,
  givenLocked: sGiven.values[givenIdx] === s0.values[givenIdx],
  clickCounted: sCycle3.inputs >= 3 && sGiven.inputs > sCycle3.inputs,
  slipCounted: !!sViol && sViol.mistakes > sPreViol.mistakes && sViol.violations.length > 0 && sViol.wrong[violCell] === true,
  dupsDropped: dupAfter.dups >= 1 && dupAfter.filled === dupBefore.filled + 1 && dupAfter.values[dupTarget] === 0,
  nearTerminal: !!winSetup && winSetup.empty === 1 && winSetup.over === false,
  won: sWin.over === true && sWin.won === true && sWin.solved === true && winSheet.open === true && /solved/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && sLose.mistakes >= 3 && loseSheet.open === true && /busted/i.test(loseSheet.title),
  restarted: sNew.over === false && sNew.mistakes === 0 && sNew.empty > 0,
  keyRestart: sR.over === false && sR.mistakes === 0 && sR.empty > 0,
  touchPlaced: sTouch.values[tBlank] === 0 && sTouch.filled === tState.filled + 1,
  onScreen: inScreen(pFirst, 1280, 800),
  touchOnScreen: inScreen(tPt, 390, 844) && inScreen(tCorner, 390, 844),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { level: s0.level, blanks: blanks.length, filled: s0.filled, camera: s0.camera },
  sCycle: [sCycle1.values[blanks[0]], sCycle2.values[blanks[0]], sCycle3.values[blanks[0]]],
  violPlan, sPreViol: { mistakes: sPreViol.mistakes }, sViol: sViol && { mistakes: sViol.mistakes, violations: sViol.violations.length },
  dup: { before: dupBefore.filled, after: dupAfter.filled, dups: dupAfter.dups, val: dupAfter.values[dupTarget] },
  winSetup, winSheet, sWin: { over: sWin.over, won: sWin.won, solved: sWin.solved, mistakes: sWin.mistakes },
  losePlan, loseSheet, sLose: { over: sLose.over, mistakes: sLose.mistakes },
  sNew: { empty: sNew.empty, mistakes: sNew.mistakes }, sR: { empty: sR.empty, mistakes: sR.mistakes },
  sTouch: { filled: sTouch.filled, at: sTouch.values[tBlank] },
  pFirst, tPt, tCorner,
  shots: [shotBoot, shotMid, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
