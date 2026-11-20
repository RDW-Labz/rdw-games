#!/usr/bin/env node
// Interaction gate for the Tri Peaks port: real CDP mouse taps on the pyramid and the stock,
// state-hook assertions for a card taken / the stock drawn / a blocked card refusing, plus
// QA win and lose sheets, restart, and a portrait touch pass.
//   node tripeaks-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || (process.env.HOME + '/kaos/work/site'));
const FILE = 'games/arcade/tri-peaks/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
    });
  }
}

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); T((cond ? 'ok   ' : 'FAIL ') + msg); };

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/tp-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((res, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
if (!pageTarget) throw new Error('no page target');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');

const server = await serve();
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
const title = await (await fetch(`${BASE}/${FILE}`)).text();
if (!/<title>Tri Peaks Solitaire/.test(title)) throw new Error('served page is not the port');
T('serving ' + BASE);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
};
const clickEl = async (sel) => {
  const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b) throw new Error('no element ' + sel);
  await click(b);
  return b;
};
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('shot ' + out);
  return out;
};
const st = () => ev('window.__tripeaks()');

await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `${BASE}/${FILE}` });
await sleep(5200);

// ---- 1) boot ----
ok((await ev('typeof window.__tripeaks')) === 'function', 'hook is a function the catalog gate can probe');
const s0 = await st();
ok(s0 && s0.left === 30 && s0.stock === 21 && s0.passes === 2, 'boot deal is 30 cards / 22 stock (1 on the waste) / 2 passes: ' + JSON.stringify(s0 && { l: s0.left, s: s0.stock, p: s0.passes }));
ok(s0 && s0.waste && typeof s0.waste.r === 'number', 'boot deal has an opening waste card');
ok(s0 && s0.playable > 0, 'boot deal opens with a legal move (playable ' + (s0 && s0.playable) + ')');
ok(s0 && s0.over === false, 'boot deal is not over');
await shot('tripeaks-gate-boot');

// ---- 2) a real click takes a playable card ----
const pick = await ev('(()=>{const p=window.__tripeaks.playable();if(!p.length)return null;return {i:p[0],pt:window.__tripeaks.aim(p[0])};})()');
ok(!!pick, 'a playable apex card exists to tap');
ok(pick && pick.pt && pick.pt.x > 0 && pick.pt.y > 0, 'aim() resolves a screen point for card ' + (pick && pick.i));
const aimAgrees = await ev(`window.__tripeaks.pickAt(${pick.pt.x},${pick.pt.y})`);
ok(aimAgrees === pick.i, 'aim() point picks back the same card (' + aimAgrees + ' vs ' + pick.i + ')');
await click(pick.pt);
const s1 = await st();
ok(s1.left === 29 && s1.moves === 1, 'real click cleared one card (left ' + s1.left + ', moves ' + s1.moves + ')');
ok(s1.inputs === 1 && s1.dups === 0, 'exactly one input, no phantom duplicates (' + s1.inputs + '/' + s1.dups + ')');
ok(s1.live[pick.i] === 0, 'the tapped card is gone from the live mask');
ok(s1.waste && s1.waste.r === s0.ranks[pick.i], 'the waste took the played rank');
await shot('tripeaks-gate-play');

// ---- 3) tapping the stock deals the next card ----
const sp = await ev('window.__tripeaks.stockPoint()');
await click(sp);
const s2 = await st();
ok(s2.stock === s1.stock - 1 && s2.draws === 1, 'stock tap drew a card (stock ' + s2.stock + ', draws ' + s2.draws + ')');
ok(s2.moves === 1, 'drawing does not spend a move');

// ---- 4) a blocked (covered) card refuses ----
const blockedCard = await ev(`(()=>{
  const s = window.__tripeaks();
  for (let i = 0; i < s.live.length; i++) if (!s.live[i]) continue;
  const open = window.__tripeaks.open();
  for (let i = 0; i < s.live.length; i++) if (s.live[i] && !open.includes(i)) return { i, pt: window.__tripeaks.aim(i) };
  return null;
})()`);
ok(!!blockedCard, 'a covered card exists on the board');
if (blockedCard) {
  const before = await st();
  await click(blockedCard.pt);
  const after = await st();
  ok(after.left === before.left && after.moves === before.moves, 'covered card did nothing to the board');
  ok(after.blocked > before.blocked, 'covered card was counted as a blocked tap (' + after.blocked + ')');
}

