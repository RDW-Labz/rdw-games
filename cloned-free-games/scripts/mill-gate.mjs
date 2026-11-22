#!/usr/bin/env node
// Interaction gate for the Mill (Nine Men's Morris) port. Real CDP mouse clicks on the board,
// state-hook assertions for placing, the cpu reply, a mill + a removal, undo, the win / lose /
// draw sheets, the difficulty control, the double-tap guard, restart, plus a portrait touch pass.
// usage: node mill-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/mill/index.html';
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
const PROFILE = mkdtempSync('/tmp/mill-gate-');
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
// Drive the page target directly: browser-level Target.createTarget hangs on this build.
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const S = (m, p) => pageCdp.send(m, p);
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const until = async (fn, ms = 12000, step = 250) => {
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
const pointOf = (i) => ev(`window.__mill.point(${i})`);
const clickPoint = async (i, wait = 260) => {
  const p = await pointOf(i);
  if (!p || p.__err) return { err: p && p.__err, p };
  await click(p);
  await sleep(wait);
  return p;
};
const clickEl = async (id, wait = 320) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(wait);
  return b;
};
const state = () => ev('window.__mill()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---------- 1) boot ----------
const hookType = await ev('typeof window.__mill');
const rules = await ev('window.__mill.rules()');
const s0 = await state();
const shotBoot = await shot('mill-gate-boot');
T('boot ' + JSON.stringify({ hookType, rules: rules && rules.pts + '/' + rules.mills, turn: s0 && s0.turn, men: s0 && s0.men }));
ok(hookType === 'function', 'the state hook is a function (catalog gate reads typeof frame.__hook)', hookType);
ok(rules && rules.pts === 24 && rules.mills === 16, 'a 24-point, 16-mill board', rules);
ok(s0 && s0.turn === 0 && s0.hand[0] === 9 && s0.phase === 'place', 'boot is the visitor placing first', s0 && { turn: s0.turn, hand: s0.hand, phase: s0.phase });

// ---------- 2) a real click places a man and the cpu answers ----------
const p0 = await clickPoint(0);
const sA = await until(async () => { const s = await state(); return s && s.p[0] === 0 ? s : null; }, 6000);
const sB = await until(async () => { const s = await state(); return s && s.turn === 0 && s.moves >= 2 ? s : null; }, 12000);
T('place ' + JSON.stringify({ p0, a: sA && sA.moves, b: sB && { moves: sB.moves, hand: sB.hand, men: sB.men, turn: sB.turn } }));
ok(sA && sA.p[0] === 0 && sA.inputs >= 1, 'a real click on point 0 places the visitor\'s man', sA && { p0: sA.p[0], inputs: sA.inputs });
ok(sB && sB.moves >= 2 && sB.turn === 0, 'the cpu answers and hands the turn back', sB && { moves: sB.moves, turn: sB.turn });
ok(sB && sB.hand[1] === 8, 'the cpu placed one of its nine men', sB && sB.hand);
const shotPlay = await shot('mill-gate-play');

// ---------- 3) undo returns to the visitor ----------
const beforeUndo = await state();
await clickEl('undo');
const afterUndo = await state();
T('undo ' + JSON.stringify({ before: beforeUndo.moves, after: afterUndo.moves, turn: afterUndo.turn }));
ok(afterUndo.moves < beforeUndo.moves && afterUndo.turn === 0, 'undo takes back to the visitor\'s turn', { before: beforeUndo.moves, after: afterUndo.moves, turn: afterUndo.turn });

// ---------- 4) a mill, then a removal ----------
// QA position: two men on the outer top row, one empty, one man in hand; the cpu holds four
// loose men (9, 10, 13, 21) so it both has a man to lose and still has three to play on with.
const millSetup = { p: new Array(24).fill(-1), hand: [1, 0], turn: 0 };
millSetup.p[0] = 0; millSetup.p[1] = 0;
for (const i of [9, 10, 13, 21]) millSetup.p[i] = 1;
await ev(`window.__mill.setup(${JSON.stringify(millSetup)})`);
await sleep(300);
const sPre = await state();
const pt2 = await clickPoint(2);
const sMill = await until(async () => { const s = await state(); return s && s.remove ? s : null; }, 6000);
T('mill ' + JSON.stringify({ pre: sPre && sPre.p.slice(0, 3), after: sMill && { p: sMill.p.slice(0, 3), mills: sMill.mills, remove: sMill.remove } }));
ok(sMill && sMill.p[2] === 0 && sMill.mills[0] === 1 && sMill.remove === true, 'completing three in a line opens the removal', sMill && { p: sMill.p.slice(0, 3), mills: sMill.mills, remove: sMill.remove });
// the protected-man rule: the cpu men sit loose on 13 and 21, so either is takable
const pt13 = await clickPoint(13);
const sTake = await until(async () => { const s = await state(); return s && s.men[1] === 3 ? s : null; }, 6000);
T('take ' + JSON.stringify({ pt13, take: sTake && { men: sTake.men, taken: sTake.taken, remove: sTake.remove, turn: sTake.turn } }));
ok(sTake && sTake.men[1] === 3 && sTake.taken[0] === 1 && sTake.remove === false, 'tapping a loose cpu man removes it', sTake && { men: sTake.men, taken: sTake.taken, remove: sTake.remove });
const shotMill = await shot('mill-gate-mill');

// ---------- 5) the cpu answers the mill turn ----------
const sReply = await until(async () => { const s = await state(); return s && s.turn === 0 && !s.thinking && s.moves >= 2 ? s : null; }, 12000);
ok(sReply !== null, 'the cpu replies after the removal', sReply && { moves: sReply.moves, turn: sReply.turn });

// ---------- 6) the three sheets ----------
const twoLeft = { p: new Array(24).fill(-1), hand: [0, 0], turn: 0 };
twoLeft.p[0] = 0; twoLeft.p[1] = 0; twoLeft.p[9] = 1; twoLeft.p[10] = 1; twoLeft.p[11] = 1; twoLeft.p[12] = 1;
await ev(`window.__mill.setup(${JSON.stringify(twoLeft)})`);
await sleep(400);
const loseState = await state();
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ over: loseState && loseState.over, result: loseState && loseState.result, sheet: loseSheet }));
ok(loseState && loseState.over && loseState.result === 'lose', 'two men left ends the game as a loss', loseState && { over: loseState.over, result: loseState.result, why: loseState.why });
ok(loseSheet && loseSheet.open && /cpu takes it/i.test(loseSheet.title), 'the loss sheet opens with its own title', loseSheet);
const shotLose = await shot('mill-gate-lose');

