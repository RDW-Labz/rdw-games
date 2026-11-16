#!/usr/bin/env node
// Interaction gate for the Mahjong Scoring Compass port: real CDP mouse clicks on the
// four seat panels and the control buttons, dot-dot state-hook assertions, then a portrait
// touch pass. Pixel presence is not proof — every check reads window.__mj().
// usage: node mj-gate.mjs <dir-with-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/libstage-mj');
const FILE = 'games/arcade/mahjong-scoring-compass.html';
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
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    c.events = [];
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
const PROFILE = mkdtempSync('/tmp/mj-gate-');
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
await sleep(5000);

const errorsOf = (evs) => evs.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');
const errors = errorsOf(cdp.events);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(260);
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();const at=document.elementFromPoint(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2));return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),box:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],dis:e.disabled,at:at?(at.id||at.tagName):null};})()`);
  await click(b);
  return b;
};
const key = async (code, k, vk) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk });
  await sleep(220);
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const tapSeat = async (i) => { const p = await ev(`window.__mj.seatPoint(${i})`); await click(p); return p; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1) boot: a fresh hanchan, four 25000 scores, nothing selected
const s0 = await ev('window.__mj()');
const shotBoot = await shot('mj-gate-boot');
const seatPts = await ev('JSON.stringify([0,1,2,3].map(i=>window.__mj.seatPoint(i)))');
const onScreen = JSON.parse(seatPts).every((p) => p.x > 6 && p.x < 1274 && p.y > 6 && p.y < 794);

// ---- 2) the live page computes the standard riichi table
const tbl = await ev('JSON.stringify([window.__mj.points(3,30,false,false).total, window.__mj.points(4,30,false,true).total, window.__mj.points(2,30,true,false).total, window.__mj.points(13,40,true,true).each[0]])');

// ---- 3) real clicks: tap the dealer's panel, then the seat that deals in
const p0 = await tapSeat(0);
const sWin = await ev('window.__mj()');
const p1 = await tapSeat(1);
const sDisc = await ev('window.__mj()');
const shotSel = await shot('mj-gate-selected');

// ---- 4) han stepper buttons change the pending value (3/30 dealer ron 5800 -> 4/30 11600)
await clickEl('hanUp');
const sHan4 = await ev('window.__mj()');
await clickEl('hanDn');
const sHan3 = await ev('window.__mj()');
// ---- 4b) keyboard stepper and mode toggle
await key('ArrowRight', 'ArrowRight', 39);
const sFu40 = await ev('window.__mj()');
await key('ArrowLeft', 'ArrowLeft', 37);
const sFu30 = await ev('window.__mj()');

// ---- 5) Record banks the hand: dealer ron 3 han 30 fu = 5800, dealer repeats with honba 1
await clickEl('rec');
const sRec = await ev('window.__mj()');
const shotRec = await shot('mj-gate-recorded');
const chips = await ev('document.querySelectorAll("#strip .chip").length');

// ---- 6) Undo puts the whole hand back
await clickEl('undo');
const sUndo = await ev('window.__mj()');

// ---- 7) riichi: select a seat, bank 1000 as a stick, then let the dealer win the pot
// (undo restored the previous selection, so only tap if seat 0 is not already named)
const sPre = await ev('window.__mj()');
if (sPre.winner !== 0) await tapSeat(0);
const riichiBox = await clickEl('riichi');
const sRiichi = await ev('window.__mj()');
await clickEl('mode');                        // ron -> tsumo
await tapSeat(0);                             // dealer wins by tsumo
const sTsumoPend = await ev('window.__mj()');
await clickEl('rec');
const sTsumo = await ev('window.__mj()');

// ---- 8) QA hook drives the last hand of the hanchan to the end sheet
await ev('window.__mj.setup({round:7, dealer:3, tsumo:false, han:2, fu:30, scores:[30000,25000,25000,20000]})');
await tapSeat(2);
await tapSeat(0);
await clickEl('rec');
const sFinal = await ev('window.__mj()');
const standRows = await ev('document.querySelectorAll("#stand .l").length');
const standFirst = await ev('(()=>{const e=document.querySelector("#stand .l.first");return e?e.textContent:null;})()');
const shotFinal = await shot('mj-gate-final');

// ---- 9) Play again clears the table
await clickEl('overBtn');
const sAgain = await ev('window.__mj()');

// ---- 10) New clears the table once a hand has been banked (sheet closed)
await tapSeat(0);
await tapSeat(1);
await clickEl('rec');
const sBeforeNew = await ev('window.__mj()');
const newBox = await clickEl('new');
const sNew = await ev('window.__mj()');

// ---- 11) a yakuman ron busts a short stack and raises the end sheet
await ev('window.__mj.setup({scores:[25000,25000,700,72000], han:13, fu:40, tsumo:false})');
await tapSeat(0);
await tapSeat(2);
await clickEl('rec');
const sBust = await ev('window.__mj()');
const bustTitle = await ev('document.getElementById("overTitle").textContent');
const shotBust = await shot('mj-gate-bust');
// the sheet covers the bottom bar, so "Play again" is the exit path from a finished game
const againBox = await clickEl('overBtn');
const sBustAgain = await ev('window.__mj()');

// ---- 12) portrait phone: finger taps on a seat panel still register
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);
const tapPts = JSON.parse(await ev('JSON.stringify([0,1,2,3].map(i=>window.__mj.seatPoint(i)))'));
const tapAllIn = tapPts.every((p) => p.x > 2 && p.x < 388 && p.y > 2 && p.y < 842);
const tap = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(420);
};
await tap(tapPts[1]);
const sTouchWin = await ev('window.__mj()');
await tap(tapPts[3]);
const sTouchDisc = await ev('window.__mj()');
const recBox = await ev(`(()=>{const e=document.getElementById('rec');const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`);
const recPt = { x: recBox.x + recBox.w / 2, y: recBox.y + recBox.h / 2 };
await tap(recPt);
const sTouchRec = await ev('window.__mj()');
const shotTouch = await shot('mj-gate-touch');
const errors2 = errorsOf(cdp.events);

const checks = {
  boot: s0 && eq(s0.scores, [25000, 25000, 25000, 25000]) && s0.label === 'E1' && s0.over === false && s0.winner === -1,
  onScreen,
  table: eq(JSON.parse(tbl), [3900, 11600, 2000, 16000]),
  seatTap: sWin.winner === 0 && sDisc.discarder === 1 && sDisc.pending.total === 5800,
  hanStep: sHan4.han === 4 && sHan4.pending.total === 11600 && sHan3.han === 3 && sHan3.pending.total === 5800,
  keyStep: sFu40.fu === 40 && sFu30.fu === 30,
  recorded: eq(sRec.scores, [30800, 19200, 25000, 25000]) && sRec.honba === 1 && sRec.label === 'E1' && sRec.dealer === 0 && sRec.hands === 1 && chips === 1,
  undone: eq(sUndo.scores, [25000, 25000, 25000, 25000]) && sUndo.hands === 0 && sUndo.honba === 0,
  riichi: sRiichi.sticks === 1 && sRiichi.scores[0] === 24000 && sRiichi.winner === -1,
  tsumoPending: sTsumoPend.tsumo === true && sTsumoPend.winner === 0 && sTsumoPend.pending.total === 6000,
  tsumoBanked: eq(sTsumo.scores, [31000, 23000, 23000, 23000]) && sTsumo.sticks === 0 && sTsumo.honba === 1,
  finalHand: sFinal.over === true && sFinal.reason === 'final' && sFinal.overOpen === true && standRows === 4 && /You/.test(standFirst || ''),
  again: sAgain.over === false && eq(sAgain.scores, [25000, 25000, 25000, 25000]) && sAgain.label === 'E1',
  bust: sBust.over === true && sBust.reason === 'bust' && sBust.scores[2] < 0 && /Busted/.test(bustTitle || ''),
  newGame: sBeforeNew.hands === 1 && sNew.over === false && sNew.hands === 0 && eq(sNew.scores, [25000, 25000, 25000, 25000]),
  bustAgain: sBustAgain.over === false && sBustAgain.hands === 0 && eq(sBustAgain.scores, [25000, 25000, 25000, 25000]),
  touchSeats: sTouchWin.winner === 1 && sTouchDisc.discarder === 3,
  touchRec: sTouchRec.hands === 1 && sTouchRec.scores[1] > 25000 && sTouchRec.scores[3] < 25000,
  touchLayout: tapAllIn && recBox.x >= 0 && recBox.x + recBox.w <= 390 && recBox.y + recBox.h <= 844,
  noErrors: !errors && !errors2,
};

console.log(JSON.stringify({
  checks, errors, errors2,
  s0: { scores: s0.scores, label: s0.label }, tbl: JSON.parse(tbl),
  sWin: { winner: sWin.winner }, sDisc: { discarder: sDisc.discarder, pending: sDisc.pending.total },
  sRec: { scores: sRec.scores, honba: sRec.honba, hands: sRec.hands, log: sRec.log },
  sRiichi: { sticks: sRiichi.sticks, scores: sRiichi.scores }, sTsumo: { scores: sTsumo.scores, honba: sTsumo.honba },
  sFinal: { over: sFinal.over, reason: sFinal.reason, order: sFinal.order, overOpen: sFinal.overOpen }, standFirst,
  sBust: { over: sBust.over, reason: sBust.reason, scores: sBust.scores }, bustTitle,
  sTouch: { win: sTouchWin.winner, disc: sTouchDisc.discarder, rec: sTouchRec.scores },
  seatPts: JSON.parse(seatPts), tapPts, riichiBox, newBox,
  shots: [shotBoot, shotSel, shotRec, shotFinal, shotBust, shotTouch],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'GATE PASS' : 'GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
