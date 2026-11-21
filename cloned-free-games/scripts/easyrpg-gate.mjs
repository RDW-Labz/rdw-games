#!/usr/bin/env node
// Interaction gate for the EasyRPG Player port (RPG Maker runtime card):
// real CDP mouse taps on the map, a chest opened by walking onto it, a fight won and
// a fight lost through the real command buttons, the shrine won with three seals,
// restart from the sheet, the R key, and a 390x844 touch pass. Every assertion reads
// the port's state hook — a canvas that merely exists is not proof.
// usage: node easyrpg-gate.mjs [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/easyrpg-player/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let fails = 0;
const ok = (cond, msg) => { if (cond) T('  ok   ' + msg); else { console.error('  FAIL ' + msg); fails++; } };

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
  return new Promise((ok2) => s.listen(0, '127.0.0.1', () => ok2(s)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok2, bad) => { ws.onopen = ok2; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok: o, bad: b } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? b(new Error(msg.error.message)) : o(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok2, bad) => {
      this.p.set(id, { ok: ok2, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 30000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/easyrpg-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
T('devtools ' + endpoint.slice(-30));
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

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5200);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(320);
};
const tapCell = async (r, c) => {
  const p = await ev(`window.__easyrpgPoint(${r},${c})`);
  if (!p || p.__err) { T('bad point ' + JSON.stringify(p)); return null; }
  await click(p);
  return p;
};
const tapBtn = async (k) => {
  const p = await ev(`window.__easyrpgButton(${JSON.stringify(k)})`);
  if (!p || p.__err || p.x == null) { T('bad button ' + k); return null; }
  await click(p);
  return p;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const hook = () => ev('window.__easyrpg()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent,text:document.getElementById('overText').textContent}))()`);

// ---- 1) boot ------------------------------------------------------------
ok((await ev('typeof window.__easyrpg')) === 'function', 'state hook is a function the catalog gate can probe');
const s0 = await hook();
ok(s0 && s0.hero.hp === 30 && s0.seals === 0 && !s0.over, 'boot: hero whole, no seals, no sheet');
ok(Array.isArray(s0.nbrs) && s0.nbrs.length > 0, 'boot: hero has an open neighbour to walk into');
const shotBoot = await shot('easyrpg-gate-boot');
T('boot ' + JSON.stringify({ hero: s0.hero, nbrs: s0.nbrs.length, shrine: s0.shrine }));

// ---- 2) a map tap walks the party --------------------------------------
const [nr, nc] = s0.nbrs[0];
await tapCell(nr, nc);
const s1 = await hook();
ok(s1.hero.r === nr && s1.hero.c === nc, `tap on ${nr},${nc} moved the hero to ${s1.hero.r},${s1.hero.c}`);
ok(s1.steps === 1 && s1.inputs === 1, `one accepted step counted (steps ${s1.steps}, inputs ${s1.inputs})`);
ok(s1.hud.hp === '30/30', 'HUD hp tracks the state');

// a wall directly beside the party must not be walked into
const nav = await ev('window.__easyrpgNav()');
const before = await hook();
const wallAdj = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  .map(([dr, dc]) => [before.hero.r + dr, before.hero.c + dc])
  .find(([r, c]) => nav.g[r] && nav.g[r][c] === 1);
if (wallAdj) {
  await tapCell(wallAdj[0], wallAdj[1]);
  const after = await hook();
  ok(after.steps === before.steps, 'a tap on the wall beside the party did not move it');
} else T('  skip  no wall beside the party');

// ---- 3) a chest pays a seal by walking onto it -------------------------
const chest = nav.chests[0];
const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  .map(([dr, dc]) => [chest.r + dr, chest.c + dc])
  .find(([r, c]) => nav.g[r] && nav.g[r][c] === 0 && !nav.npcs.some((n) => n.r === r && n.c === c));
ok(!!adj, 'the chest has a walkable neighbour');
await ev(`window.__easyrpgSetup({seed:${s0.seed}, at:[${adj[0]},${adj[1]}]})`);
await sleep(260);
await tapCell(chest.r, chest.c);
const s2 = await hook();
ok(s2.chests[0].open === true, 'walking onto the chest opened it');
ok(s2.seals === 1 && s2.hero.pots === 3, `the chest paid a seal and a potion (seals ${s2.seals}, pots ${s2.hero.pots})`);
ok(s2.hud.seals === '1/3', 'HUD seal counter tracks the state');

// ---- 4) a fight won through the real Attack button ---------------------
await ev(`window.__easyrpgSetup({seed:${s0.seed}, battle:{kind:0, hp:1}})`);
await sleep(240);
const sB0 = await hook();
ok(sB0.battle && sB0.battleOpen, 'the QA fight opened its command panel');
const winsBefore = sB0.wins;
await tapBtn('attack');
await sleep(320);
const sB1 = await hook();
ok(sB1.battle === null && !sB1.battleOpen, 'Attack on a 1-hp foe ended the fight');
ok(sB1.wins === winsBefore + 1, `the win was paid (wins ${sB1.wins})`);

// ---- 5) a fight lost: hero on 1 hp against an unavoidable hit -----------
await ev(`window.__easyrpgSetup({seed:${s0.seed}, hero:{hp:1,maxHp:30}, battle:{kind:2, hp:999, dmg:[9,9]}})`);
await sleep(240);
await tapBtn('attack');
await sleep(1000);
const sL = await hook();
const loseSheet = await sheet();
ok(sL.over === true && sL.won === false, 'the hero at 0 hp reached the lose state');
ok(loseSheet.open && /lantern/i.test(loseSheet.title), `the lose sheet opened ("${loseSheet.title}")`);
const shotLose = await shot('easyrpg-gate-lose');

// ---- 6) the shrine wins with three seals -------------------------------
const shrine = nav.shrine;
const sadj = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  .map(([dr, dc]) => [shrine.r + dr, shrine.c + dc])
  .find(([r, c]) => nav.g[r] && nav.g[r][c] === 0 && !nav.npcs.some((n) => n.r === r && n.c === c));
ok(!!sadj, 'the shrine has a walkable neighbour');
await ev(`window.__easyrpgSetup({seed:${s0.seed}, at:[${sadj[0]},${sadj[1]}], seals:2})`);
await sleep(260);
await tapCell(shrine.r, shrine.c);
const sShort = await hook();
ok(sShort.over === false, 'a two-seal party was refused at the shrine');
ok(sShort.hero.seals === 2, 'the short party still carries two seals');

await ev(`window.__easyrpgSetup({seed:${s0.seed}, at:[${sadj[0]},${sadj[1]}], seals:3})`);
await sleep(260);
await tapCell(shrine.r, shrine.c);
const sW = await hook();
const winSheet = await sheet();
ok(sW.over === true && sW.won === true, 'three seals on the shrine won the run');
ok(winSheet.open && /shrine/i.test(winSheet.title), `the win sheet opened ("${winSheet.title}")`);
const shotWin = await shot('easyrpg-gate-win');

// ---- 7) restart from the sheet, then the R key -------------------------
await tapBtn('again');
await sleep(400);
const sR0 = await hook();
T('after Play again ' + JSON.stringify({ over: sR0.over, won: sR0.won, steps: sR0.steps, seals: sR0.seals, sheet: sR0.sheetOpen, seed: sR0.seed }));
ok(sR0.over === false && sR0.steps === 0 && sR0.seals === 0 && !sR0.sheetOpen, 'Play again restarted a clean run');
ok(sR0.hero.hp === sR0.hero.maxHp, 'the restart gave a whole hero');

await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
await sleep(500);
const sR1 = await hook();
ok(sR1.steps === 0 && sR1.seed === sR0.seed, 'R restarted the same map');

// arrows walk as well as taps
const k0 = await hook();
await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 });
await sleep(400);
const k1 = await hook();
const kCell = sR1.nbrs.find(([r, c]) => r > sR1.hero.r);
if (kCell) ok(k1.steps === 1, `the down arrow walked (steps ${k1.steps})`);
else T('  skip  down arrow: no open cell below the start');

const errors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4);
ok(errors.length === 0, 'no console errors: ' + errors.join(' | '));

// ---- 8) portrait touch -------------------------------------------------
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5600);
const p0 = await hook();
const touch = async (p) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 9, radiusY: 9, force: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(380);
};
const [pr, pc] = p0.nbrs[0];
const pp = await ev(`window.__easyrpgPoint(${pr},${pc})`);
ok(pp && pp.x > 0 && pp.x < 390 && pp.y > 0 && pp.y < 844, `portrait tile point is on screen (${JSON.stringify(pp)})`);
await touch(pp);
const p1 = await hook();
ok(p1.hero.r === pr && p1.hero.c === pc, `a portrait tap walked the party to ${p1.hero.r},${p1.hero.c}`);

// the battle panel and its buttons are on the phone screen
await ev(`window.__easyrpgSetup({seed:${p0.seed}, battle:{kind:1, hp:20}})`);
await sleep(240);
const bp = await ev(`window.__easyrpgButton('attack')`);
ok(bp && bp.y > 0 && bp.y < 844 && bp.x > 0 && bp.x < 390, `portrait attack button is on screen (${JSON.stringify(bp)})`);
await touch(bp);
const p2 = await hook();
ok(p2.battle && p2.battle.hp < 20, `a portrait tap on Attack landed (foe hp ${p2.battle?.hp})`);
const shotPortrait = await shot('easyrpg-gate-portrait');

const perrors = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(-3);
ok(perrors.length === 0, 'no console errors in portrait: ' + perrors.join(' | '));

console.log(JSON.stringify({
  pass: fails === 0, fails,
  shots: { boot: shotBoot, lose: shotLose, win: shotWin, portrait: shotPortrait },
  boot: s0.hero, final: { over: sW.over, won: sW.won, steps: sW.steps },
}, null, 1));
proc.kill();
server.close();
process.exit(fails ? 1 : 0);
