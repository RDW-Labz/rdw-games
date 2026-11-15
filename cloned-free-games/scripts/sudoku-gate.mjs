#!/usr/bin/env node
// Interaction gate for the Sudoku port: real CDP mouse/touch input on the 3D board,
// state-hook assertions for select / place / mistake / win / lose / restart, screenshots.
// usage: node sudoku-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage');
const FILE = 'games/arcade/sudoku.html';
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/sudoku-gate-');
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
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
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
const clickCell = async (r, c) => {
  const p = await ev(`window.__sudoku.tilePoint(${r},${c})`);
  await click(p);
  await sleep(200);
  return p;
};
const ptOf = async (id) => ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const clickEl = async (id) => { const b = await ptOf(id); if (b) await click(b); await sleep(260); return b; };
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const sheet = async () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);

// ---- 1) boot: a real 9x9 board with givens and empties, digits consistent with the solution
const s0 = await ev('window.__sudoku()');
const cam0 = await ev('window.__sudoku.camera()');
const shotBoot = await shot('sudoku-gate-boot');

// every given must agree with the solution, and the board must have holes to fill
const firstEmpty = s0.values.split('').findIndex((v) => v === '0');
const emptyR = (firstEmpty / 9) | 0, emptyC = firstEmpty % 9;
const cornerPts = {};
for (const [k, r, c] of [['tl', 0, 0], ['tr', 0, 8], ['bl', 8, 0], ['br', 8, 8], ['mid', 4, 4]])
  cornerPts[k] = await ev(`window.__sudoku.tilePoint(${r},${c})`);

// ---- 2) a real click selects a square, and a pad click fills it
await clickCell(emptyR, emptyC);
const sSel = await ev('window.__sudoku()');
const correctDigit = Number(s0.solution[firstEmpty]);
await clickEl(`pad${correctDigit}`);
const sFill = await ev('window.__sudoku()');
const shotFill = await shot('sudoku-gate-place');

// ---- 3) a wrong entry counts a mistake (and does not silently pass)
await clickCell(emptyR, emptyC);
const wrongDigit = (correctDigit % 9) + 1;
await clickEl(`pad${wrongDigit}`);
const sWrong = await ev('window.__sudoku()');

// ---- 4) win: load a position one square short, click it, type the digit -> Solved sheet
await ev(`(()=>{const s=window.__sudoku().solution;const p=s.split('').map((d,i)=>i===80?'.':d).join('');return window.__sudoku.load(p,s);})()`);
await sleep(400);
await ev('window.__sudoku.setMistakes(0)');
const sNear = await ev('window.__sudoku()');
await clickCell(8, 8);
await clickEl(`pad${Number(s0.solution[80])}`);
await sleep(400);
const sWin = await ev('window.__sudoku()');
const winSheet = await sheet();
const shotWin = await shot('sudoku-gate-win');

// ---- 5) lose: three mistakes. Load the same near-complete board, click it, type wrong digits.
await ev(`(()=>{const s=window.__sudoku().solution;const p=s.split('').map((d,i)=>i===80?'.':d).join('');window.__sudoku.load(p,s);window.__sudoku.setMistakes(2);return true;})()`);
await sleep(400);
await clickCell(8, 8);
await clickEl(`pad${(Number(s0.solution[80]) % 9) + 1}`);
await sleep(400);
const sLose = await ev('window.__sudoku()');
const loseSheet = await sheet();
const shotLose = await shot('sudoku-gate-lose');

// ---- 6) restart from the sheet, then the R key
await clickEl('overBtn');
await sleep(700);
const sNew = await ev('window.__sudoku()');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(600);
const sR = await ev('window.__sudoku()');

// ---- 7) keyboard play: select a hole, type its digit
const hole2 = sR.values.split('').findIndex((v) => v === '0');
await ev(`window.__sudoku.select(${hole2})`);
const kd = Number(sR.solution[hole2]);
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: `Digit${kd}`, key: String(kd), windowsVirtualKeyCode: 48 + kd, text: String(kd) });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: `Digit${kd}`, key: String(kd), windowsVirtualKeyCode: 48 + kd });
await sleep(300);
const sKey = await ev('window.__sudoku()');