const cpuTwo = { p: new Array(24).fill(-1), hand: [0, 0], turn: 1 };
cpuTwo.p[0] = 0; cpuTwo.p[1] = 0; cpuTwo.p[2] = 0; cpuTwo.p[3] = 0; cpuTwo.p[9] = 1; cpuTwo.p[10] = 1;
await ev(`window.__mill.setup(${JSON.stringify(cpuTwo)})`);
await sleep(400);
const winState = await state();
const winSheet = await sheet();
T('win ' + JSON.stringify({ over: winState && winState.over, result: winState && winState.result, sheet: winSheet }));
ok(winState && winState.over && winState.result === 'win', 'the cpu down to two men is a win', winState && { over: winState.over, result: winState.result });
ok(winSheet && winSheet.open && /you win/i.test(winSheet.title), 'the win sheet opens with its own title', winSheet);

const quietDraw = { p: new Array(24).fill(-1), hand: [0, 0], turn: 0, quiet: 40 };
quietDraw.p[0] = 0; quietDraw.p[1] = 0; quietDraw.p[2] = 0; quietDraw.p[3] = 0; quietDraw.p[9] = 1; quietDraw.p[10] = 1; quietDraw.p[11] = 1;
await ev(`window.__mill.setup(${JSON.stringify(quietDraw)})`);
await sleep(400);
const drawState = await state();
const drawSheet = await sheet();
T('draw ' + JSON.stringify({ over: drawState && drawState.over, result: drawState && drawState.result, sheet: drawSheet }));
ok(drawState && drawState.over && drawState.result === 'draw', 'forty quiet moves end the game as a draw', drawState && { over: drawState.over, result: drawState.result });
ok(drawSheet && drawSheet.open && /draw/i.test(drawSheet.title), 'the draw sheet opens', drawSheet);

