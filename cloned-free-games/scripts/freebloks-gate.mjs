#!/usr/bin/env node
// Interaction gate for the Freebloks (Blokus) port: real CDP pointer clicks on the tray, the
// board and the HUD, with every assertion read from the port's own state hook — select, place,
// cpu reply, rotate, flip, pass, win sheet, lose sheet, restart, and a 390x844 portrait touch.
// usage: node scripts/freebloks-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/freebloks/index.html';
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

let fails = 0, checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (!cond) { fails++; console.log('FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
  else console.log('ok    ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return cond;
};

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/freebloks-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((okc, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 180000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); okc(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools up');
process.on('unhandledRejection', (e) => { proc.kill('SIGKILL'); throw e; });
process.on('SIGTERM', () => proc.kill('SIGKILL'));

const server = await serve();
const port = server.address().port;
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page');
const pageCdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
const S = (m, p) => pageCdp.send(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const t = Date.now();
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (Date.now() - t > 500) T('slow eval ' + (Date.now() - t) + 'ms: ' + expr.slice(0, 50));
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || 'eval error').slice(0, 300) };
  return r.result?.value;
};
const hook = () => ev('window.__freebloks()');

async function waitFor(expr, ms = 60000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    if (v) { T('ready after ' + (Date.now() - t0) + 'ms: ' + String(expr).slice(0, 60)); return v; }
    await sleep(step);
  }
  throw new Error('timeout waiting for ' + expr);
}

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable'); await S('Network.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const tNav = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await waitFor("typeof window.__freebloks === 'function'", 90000);
T('hook booted in ' + (Date.now() - tNav) + 'ms');

const click = async (pt) => {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('bad click point ' + JSON.stringify(pt));
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(170);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');if(!e)return null;e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    const t=document.elementFromPoint(x,y);
    return {x,y,w:Math.round(r.width),h:Math.round(r.height),top:t?(t.id||t.tagName.toLowerCase()):'none',dis:!!e.disabled};})()`);
  if (!b || b.__err) throw new Error('no element #' + id + ' ' + JSON.stringify(b));
  T('click #' + id + ' at ' + JSON.stringify(b));
  await click(b);
  return b;
};
const clickChip = async (i) => {
  const b = await ev(`(()=>{const e=document.querySelectorAll('#tray .piece')[${i}];if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!b || b.__err) throw new Error('no chip ' + i + ' ' + JSON.stringify(b));
  await click(b);
  return b;
};
const tapCell = async (x, y) => {
  const p = await ev(`window.__freebloks.tilePoint(${x},${y})`);
  if (!p || p.__err) throw new Error('no tilePoint ' + JSON.stringify(p));
  T('tap cell ' + x + ',' + y + ' at ' + JSON.stringify(p));
  await click({ x: p.x, y: p.y });
  return p;
};
const sheet = () => ev(`(()=>{const o=document.getElementById('over');return {open:o.classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent};})()`);
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('shot ' + out);
  return out;
};

// ---- 1) boot
const s0 = await hook();
ok(s0 && s0.W === 14 && s0.H === 14 && s0.players === 2, 'boots as Duo 14x14 / 2 seats', s0 && { W: s0.W, H: s0.H, players: s0.players });
ok(s0.empty === 196, 'the board starts empty', s0.empty);
ok(s0.over === false && s0.turn === 0 && s0.moves === 0, 'a fresh board is live, human to move', { over: s0.over, turn: s0.turn, moves: s0.moves });
ok(Array.isArray(s0.placed) && s0.placed.join(',') === '0,0', 'neither seat has placed a tile', s0.placed);
ok(s0.cells.join(',') === '0,0', 'no cells are claimed', s0.cells);
const legal0 = await ev('window.__freebloks.legal()');
ok(legal0 > 0, 'the opening has legal moves', legal0);
const shotBoot = await shot('freebloks-gate-boot');

