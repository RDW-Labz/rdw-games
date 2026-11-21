#!/usr/bin/env node
// Interaction gate for the Life RPG port (Life RPG card, com.arcom.life_rpg).
// Real CDP mouse on the quest plates and the DOM buttons, state-hook assertions for the day's
// win, the burnout lose, the next-day path, the coffee purchase and the double-dispatch guard,
// plus a 390x844 portrait pass.
// usage: node life-rpg-gate.mjs [root-dir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/life-rpg/index.html';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/liferpg-gate-');
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

const state = () => ev('window.__life.state()');
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const tapQuest = async (i) => {
  const p = await ev(`window.__life.questPoint(${i})`);
  if (!p || p.__err) return { p, err: p && p.__err };
  await click(p);
  await sleep(320);
  return p;
};
const clickEl = async (id) => {
  const b = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};})()`);
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
ok(boot && typeof boot === 'object' && !boot.__err, 'hook is live at boot', boot);
ok(Array.isArray(boot.quests) && boot.quests.length === 6 && boot.quests.every((q) => q.text && q.text.length > 3),
  'six quest plates are filled at boot', boot.quests && boot.quests.map((q) => q.text));
ok(boot.canvas.w > 600 && boot.canvas.h > 400, 'canvas has real size', boot.canvas);
ok(boot.level === 1 && boot.goal === 60, 'a fresh save starts at level 1 with a 60 xp goal', { level: boot.level, goal: boot.goal });

// --- 2. every plate point resolves back to its own plate ---
const res = await ev(`(()=>{const out=[];for(let i=0;i<6;i++){const p=window.__life.questPoint(i);out.push({i,p,back:window.__life.pickAt(p.x,p.y),under:document.elementFromPoint(p.x,p.y)?.tagName});}return out;})()`);
ok(Array.isArray(res) && res.every((r) => r.back === r.i), 'questPoint(i) resolves back to quest i',
  Array.isArray(res) ? res.map((r) => r.i + '->' + r.back).join(' ') : res);
ok(Array.isArray(res) && res.every((r) => r.under === 'CANVAS'), 'every quest point is over the canvas, not a HUD bar',
  Array.isArray(res) ? res.map((r) => r.i + ':' + r.under).join(' ') : res);

// --- 3. the win: two real clicks on a planned day ---
const seedState = await ev('window.__life.setup(45)');
const preWin = await state();
ok(preWin.plan && preWin.plan.length === 2, 'seed 45 day 1 has a two-tap winning plan', { plan: preWin.plan, seedState });
ok(preWin.planCost <= preWin.energy, 'the plan fits the day energy', { cost: preWin.planCost, energy: preWin.energy });
await shot('life-rpg-boot');
const beforeWin = await state();
await tapQuest(preWin.plan[0]);
const midWin = await state();
ok(midWin.dayXp > beforeWin.dayXp && midWin.energy < beforeWin.energy, 'tapping a quest banked XP and spent energy',
  { dayXp: [beforeWin.dayXp, midWin.dayXp], energy: [beforeWin.energy, midWin.energy] });
ok(midWin.inputs === beforeWin.inputs + 1, 'exactly one accepted input counted', { before: beforeWin.inputs, after: midWin.inputs });
ok(midWin.quests[preWin.plan[0]].done === true, 'the tapped plate is marked done', midWin.quests[preWin.plan[0]]);
ok(midWin.over === false, 'the day is still open after the first tap', midWin.over);
await tapQuest(preWin.plan[1]);
const won = await state();
ok(won.dayXp >= won.goal, 'the day goal was cleared by real clicks', { dayXp: won.dayXp, goal: won.goal });
ok(won.over === true && /Day cleared/i.test(won.overTitle), 'the day-cleared sheet opened', { over: won.over, title: won.overTitle });
ok(won.streak === 1, 'clearing the day banked a streak', won.streak);
ok(won.xp === midWin.xp + won.quests[preWin.plan[1]].xp, 'the second quest paid its XP into the level curve', { xp: [midWin.xp, won.xp] });
const sheetText = await ev('document.getElementById("overText").textContent');
ok(/Streak/.test(sheetText), 'the sheet reads the streak back', sheetText);
await shot('life-rpg-win');

// --- 4. Next day from the sheet's own button ---
const preNext = await state();
await clickEl('overBtn');
const day2 = await state();
ok(day2.day === preNext.day + 1, 'Next day advanced the day', { was: preNext.day, now: day2.day });
ok(day2.dayXp === 0 && day2.over === false, 'the new day resets the XP clock and closes the sheet', { dayXp: day2.dayXp, over: day2.over });
ok(day2.quests.every((q) => !q.done), 'the new day deals a fresh board');
ok(day2.goal === 80, 'the goal climbs with the streak', day2.goal);
ok(day2.quests.map((q) => q.text).join() !== preNext.quests.map((q) => q.text).join(), 'the new board is not the old one');

// --- 5. the double-dispatch guard: both pointerups in ONE page tick ---
const guard = await ev(`(()=>{
  const idx = window.__life.state().quests.findIndex((q) => !q.done);
  const p = window.__life.questPoint(idx);
  const s0 = window.__life.state();
  const mk = () => new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1, pointerType: 'mouse' });
  const el = document.elementFromPoint(p.x, p.y) || document.querySelector('canvas');
  const c = document.querySelector('canvas');
  el.dispatchEvent(mk()); c.dispatchEvent(mk());
  const s1 = window.__life.state();
  return { idx, s0: { inputs: s0.inputs, dups: s0.dups }, s1: { inputs: s1.inputs, dups: s1.dups, done: s1.quests[idx].done } };
})()`);
ok(guard && guard.s1.dups === guard.s0.dups + 1, 'the doubled pointerup was swallowed as a duplicate', guard);
ok(guard && guard.s1.inputs === guard.s0.inputs + 1, 'only one of the pair was accepted', guard);

// --- 6. the lose: out of energy with the goal still open ---
const preLose = await ev('window.__life.setup(45, { energy: 1, goal: 150 })');
ok(preLose && preLose.goal === 150 && preLose.energy === 1, 'QA position loads with 1 energy against a 150 xp goal', preLose);
const cheap = await ev('window.__life.state().quests.map((q,i)=>({i,tier:q.tier,done:q.done}))');
const cheapIdx = cheap.filter((q) => q.tier === 0)[0];
ok(!!cheapIdx, 'the board carries an affordable trivial quest', cheap);
await tapQuest(cheapIdx.i);
const lost = await state();
ok(lost.energy === 0, 'the tap drained the last energy', lost.energy);
ok(lost.over === true && /Burnout/i.test(lost.overTitle), 'the burnout sheet opened', { over: lost.over, title: lost.overTitle });
ok(lost.streak === 0, 'burnout reset the streak', lost.streak);
ok(lost.level >= 1 && lost.xp > 0, 'burnout keeps the XP and the level', { level: lost.level, xp: lost.xp });
await shot('life-rpg-burnout');
await clickEl('overBack');
ok((await state()).over === false, 'Back up closes the burnout sheet');
// the board still takes clicks after the sheet (nothing is wedged)
const afterBack = await state();
const openIdx = afterBack.quests.findIndex((q) => !q.done);
if (openIdx >= 0) {
  await ev('window.__life.setup(45, { energy: 9, goal: 150 })');
  const reopened = await state();
  await tapQuest(reopened.quests.findIndex((q) => !q.done));
  ok((await state()).inputs > reopened.inputs, 'quests still take taps after a sheet');
}

// --- 7. the coffee purchase ---
await ev('window.__life.setup(45, { energy: 2, coins: 20 })');
const preCoffee = await state();
const cb = await clickEl('coffeeBtn');
ok(preCoffee.coffeeUsed === false && preCoffee.coins >= 5, 'coffee is available with coins in hand', { coins: preCoffee.coins, btn: cb });
const postCoffee = await state();
ok(postCoffee.energy === preCoffee.energy + 3, 'coffee added three energy', { was: preCoffee.energy, now: postCoffee.energy });
ok(postCoffee.coins === preCoffee.coins - 5, 'coffee cost five coins', { was: preCoffee.coins, now: postCoffee.coins });
ok(postCoffee.coffeeUsed === true, 'coffee is one per day');
await clickEl('coffeeBtn');
ok((await state()).energy === postCoffee.energy, 'a second coffee the same day does nothing');

// --- 8. the day button and the keyboard ---
const preDayBtn = await state();
await clickEl('dayBtn');
const dayBtnState = await state();
ok(dayBtnState.day === preDayBtn.day + 1 && dayBtnState.dayXp === 0, 'the New day button deals a fresh day', { was: preDayBtn.day, now: dayBtnState.day });
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(300);
ok((await state()).day === dayBtnState.day + 1, 'R also starts a new day');

// --- 9. portrait touch pass ---
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(800);
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(4500);
await ev('window.__life.setup(45)');
const pRes = await ev(`(()=>{const out=[];for(let i=0;i<6;i++){const p=window.__life.questPoint(i);out.push({i,p,back:window.__life.pickAt(p.x,p.y),under:document.elementFromPoint(p.x,p.y)?.tagName});}return out;})()`);
ok(Array.isArray(pRes) && pRes.every((r) => r.back === r.i), 'portrait: every quest point resolves back to its quest',
  Array.isArray(pRes) ? pRes.map((r) => r.i + '->' + r.back).join(' ') : pRes);
ok(Array.isArray(pRes) && pRes.every((r) => r.p.x > 4 && r.p.x < 386 && r.p.y > 60 && r.p.y < 760), 'portrait: every quest point is on screen and clear of the bars',
  Array.isArray(pRes) ? pRes.map((r) => r.p.x + ',' + r.p.y).join(' ') : pRes);
ok(Array.isArray(pRes) && pRes.every((r) => r.under === 'CANVAS'), 'portrait: no plate sits under a HUD bar',
  Array.isArray(pRes) ? pRes.map((r) => r.i + ':' + r.under).join(' ') : pRes);
const pBefore = await state();
await tapQuest(pBefore.plan ? pBefore.plan[0] : 0);
const pAfter = await state();
ok(pAfter.energy < pBefore.energy && pAfter.inputs === pBefore.inputs + 1, 'portrait: a plate tap spent energy and counted one input',
  { energy: [pBefore.energy, pAfter.energy], inputs: [pBefore.inputs, pAfter.inputs] });
await shot('life-rpg-portrait');

// --- 10. console health ---
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