// the sheet's own Play again button must restart (the backdrop covers the bottom bar)
await clickEl('overBtn');
const afterRestart = await state();
ok(afterRestart && afterRestart.over === false && afterRestart.moves === 0 && afterRestart.quiet === 0, 'Play again restarts a clean game', afterRestart && { over: afterRestart.over, moves: afterRestart.moves, quiet: afterRestart.quiet });

// ---------- 7) difficulty control ----------
const levelClick = await ev(`(()=>{const e=document.getElementById('level');e.value='steady';e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
const sLevel = await state();
T('level ' + JSON.stringify({ value: levelClick, hook: sLevel && sLevel.level }));
ok(levelClick === 'steady' && sLevel && sLevel.level === 'steady', 'the difficulty control reaches the cpu chooser', { value: levelClick, level: sLevel && sLevel.level });
await ev(`window.__mill.setLevel('sharp')`);

// ---------- 8) the double-tap guard ----------
await ev(`window.__mill.setup(${JSON.stringify({ p: new Array(24).fill(-1), hand: [9, 9], turn: 0 })})`);
await sleep(250);
const beforeDup = await state();
const dupPoint = await pointOf(4);
await ev(`(()=>{const p=${JSON.stringify(dupPoint)};
  const c=document.querySelector('canvas');
  const mk=(t)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,pointerId:7,pointerType:'touch',isPrimary:true});
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  c.dispatchEvent(mk('pointerdown')); c.dispatchEvent(mk('pointerup'));
  return true;})()`);
await sleep(400);
const afterDup = await state();
T('dup ' + JSON.stringify({ before: { inputs: beforeDup.inputs, dups: beforeDup.dups }, after: { inputs: afterDup.inputs, dups: afterDup.dups, p4: afterDup.p[4] } }));
ok(afterDup.dups >= 1 && afterDup.inputs === beforeDup.inputs + 1, 'a same-point double tap is counted once', { before: beforeDup.inputs, after: afterDup.inputs, dups: afterDup.dups });

// ---------- 9) portrait touch ----------
await ev(`window.__mill.newGame('cpu')`);
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(900);
const geom = await ev(`(()=>{const c=document.querySelector('canvas').getBoundingClientRect();
  const pts=[0,2,4,6,8,10,16,18,20,22].map(i=>window.__mill.point(i));
  const top=document.querySelector('.top').getBoundingClientRect(), bot=document.querySelector('.bottom').getBoundingClientRect();
  return {canvas:{x:c.x,y:c.y,w:c.width,h:c.height},top:top.bottom,bot:bot.top,pts};})()`);
const inside = geom.pts.every((p) => p && p.x > 0 && p.x < 390 && p.y > geom.top && p.y < geom.bot);
T('portrait ' + JSON.stringify({ canvas: geom.canvas, top: geom.top, bot: geom.bot, first: geom.pts[0] }));
ok(inside, 'every sampled point projects into the band the hud leaves on a 390x844 phone', geom);
const ptP = await clickPoint(8, 400);
const sPortrait = await until(async () => { const s = await state(); return s && s.p[8] === 0 ? s : null; }, 6000);
ok(sPortrait !== null, 'a touch on the portrait board places a man', { ptP, st: sPortrait && { p8: sPortrait.p[8], turn: sPortrait.turn } });
const shotPortrait = await shot('mill-gate-portrait');

// ---------- 10) console errors ----------
const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
const errText = errors.map((e) => JSON.stringify(e.params).slice(0, 240));
T('console errors ' + errText.length + (errText.length ? ' ' + errText.join(' | ') : ''));
ok(errText.length === 0, 'no console errors during the whole run', errText);

proc.kill('SIGKILL');
server.close();
console.log('\nshots: ' + [shotBoot, shotPlay, shotMill, shotLose, shotPortrait].join(' '));
if (fails.length) { console.error(`\nMILL GATE FAILED (${fails.length})`); fails.forEach((f) => console.error(' - ' + f)); process.exit(1); }
console.log('MILL GATE PASS');