// ---- 2) pick a piece whose orientation actually changes
const pick = await ev(`(()=>{for(let i=0;i<21;i++){const n=window.__freebloks.orientCount(i);const s=window.__freebloks.pieceSize(i);if(n>=4&&s>=4)return {i,n,s};}return null;})()`);
ok(!!pick, 'found a 4+ cell piece with several orientations', pick);
const size = pick.s;
await clickChip(pick.i);
const s1 = await hook();
ok(s1.sel === pick.i, 'tapping a tray piece selects it', { sel: s1.sel, want: pick.i });
ok(s1.ghost && s1.ghost.ok === true, 'the selected piece parks a legal ghost on the opening marker', s1.ghost);
ok(JSON.stringify(s1.ghost) === JSON.stringify({ x: 4, y: 4, ok: true }), 'the ghost sits on the human start square (4,4)', s1.ghost);

// ---- 3) place it with a real click on the board
const s1ori = s1.ori;
await tapCell(4, 4);
const s2 = await hook();
ok(s2.inputs === 1, 'one accepted board tap', s2.inputs);
ok(s2.placed[0] === 1 && s2.cells[0] === size, 'the piece landed (cells match its size)', { placed: s2.placed, cells: s2.cells, size });
ok(s2.turn === 1, 'the turn passes to the cpu', s2.turn);
ok(s2.empty === 196 - size, 'the board lost exactly that many squares', { empty: s2.empty, want: 196 - size });
ok(s2.sel === -1, 'the selection is cleared after placing', s2.sel);
const shotPlaced = await shot('freebloks-gate-placed');

// ---- 4) the cpu answers on its own
await waitFor('(()=>{const s=window.__freebloks();return s.busy===false && s.turn===0 && (s.over || s.cells[1]>0) && true;})()', 30000);
const s3 = await hook();
ok(s3.cells[1] > 0 || s3.over, 'the cpu answered with a real placement', { cells: s3.cells, over: s3.over });
ok(s3.turn === 0 && !s3.over, 'control is back with the human', { turn: s3.turn, over: s3.over });
const shotMid = await shot('freebloks-gate-mid');

// ---- 5) rotate + flip change the footprint
const pick2 = await ev(`(()=>{const L=window.__freebloks().leftIdx[0];for(const i of L){if(window.__freebloks.orientCount(i)===8)return i;}return L.length?L[0]:-1;})()`);
ok(pick2 >= 0, 'an unused piece with 8 orientations is available', pick2);
await clickChip(pick2);
const s4 = await hook();
ok(s4.sel === pick2, 'a second piece can be selected', { sel: s4.sel, want: pick2 });
const oriBefore = s4.ori;
await clickEl('rot');
const s5 = await hook();
ok(s5.ori !== oriBefore, 'Rotate changes the orientation', { before: oriBefore, after: s5.ori });
const flipBefore = s5.ori;
await clickEl('flip');
const s6 = await hook();
ok(s6.ori !== flipBefore, 'Flip mirrors the piece', { before: flipBefore, after: s6.ori });
// rotate back to a known-good orientation and place next to the first piece
const rotated = s6.ori;
ok(rotated >= 0 && rotated < 8, 'the orientation index stays in range', rotated);

// ---- 6) a blocked tap is refused without changing the board
const before = await hook();
await tapCell(0, 0);   // far from any own tile
const afterBad = await hook();
ok(afterBad.blocked > before.blocked, 'an illegal placement is counted as blocked', { blocked: afterBad.blocked });
ok(afterBad.cells[0] === before.cells[0], 'the illegal tap changed nothing on the board', { before: before.cells, after: afterBad.cells });
ok(afterBad.taps > before.taps, 'the refused tap still reached the picker', { taps: afterBad.taps });