// ---- 8) touch: portrait phone, tap a square then tap a pad button
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(6500);
const tState = await ev('window.__sudoku()');
const tHole = tState.values.split('').findIndex((v) => v === '0');
const tDigit = Number(tState.solution[tHole]);
const tPt = await ev(`window.__sudoku.tilePoint(${(tHole / 9) | 0},${tHole % 9})`);
const tEdge = await ev('window.__sudoku.tilePoint(0,8)');
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
};
await tap(tPt);
const tSel = await ev('window.__sudoku()');
const tPad = await ptOf(`pad${tDigit}`);
await tap(tPad);
await sleep(300);
const sTouch = await ev('window.__sudoku()');
const shotTouch = await shot('sudoku-gate-touch');
const errors = errorsOf();

const parse = (s) => (s && s.values ? s.values : '');
const checks = {
  boot: !!s0 && s0.givens >= 20 && s0.givens <= 60 && s0.empty > 20 && s0.over === false && s0.wrong === 0,
  bootConsistent: (() => { const v = parse(s0), sol = s0.solution || ''; for (let i = 0; i < 81; i++) if (v[i] !== '0' && v[i] !== sol[i]) return false; return v.length === 81; })(),
  onScreen: Object.values(cornerPts).every((p) => p && p.x > 6 && p.x < 1274 && p.y > 6 && p.y < 794),
  selected: sSel.sel === firstEmpty,
  placed: sFill.values[firstEmpty] === String(correctDigit) && sFill.filled === s0.filled + 1 && sFill.mistakes === 0,
  mistakeCounted: sWrong.mistakes === 1 && sWrong.wrong === 1,
  nearTerminal: sNear.empty === 1 && sNear.over === false,
  won: sWin.over === true && sWin.won === true && sWin.correct === true && winSheet.open === true && /solved/i.test(winSheet.title),
  lost: sLose.over === true && sLose.won === false && sLose.mistakes >= 3 && loseSheet.open === true && /stuck/i.test(loseSheet.title),
  restarted: sNew.over === false && sNew.empty > 20 && sNew.mistakes === 0 && sNew.wrong === 0,
  keyRestart: sR.over === false && sR.empty > 20 && sR.mistakes === 0,
  keyPlaced: sKey.values[hole2] === String(kd) && sKey.filled === sR.filled + 1,
  touchSelected: tSel.sel === tHole,
  touchPlaced: sTouch.values[tHole] === String(tDigit) && sTouch.filled === tState.filled + 1,
  touchOnScreen: tPt && tEdge && [tPt, tEdge].every((p) => p && p.x > 4 && p.x < 386 && p.y > 4 && p.y < 840),
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors,
  s0: { givens: s0.givens, empty: s0.empty, filled: s0.filled, level: s0.level },
  cam0,
  firstEmpty: { idx: firstEmpty, r: emptyR, c: emptyC, digit: correctDigit },
  sSel: { sel: sSel.sel }, sFill: { mistakes: sFill.mistakes, filled: sFill.filled },
  sWrong: { mistakes: sWrong.mistakes, wrong: sWrong.wrong },
  winSheet, sWin: { over: sWin.over, won: sWin.won, correct: sWin.correct, elapsed: sWin.elapsed },
  loseSheet, sLose: { over: sLose.over, mistakes: sLose.mistakes },
  sNew: { empty: sNew.empty, givens: sNew.givens }, sR: { empty: sR.empty },
  sKey: { filled: sKey.filled, at: sKey.values[hole2] },
  sTouch: { filled: sTouch.filled, at: sTouch.values[tHole] },
  cornerPts,
  shots: [shotBoot, shotFill, shotWin, shotLose, shotTouch],
}, null, 1));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