// ---- 5) win through a real click on a QA position ----
const setupWin = await ev(`window.__tripeaks.setup({keep:[[0,4,0]],waste:[5,0],stock:[],passes:0})`);
ok(setupWin && setupWin.left === 1 && setupWin.over === false, 'QA win position loaded (left ' + (setupWin && setupWin.left) + ')');
const winPt = await ev('window.__tripeaks.aim(0)');
await click(winPt);
const sWin = await st();
const winSheet = await sheet();
ok(sWin.won === true && sWin.left === 0, 'last card cleared the peaks');
ok(winSheet.open && /cleared/i.test(winSheet.title), 'win sheet opened: ' + JSON.stringify(winSheet));
await shot('tripeaks-gate-win');

// ---- 6) lose through the QA position ----
await ev(`window.__tripeaks.setup({keep:[[0,4,0]],waste:[9,0],stock:[],passes:0})`);
await sleep(200);
const sLose = await st();
const loseSheet = await sheet();
ok(sLose.lost === true && sLose.over === true, 'stranded board flagged as a loss');
ok(loseSheet.open && /no moves/i.test(loseSheet.title), 'lose sheet opened: ' + JSON.stringify(loseSheet));
await shot('tripeaks-gate-lose');

// ---- 7) the sheet's own buttons restart ----
await clickEl('#overBtn');
const sRestart = await st();
ok(sRestart.left === 30 && sRestart.over === false && sRestart.won === false, 'Play again dealt a fresh board (' + sRestart.left + ')');
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(400);
const sR = await st();
ok(sR.left === 30 && sR.moves === 0, 'R dealt a fresh board');

// ---- 8) a pass is spent when the stock runs out ----
await ev(`window.__tripeaks.setup({keep:[[0,4,0],[1,6,0]],waste:[2,0],stock:[5,6],passes:1})`);
const pv = await st();
ok(pv.passes === 1 && pv.stock === 1, 'QA two-card position: 1 stock left, 1 pass (' + pv.stock + '/' + pv.passes + ')');
const sp2 = await ev('window.__tripeaks.stockPoint()');
await click(sp2);              // draws the last card
const sDraw = await st();
await click(sp2);              // stock empty -> starts a new pass
const sPass = await st();
ok(sPass.passes === 0 && sDraw.stock === 0, 'emptying the stock then tapping it spends a pass (' + sDraw.stock + ' -> passes ' + sPass.passes + ')');

// ---- 9) console errors ----
const errors = pageCdp.events
  .filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
ok(!errors, 'no console errors: ' + errors);

// ---- 10) portrait touch ----
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `${BASE}/${FILE}` });
await sleep(5200);
const sP = await st();
ok(sP && sP.left === 30, 'portrait boot dealt 30 cards');
const pPick = await ev('(()=>{const p=window.__tripeaks.playable();if(!p.length)return null;return {i:p[0],pt:window.__tripeaks.aim(p[0])};})()');
ok(!!pPick, 'portrait board has a playable card');
const tapAt = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(340);
};
if (pPick) await tapAt(pPick.pt);
const sT = await st();
ok(sT.left === 29, 'touch tap took a card on a 390x844 phone (left ' + sT.left + ')');
const inBand = await ev(`(()=>{
  const r = document.querySelector('canvas').getBoundingClientRect();
  const bad = [];
  for (let i = 0; i < 30; i++) { const p = window.__tripeaks.aim(i); if (p.x < 0 || p.x > r.width || p.y < 0 || p.y > r.height) bad.push(i); }
  return bad;
})()`);
ok(Array.isArray(inBand) && inBand.length === 0, 'every card aims inside the viewport: ' + JSON.stringify(inBand));
const shotPhone = await shot('tripeaks-gate-phone');

server.close();
proc.kill('SIGKILL');
console.log(fails.length ? `\nGATE FAIL (${fails.length}):\n - ` + fails.join('\n - ') : '\nGATE PASS');
process.exit(fails.length ? 1 : 0);