// ---- 7) Pass hands the turn over and the cpu plays on
const s7 = await hook();
const passesBefore = s7.passesPlayed;
const cpuCellsBefore = s7.cells[1];
await clickEl('pass');
await sleep(400);
await waitFor(`(()=>{const s=window.__freebloks();return s.busy===false&&s.turn===0&&(s.over||s.cells[1]>${cpuCellsBefore});})()`, 30000).catch(() => null);
const s8 = await hook();
ok(s8.passesPlayed > passesBefore, 'Pass was recorded', { before: passesBefore, after: s8.passesPlayed });
ok(s8.cells[1] > cpuCellsBefore || s8.over, 'the cpu took its turn after the pass', { before: cpuCellsBefore, after: s8.cells[1] });

// ---- 8) double-tap guard: two pointerups dispatched inside one page tick
const dup = await ev(`(()=>{const p=window.__freebloks.tilePoint(4,4);
  const fire=()=>document.body.dispatchEvent(new PointerEvent('pointerup',{clientX:p.x,clientY:p.y,bubbles:true,pointerType:'mouse'}));
  const b=window.__freebloks(); fire(); fire(); const a=window.__freebloks();
  return {dups:a.dups-b.dups, inputs:a.inputs-b.inputs, taps:a.taps-b.taps};})()`);
ok(dup.dups >= 1, 'the second same-point pointerup is dropped as a duplicate', dup);

// ---- 9) win: the page's endgame position, finished with real clicks
await ev("window.__freebloks.setup('endgame-win')");
await sleep(300);
const w0 = await hook();
ok(w0.over === false && w0.turn === 0, 'the endgame position is live and waiting for the human', { over: w0.over, turn: w0.turn });
ok(w0.left[0] === 1 && w0.left[1] === 0, 'one piece left for the human, none for the cpu', w0.left);
await clickChip(20);
const w1 = await hook();
ok(w1.sel === 20, 'the last piece (monomino) selects', w1.sel);
await tapCell(4, 2);
await sleep(400);
const w2 = await hook();
const winSheet = await sheet();
ok(w2.over === true, 'placing the last tile ends the game', { over: w2.over });
ok(w2.result === 'win', 'the human wins the endgame position', w2.result);
ok(winSheet.open === true && /you win/i.test(winSheet.title), 'the win sheet opens', winSheet.title);
ok(Array.isArray(w2.final) && w2.final[0] > w2.final[1], 'final scores favour the human', w2.final);
const shotWin = await shot('freebloks-gate-win');

// ---- 10) restart from the sheet
await clickEl('overBtn');
await sleep(400);
const r0 = await hook();
const rSheet = await sheet();
ok(r0.over === false && r0.moves === 0 && r0.empty === 196, 'Play again clears the board', { over: r0.over, moves: r0.moves, empty: r0.empty });
ok(rSheet.open === false, 'the sheet closes on restart');
ok(r0.placed.join(',') === '0,0', 'the tray is full again', r0.placed);

// ---- 11) lose sheet: no tiles left and behind on area, ended with a real Pass
await ev("window.__freebloks.setup('endgame-lose')");
await sleep(300);
const l0 = await hook();
ok(l0.left.join(',') === '0,0' && l0.over === false, 'a stalled position with no tiles left', { left: l0.left, over: l0.over });
await clickEl('pass');
await sleep(500);
const l1 = await hook();
const loseSheet = await sheet();
ok(l1.over === true, 'the game ends when nobody can place', { over: l1.over });
ok(l1.result === 'lose', 'the human loses a position it trails', l1.result);
ok(loseSheet.open === true && !/you win/i.test(loseSheet.title), 'the lose sheet opens', loseSheet.title);
const shotLose = await shot('freebloks-gate-lose');

// ---- 12) portrait touch
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev("document.getElementById('over').classList.remove('open')");
await sleep(200);
const tap = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1, radiusX: 3, radiusY: 3, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
};
await clickEl('new');
await sleep(500);
const p0 = await hook();
ok(p0.W === 14 && p0.over === false && p0.empty === 196, 'portrait board is live and empty', { W: p0.W, over: p0.over, empty: p0.empty });
const corners = await ev('({a:window.__freebloks.tilePoint(0,0),b:window.__freebloks.tilePoint(13,13)})');
ok(corners.a.x > 0 && corners.b.x < 390 && corners.a.y > 90 && corners.b.y < 760,
  'portrait: the whole board fits between the top bar and the tray', corners);
