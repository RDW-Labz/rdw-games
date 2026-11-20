#!/usr/bin/env node
// Interaction gate for the NPC Forge port (RPG NPC Generator card).
// Real CDP mouse on the plates and the die, DOM buttons through real mouse events,
// state-hook assertions for re-rolls, the save path, the legendary sheet and the
// double-dispatch guard, plus a 390x844 portrait pass.
// usage: node npc-forge-gate.mjs [root-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/rpg-npc-generator/index.html';
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
const PROFILE = mkdtempSync('/tmp/npcf-gate-');
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
T('serving ' + port + ' from ' + ROOT);
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

let fails = 0;
const ok = (cond, msg, extra) => { if (!cond) { fails++; console.error('FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); } else T('ok ' + msg); };

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const state = () => ev('window.__npc.state()');
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const tapPlate = async (i) => {
  const p = await ev(`window.__npc.platePoint(${i})`);
  if (!p || p.__err) return { p, err: p.__err };
  await click(p);
  await sleep(300);
  return p;
};
const tapDie = async () => {
  const p = await ev('window.__npc.diePoint()');
  await click(p);
  await sleep(320);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await click(b);
  await sleep(320);
  return b;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  T('shot ' + out);
  return out;
};

// --- 1. boot ---
const boot = await state();
ok(boot && typeof boot === 'object', 'hook is live at boot', boot);
// normalise to a known non-legendary sheet so the run cannot flake on a 1-in-60 legendary boot roll
const base0 = await ev('window.__npc.setup(7)');
ok(base0 !== 'legendary', 'seed 7 is a normal (non-legendary) sheet', base0);
ok(boot.fields && boot.fields.length === 8 && boot.fields.every((f) => f && f.length > 1), 'eight plates are filled at boot', boot.fields);
ok(typeof boot.rarity === 'string' && boot.rarity.length > 2, 'rarity reads at boot', boot.rarity);
ok(boot.canvas.w > 600 && boot.canvas.h > 400, 'canvas has real size', boot.canvas);
// every plate point must resolve back to that plate (and be on the canvas)
const res = await ev(`(()=>{const out=[];for(let i=0;i<8;i++){const p=window.__npc.platePoint(i);out.push({i,p,back:window.__npc.pickAt(p.x,p.y)});}return out;})()`);
ok(Array.isArray(res) && res.every((r) => r.back === r.i), 'platePoint(i) resolves back to plate i', res.map((r) => r.i + '->' + r.back).join(' '));
const dieBack = await ev(`(()=>{const p=window.__npc.diePoint();return {p,back:window.__npc.pickAt(p.x,p.y)};})()`);
ok(dieBack.back === 'die', 'die point resolves to the die', dieBack);

// --- 2. one plate re-roll ---
const before = await state();
await tapPlate(3);
const afterOne = await state();
ok(afterOne.counts[3] === before.counts[3] + 1, 'tapping the Age plate counted one re-roll on that plate', { was: before.counts[3], now: afterOne.counts[3] });
ok(afterOne.inputs === before.inputs + 1, 'exactly one accepted input counted', { before: before.inputs, after: afterOne.inputs });
const untouched = before.fields.every((f, i) => i === 3 || f === afterOne.fields[i]);
ok(untouched, 'the other seven plates did not move', { before: before.fields, after: afterOne.fields });
// a re-roll can legitimately redraw the same face, so prove the plate feeds new rolls over a few taps
let ageMoved = afterOne.fields[3] !== before.fields[3];
for (let k = 0; k < 4 && !ageMoved; k++) {
  const prev = await state();
  await tapPlate(3);
  ageMoved = (await state()).fields[3] !== prev.fields[3];
}
ok(ageMoved, 'repeated Age taps feed fresh rolls into the plate');

// --- 3. double dispatch guard: two pointerups in one tick ---
const guard = await ev(`(()=>{
  const p = window.__npc.platePoint(0);
  const s0 = window.__npc.state();
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1, pointerType: 'mouse' });
  const el = document.elementFromPoint(p.x, p.y) || document.querySelector('canvas');
  const c = document.querySelector('canvas');
  el.dispatchEvent(mk()); c.dispatchEvent(mk());
  const s1 = window.__npc.state();
  return { s0: { inputs: s0.inputs, dups: s0.dups, name: s0.fields[0] }, s1: { inputs: s1.inputs, dups: s1.dups, name: s1.fields[0] } };
})()`);
ok(guard && guard.s1.dups === guard.s0.dups + 1, 'the doubled pointerup was swallowed as a duplicate', guard);
ok(guard.s1.inputs === guard.s0.inputs + 1, 'only one of the pair was accepted', guard);
await sleep(200);

// --- 4. the die rolls the whole sheet ---
const preDie = await state();
await tapDie();
await sleep(400);
const postDie = await state();
ok(postDie.rolls === preDie.rolls + 1, 'tapping the die rolled a new sheet', { before: preDie.rolls, after: postDie.rolls });
ok(postDie.fields[0] !== preDie.fields[0] || postDie.total !== preDie.total, 'the sheet actually changed under the die', { a: preDie.fields[0], b: postDie.fields[0] });
ok(postDie.inputs === preDie.inputs + 1, 'the die tap counted one input', { before: preDie.inputs, after: postDie.inputs });

// --- 5. save to the roster through the real button ---
// a legendary roll in the previous step opens the end sheet over the toolbar: close it the way a visitor would
if ((await state()).over) await clickEl('overBack');
const preSave = await state();
await clickEl('saveBtn');
const postSave = await state();
ok(postSave.roster === preSave.roster + 1, 'Save NPC added the sheet to the roster', { before: preSave.roster, after: postSave.roster });
const rosterText = await ev(`document.getElementById('roster').textContent`);
ok(/Roster/.test(rosterText), 'the roster strip updated', rosterText);
await shot('npc-forge-boot');

// --- 6. legendary sheet + its own buttons ---
const rar = await ev('window.__npc.setup(44)');
const legState = await state();
ok(rar === 'legendary', 'seed 44 loads a legendary sheet from the core test', rar);
ok(legState.over === true && /Legendary/i.test(legState.overTitle), 'the legendary end sheet opened', { over: legState.over, title: legState.overTitle });
await shot('npc-forge-legendary');
await clickEl('overBtn');
const afterAgain = await state();
ok(afterAgain.over === false, 'Roll again closed the sheet');
ok(afterAgain.seed !== legState.seed, 'Roll again dealt a fresh seed', { was: legState.seed, now: afterAgain.seed });
// the window is still clickable after the sheet closes
const preDie2 = await state();
await tapDie();
ok((await state()).rolls === preDie2.rolls + 1, 'the die still works after the sheet closed');

// --- 7. portrait touch pass ---
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(800);
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4500);
const pBoot = await state();
ok(pBoot.fields.every((f) => f.length > 1), 'portrait boot fills the sheet', pBoot.fields);
const pRes = await ev(`(()=>{const out=[];for(let i=0;i<8;i++){const p=window.__npc.platePoint(i);out.push({i,p,back:window.__npc.pickAt(p.x,p.y),under:document.elementFromPoint(p.x,p.y)?.tagName});}return out;})()`);
ok(Array.isArray(pRes) && pRes.every((r) => r.back === r.i), 'portrait: every plate point resolves back to its plate', pRes.map((r) => r.i + '->' + r.back).join(' '));
ok(pRes.every((r) => r.p.x > 4 && r.p.x < 386 && r.p.y > 4 && r.p.y < 840), 'portrait: every plate point is on screen', pRes.map((r) => r.p.x + ',' + r.p.y).join(' '));
const pBefore = await state();
await tapPlate(6);
const pAfter = await state();
ok(pAfter.counts[6] === pBefore.counts[6] + 1 && pAfter.inputs === pBefore.inputs + 1, 'portrait: a plate tap accepted the re-roll', { counts: [pBefore.counts[6], pAfter.counts[6]], inputs: [pBefore.inputs, pAfter.inputs] });
let pMoved = pAfter.fields[6] !== pBefore.fields[6];
for (let k = 0; k < 4 && !pMoved; k++) {
  const prev = await state();
  await tapPlate(6);
  pMoved = (await state()).fields[6] !== prev.fields[6];
}
ok(pMoved, 'portrait: repeated plate taps feed fresh rolls');
await shot('npc-forge-portrait');

// --- 8. console health ---
const errs = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params?.exceptionDetails?.text || 'exception');
const logs = pageCdp.events.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry);
const bad = logs.filter((l) => l.level === 'error' && !/favicon/.test(l.text || ''));
ok(errs.length === 0, 'no uncaught exceptions', errs);
ok(bad.length === 0, 'no console errors', bad.map((b) => b.text));

const final = await state();
console.log(JSON.stringify({ port, ok: fails === 0, fails, state: final, url: `http://127.0.0.1:${port}/${FILE}` }, null, 1));
server.close();
proc.kill('SIGKILL');
process.exit(fails ? 1 : 0);