const chipPt = await ev(`(()=>{const e=document.querySelectorAll('#tray .piece')[${pick.i}];e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
await tap(chipPt);
let p1 = await hook();
if (p1.sel !== pick.i) { await tap(chipPt); p1 = await hook(); }
ok(p1.sel === pick.i, 'portrait: a real touch on the tray selects a piece', p1.sel);
const pt = await ev('window.__freebloks.tilePoint(4,4)');
ok(pt && pt.x > 0 && pt.x < 390 && pt.y > 0 && pt.y < 844, 'portrait: the start cell projects inside the viewport', pt);
await tap({ x: pt.x, y: pt.y });
const p2 = await hook();
ok(p2.inputs === 1 && p2.cells[0] === pick.s, 'portrait: a real touch places the piece', { inputs: p2.inputs, cells: p2.cells });
const shotPortrait = await shot('freebloks-gate-portrait');

// ---- 13) Classic: 20x20 with four seats, switched through the mode control
{
  const sw = await ev(`(()=>{const s=document.getElementById('mode');s.value='classic';s.dispatchEvent(new Event('change',{bubbles:true}));return {v:s.value};})()`);
  await sleep(600);
  const c0 = await hook();
  ok(sw.v === 'classic' && c0.mode === 'classic', 'the board selector switches modes', { v: sw.v, mode: c0.mode });
  ok(c0.W === 20 && c0.H === 20 && c0.players === 4, 'Classic is a 20x20 board with four seats', { W: c0.W, H: c0.H, players: c0.players });
  ok(c0.empty === 400 && c0.starts.length === 4, 'Classic starts empty with four opening markers', { empty: c0.empty, starts: c0.starts.length });
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await clickChip(pick.i);
  const c1 = await hook();
  ok(c1.sel === pick.i, 'Classic: a piece selects', c1.sel);
  await tapCell(0, 0);   // the human's Classic opening marker is a corner (pieces grow +x/+y from the anchor)
  await sleep(600);
  const c2 = await hook();
  ok(c2.placed[0] === 1 && c2.cells[0] === pick.s, 'Classic: a real click places the opening piece', { placed: c2.placed, cells: c2.cells });
  await waitFor('(()=>{const s=window.__freebloks();return s.busy===false&&s.turn===0&&(s.over||s.cells[1]>0);})()', 45000).catch(() => null);
  const c3 = await hook();
  ok(c3.cells[1] > 0 || c3.over, 'Classic: the first cpu seat answers', { cells: c3.cells, over: c3.over });
  ok(c3.turn === 0 || c3.over, 'Classic: control returns to the human', { turn: c3.turn, over: c3.over });
  const shotClassic = await shot('freebloks-gate-classic');
  globalThis.__shotClassic = shotClassic;
}

// ---- 14) console / network errors
const bad = pageCdp.events.filter((e) => {
  if (e.method === 'Runtime.exceptionThrown') return true;
  if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') return !/favicon/i.test(e.params.entry.text);
  if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) return true;
  return false;
}).map((e) => (e.method === 'Network.responseReceived'
  ? 'HTTP ' + e.params.response.status + ' ' + e.params.response.url.slice(-60)
  : (e.params.entry?.text || e.params.exceptionDetails?.exception?.description || '').slice(0, 160)));
ok(bad.length === 0, 'no console exceptions, errors or failed requests', bad.slice(0, 6));

console.log('\n' + (fails ? 'FAILED ' + fails + ' of ' + checks : 'PASS ' + checks + ' checks'));
console.log(JSON.stringify({ shots: { boot: shotBoot, placed: shotPlaced, mid: shotMid, win: shotWin, lose: shotLose, portrait: shotPortrait } }, null, 1));
proc.kill('SIGKILL');
server.close();
process.exit(fails ? 1 : 0);
