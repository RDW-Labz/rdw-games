#!/usr/bin/env node
// Interaction gate for the DevilutionX port. Real CDP mouse clicks + a portrait touch pass against
// the shipped bytes served straight out of the site repo, asserting state through
// window.__devilutionx:
//   boot, picker round-trip on every cell, HUD-band framing, a real walk (both on the live clock
//   and through pump), a wall bump that costs nothing, a kill that pays xp and drops gold, a
//   monster that closes on an idle hero, the Drink button, the same-point double-tap guard, a real
//   descent, the Butcher win sheet, the death sheet, Play again, a 390x844 touch pass, and the
//   tile-art screenshot. Takes the art shot into .queue/lib-art/.
// usage: node devilutionx-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/devilutionx/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const ART = '/home/cluer/cloned-free-games/.queue/lib-art';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

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
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok2, bad) => {
      this.p.set(id, { ok: ok2, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 240000);
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
const PROFILE = mkdtempSync('/tmp/devilutionx-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-400))), 90000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok2(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-400))));
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

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
// poll for the boot hook: under memory pressure chromium can take a minute to start running JS
let booted = false;
for (let i = 0; i < 90; i++) {
  await sleep(500);
  const h = await ev('typeof window.__devilutionx');
  if (h === 'function') { booted = true; break; }
}
T('boot after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
if (!booted) {
  const keys = await ev('Object.keys(window).filter((k) => k.startsWith("__"))');
  const logs = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').slice(0, 3).map((e) => e.params.exceptionDetails?.exception?.description);
  T('no hook; __ keys ' + JSON.stringify(keys) + ' exceptions ' + JSON.stringify(logs));
  ok(false, 'window.__devilutionx boots as a callable hook');
  proc.kill('SIGKILL'); server.close();
  process.exit(1);
}

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const touch = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await sleep(70);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const state = () => ev('window.__devilutionx()');
const pump = (sec) => ev(`window.__x.pump(${sec})`);
const sheet = () => ev(`window.__x.sheet()`);
const cellPt = (r, c) => ev(`window.__x.cellPoint(${r},${c})`);
const clickCell = async (r, c, wait = 300) => {
  const p = await cellPt(r, c);
  if (!p || p.__err) return { err: (p && p.__err) || 'no point', r, c };
  await click(p); await sleep(wait); return p;
};
const clickEl = async (id, wait = 400) => {
  const box = await ev(`(()=>{const e=document.getElementById('${id}');const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height};})()`);
  if (!box || box.__err || !box.w) return { err: 'no box', box };
  await click({ x: box.x, y: box.y }); await sleep(wait);
  return box;
};
const shot = async (name, dir = OUT) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, Buffer.from(r.data, 'base64'));
  T('shot ' + path);
  return path;
};

// ---------- 1. boot ----------
let st = await state();
T('boot state ' + JSON.stringify(st));
ok(st && !st.__err, 'boot state reads', st);
ok(st.depth === 1 && st.depths === 5, 'boots on depth 1 of 5', st);
ok(st.hp === 40 && st.maxhp === 40 && !st.over, 'fresh run: full health, not over', st);
ok(st.monsters > 0, 'depth 1 stocks monsters', { monsters: st.monsters });
ok(!!st.down, 'depth 1 has stairs down', st.down);
const nearBoot = st.monstersAll.filter((m) => Math.max(Math.abs(m.r - st.r), Math.abs(m.c - st.c)) <= 4).length;
ok(nearBoot === 0, 'no monster within 4 tiles at the spawn (deterministic first move)', st.monstersAll);
const drew = await ev(`(()=>{const c=document.querySelector('body > canvas');return c?{w:c.width,h:c.height}:null})()`);
ok(drew && drew.w > 300, 'the renderer canvas is sized', drew);
await shot('devilutionx-boot.png');

// ---------- 2. picker round-trip on every cell ----------
const rt = await ev(`(()=>{const w=window.__x,bad=[];for(let r=0;r<17;r++)for(let c=0;c<23;c++){const p=w.cellPoint(r,c);if(!p){bad.push([r,c,'nopoint']);continue;}const back=w.cellAt(p.x,p.y);if(!back||back[0]!==r||back[1]!==c)bad.push([r,c,back]);}return {bad,total:391};})()`);
ok(rt && rt.bad && rt.bad.length === 0, 'cellPoint -> cellAt round-trips on all 391 cells', rt && rt.bad);

// ---------- 3. HUD-band framing ----------
const band = await ev(`(()=>{const w=window.__x,b=w.bands(),bad=[];for(let r=0;r<17;r++)for(let c=0;c<23;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,aspect:w.camera().aspect,dist:w.camera().dist};})()`);
ok(band && band.bad && band.bad.length === 0, 'every cell projects inside the HUD band (not under the bars)', band && band.bad);
ok(band && band.aspect > 1, 'camera framed for the landscape viewport', band && band.aspect);

// ---------- 4. a real walk, on the live clock and through pump ----------
const plan = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);const s=w();
  for(const o of cells){ if(o.monster) continue;
    for(const d of [[-1,0],[1,0],[0,-1],[0,1]]) for(const k of [2,3]){ const t=at(o.r+d[0]*k,o.c+d[1]*k); if(t&&!t.monster) return {from:{r:o.r,c:o.c},to:{r:t.r,c:t.c}}; }
  } return null;})()`);
ok(!!plan, 'found a clean 2-3 tile walk to test on', plan);
if (plan) {
  await ev(`window.__x.setup({r:${plan.from.r},c:${plan.from.c},clearMonsters:true,clearItems:true})`);
  await sleep(200);
  const pre = await state();
  await clickCell(plan.to.r, plan.to.c, 80);
  const queued = await state();
  ok(queued.goal && queued.goal[0] === plan.to.r && queued.goal[1] === plan.to.c, 'a real click sets the walk goal', { goal: queued.goal, inputs: queued.inputs });
  // the live frame loop (and its wall-clock backstop) must move the hero without any pump
  await sleep(1200);
  const walked = await state();
  T('live walk ' + JSON.stringify({ from: [pre.r, pre.c], to: [walked.r, walked.c], steps: walked.steps, time: walked.time }));
  ok(walked.steps > 0 && (walked.r !== pre.r || walked.c !== pre.c), 'the live clock walks the hero with no pump', { before: [pre.r, pre.c], after: [walked.r, walked.c], steps: walked.steps });
  const arrived = await pump(3);
  ok(arrived.r === plan.to.r && arrived.c === plan.to.c, 'the hero arrives on the tapped tile', { after: [arrived.r, arrived.c], want: plan.to });
}

// ---------- 5. a wall bump costs nothing ----------
const wall = await ev(`(()=>{const w=window.__x,s=w();for(let r=0;r<17;r++)for(let c=0;c<23;c++){if(w.floorAt(r,c)===2)return {r,c};}return null;})()`);
ok(!!wall, 'found rock to bump into', wall);
if (wall) {
  await ev(`window.__x.setup({r:0,c:0,clearMonsters:true,clearItems:true})`);
  // stand on a floor cell that exists, then tap a wall
  const stand = await ev(`(()=>{const w=window.__x,[f]=w.walkable();return {r:f.r,c:f.c};})()`);
  await ev(`window.__x.setup({r:${stand.r},c:${stand.c},clearMonsters:true,clearItems:true})`);
  await sleep(150);
  const preBump = await state();
  await clickCell(wall.r, wall.c, 400);
  const postBump = await pump(1);
  ok(postBump.r === preBump.r && postBump.c === preBump.c, 'a wall tap does not move the hero', { before: [preBump.r, preBump.c], after: [postBump.r, postBump.c] });
  ok(postBump.steps === preBump.steps, 'a wall tap costs no step', { before: preBump.steps, after: postBump.steps });
}

// ---------- 6. a kill pays xp and drops loot ----------
const spot = await ev(`(()=>{const w=window.__x,s=w();for(const d of [[-1,0],[1,0],[0,-1],[0,1]]){const r=s.r+d[0],c=s.c+d[1];const f=w.floorAt(r,c);if(f===1||f===3)return {r,c};}return null;})()`);
ok(!!spot, 'found a cell beside the hero for the fight', spot);
if (spot) {
  await ev(`window.__x.setup({atk:9, hp:40, maxhp:40, clearMonsters:true, clearItems:true, monsters:[{kind:'fallen', r:${spot.r}, c:${spot.c}, hp:3}]})`);
  await sleep(200);
  const preFight = await state();
  ok(preFight.monsters === 1 && preFight.kills === 0, 'the QA fight is set up with one fallen one', preFight.monstersAll);
  await clickCell(spot.r, spot.c, 200);
  const postFight = await pump(1.5);
  T('fight ' + JSON.stringify({ pre: preFight.monstersAll, post: postFight.monstersAll, kills: postFight.kills, xp: postFight.xp, items: postFight.items }));
  ok(postFight.monsters === 0 && postFight.kills === 1, 'a real click on the monster kills it', { left: postFight.monsters, kills: postFight.kills });
  ok(postFight.xp > 0, 'the kill pays xp', { xp: postFight.xp });
  ok(postFight.items >= 1, 'the kill drops loot where it fell', { items: postFight.items });
  ok(postFight.r === preFight.r && postFight.c === preFight.c, 'the hero does not walk onto the corpse tile', { after: [postFight.r, postFight.c] });
}

// ---------- 7. an idle hero is closed on and struck ----------
const idleSpot = await ev(`(()=>{const w=window.__x,s=w();for(const d of [[-1,0],[1,0],[0,-1],[0,1]]){const r=s.r+d[0]*3,c=s.c+d[1]*3;const f=w.floorAt(r,c);if(f===1||f===3)return {r,c};}return null;})()`);
ok(!!idleSpot, 'found a cell three tiles off for the chaser', idleSpot);
if (idleSpot) {
  await ev(`window.__x.setup({hp:40, maxhp:40, clearMonsters:true, clearItems:true, monsters:[{kind:'skeleton', r:${idleSpot.r}, c:${idleSpot.c}}]})`);
  await sleep(150);
  const preIdle = await state();
  const afterIdle = await pump(4);
  T('idle ' + JSON.stringify({ hpBefore: preIdle.hp, after: afterIdle.hp, hits: afterIdle.hitsTaken }));
  ok(afterIdle.hitsTaken > 0 && afterIdle.hp < preIdle.hp, 'a monster that sees an idle hero closes and strikes', { hpBefore: preIdle.hp, hp: afterIdle.hp, hits: afterIdle.hitsTaken });
}

// ---------- 8. the Drink button, a real DOM click ----------
await ev(`window.__x.setup({hp:10, maxhp:40, potions:2, clearMonsters:true, clearItems:true})`);
await sleep(200);
const preDrink = await state();
const dbox = await clickEl('drink', 300);
const postDrink = await state();
T('drink ' + JSON.stringify({ box: dbox, before: preDrink.hp, after: postDrink.hp, potions: postDrink.potions }));
ok(postDrink.hp === Math.min(40, preDrink.hp + 14), 'a real click on Drink heals 14 hp', { before: preDrink.hp, after: postDrink.hp });
ok(postDrink.potions === preDrink.potions - 1, 'the potion is spent once — the click does not double-fire', { before: preDrink.potions, after: postDrink.potions });

// ---------- 9. same-point double-tap guard ----------
const dbl = await ev(`(()=>{const w=window.__x;const s=w();const cells=w.walkable();const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);
  let tgt=null; for(const d of [[-1,0],[1,0],[0,-1],[0,1]]){const t=at(s.r+d[0],s.c+d[1]); if(t&&!t.monster){tgt=[t.r,t.c];break;}}
  if(!tgt) return {skip:true};
  const pt=w.cellPoint(tgt[0],tgt[1]);const cv=document.querySelector('body > canvas');
  const before=w();const mk=()=>new PointerEvent('pointerup',{clientX:pt.x,clientY:pt.y,bubbles:true,pointerId:7,pointerType:'touch',isPrimary:true});
  cv.dispatchEvent(mk());cv.dispatchEvent(mk());
  return {tgt,before:[before.r,before.c],inputsBefore:before.inputs,after:[w().r,w().c],dups:w().dups,inputs:w().inputs};})()`);
ok(dbl && !dbl.skip && dbl.inputs === dbl.inputsBefore + 1, 'two pointerups in one tick count as one tap', dbl && { inputsBefore: dbl.inputsBefore, inputs: dbl.inputs });
ok(dbl && dbl.dups >= 1, 'the duplicate tap is counted and dropped', dbl && { dups: dbl.dups, inputs: dbl.inputs });
if (dbl && !dbl.skip) {
  // the single accepted tap must still walk exactly one tile
  const post = await pump(1);
  ok(post.r === dbl.tgt[0] && post.c === dbl.tgt[1], 'the one accepted tap walks the hero one tile', { after: [post.r, post.c], want: dbl.tgt });
}

// ---------- 10. a real descent ----------
await ev(`window.__x.setup({depth:1, clearMonsters:true, clearItems:true})`);
await sleep(200);
const ns = await ev(`window.__x.nearStairs()`);
ok(!!ns, 'found a floor cell beside the stairs', ns);
if (ns) {
  await ev(`window.__x.setup({r:${ns.r},c:${ns.c},clearMonsters:true,clearItems:true})`);
  await sleep(200);
  const preDown = await state();
  await clickCell(ns.down.r, ns.down.c, 200);
  const postDown = await pump(2);
  T('descend ' + JSON.stringify({ before: { depth: preDown.depth }, after: { depth: postDown.depth, monsters: postDown.monsters } }));
  ok(postDown.depth === preDown.depth + 1, 'tapping the stairs descends a depth', { before: preDown.depth, after: postDown.depth });
  ok(postDown.monsters > 0, 'the new depth stocks its own monsters', { monsters: postDown.monsters });
  ok(postDown.hp === preDown.hp, 'descending does not cost health', { before: preDown.hp, after: postDown.hp });
  await shot('devilutionx-depth2.png');
}

// ---------- 11. the Butcher win sheet ----------
await ev(`window.__x.setup({newGame:true, seed:20261125, depth:5, clearMonsters:true, clearItems:true})`);
await sleep(200);
const wspot = await ev(`(()=>{const w=window.__x,s=w();for(const d of [[-1,0],[1,0],[0,-1],[0,1]]){const r=s.r+d[0],c=s.c+d[1];const f=w.floorAt(r,c);if(f===1||f===3)return {r,c};}return null;})()`);
ok(!!wspot, 'found a cell beside the hero for the Butcher', wspot);
if (wspot) {
  await ev(`window.__x.setup({atk:9, hp:40, maxhp:40, clearMonsters:true, clearItems:true, monsters:[{kind:'butcher', r:${wspot.r}, c:${wspot.c}, hp:5}]})`);
  await sleep(200);
  const preWin = await state();
  ok(preWin.depth === 5 && preWin.bossAlive === true, 'the last depth holds a Butcher', { depth: preWin.depth, bossAlive: preWin.bossAlive });
  await clickCell(wspot.r, wspot.c, 200);
  const win = await pump(2);
  const winSheet = await sheet();
  T('win ' + JSON.stringify({ over: win.over, won: win.won, result: win.result, sheet: winSheet }));
  ok(win.over === true && win.won === true && win.result === 'win', 'killing the Butcher wins the run', { over: win.over, won: win.won, result: win.result });
  ok(winSheet.open === true && /Butcher falls/.test(winSheet.title), 'the win sheet names the Butcher', winSheet);
  await shot('devilutionx-win.png');

  // a tap on a finished run is ignored
  const s0 = await state();
  const deadTapPt = await cellPt(s0.r, s0.c);
  await click(deadTapPt); await sleep(250);
  const s1 = await state();
  ok(s1.steps === s0.steps && s1.inputs === s0.inputs, 'taps after the win change nothing', { before: s0.inputs, after: s1.inputs });
}

// ---------- 12. the death sheet ----------
await ev(`window.__x.setup({newGame:true, seed:20261125, depth:1, clearMonsters:true, clearItems:true})`);
await sleep(200);
const dspot = await ev(`(()=>{const w=window.__x,s=w();let best=null,bd=1e9;
  for(let r=0;r<17;r++)for(let c=0;c<23;c++){const f=w.floorAt(r,c);if(f!==1&&f!==3)continue;
    const d=Math.max(Math.abs(r-s.r),Math.abs(c-s.c));if(d<4)continue;
    if(d<bd&&w.reach(s.r,s.c,r,c)===1){bd=d;best={r,c};} }
  return best;})()`);
ok(!!dspot, 'found a cell at least four tiles off for the overlord', dspot);
if (dspot) {
  await ev(`window.__x.setup({hp:3, maxhp:40, atk:1, clearMonsters:true, clearItems:true, monsters:[{kind:'overlord', r:${dspot.r}, c:${dspot.c}}]})`);
  await sleep(200);
  const preDie = await state();
  ok(preDie.hp === 3 && preDie.monsters === 1, 'the QA death is set up: 3 hp beside an overlord', { hp: preDie.hp, monsters: preDie.monsters });
  await clickCell(dspot.r, dspot.c, 200);
  const dead = await pump(2.5);
  const deadSheet = await sheet();
  T('death ' + JSON.stringify({ hp: dead.hp, result: dead.result, sheet: deadSheet }));
  ok(dead.hp === 0 && dead.over === true && dead.result === 'dead', 'an overlord swings the run dead', { hp: dead.hp, result: dead.result });
  ok(deadSheet.open === true && /You die on depth/.test(deadSheet.title), 'the death sheet says where it happened', deadSheet);
  await shot('devilutionx-death.png');
}

// ---------- 13. Play again ----------
await clickEl('overBtn', 700);
const fresh = await state();
ok(fresh.over === false && fresh.depth === 1 && fresh.hp === 40, 'Play again starts a clean depth-1 run', { depth: fresh.depth, hp: fresh.hp, over: fresh.over });
ok((await sheet()).open === false, 'Play again closes the sheet');

// ---------- 14. tile art, then the portrait touch pass ----------
await ev(`window.__x.setup({newGame:true, seed:778899, depth:2})`);
await sleep(500);
await shot('devilutionx.png', ART);

// prime the emulated viewport with one neutral press (headless can swallow the first event)
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1000);
await click({ x: 195, y: 60 });
await sleep(300);
const pBand = await ev(`(()=>{const w=window.__x,b=w.bands(),bad=[];for(let r=0;r<17;r++)for(let c=0;c<23;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,aspect:w.camera().aspect};})()`);
ok(pBand && pBand.bad && pBand.bad.length === 0, 'the whole grid refits inside the band in portrait', pBand && pBand.bad);
ok(pBand && pBand.aspect < 1, 'camera reframed for the portrait viewport', pBand && pBand.aspect);
const pPlan = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);const s=w();
  for(const d of [[-1,0],[1,0],[0,-1],[0,1]]){const t=at(s.r+d[0],s.c+d[1]); if(t&&!t.monster) return {to:{r:t.r,c:t.c},from:{r:s.r,c:s.c}};}
  return null;})()`);
ok(!!pPlan, 'found a touch target in portrait', pPlan);
if (pPlan) {
  await ev(`window.__x.setup({r:${pPlan.from.r},c:${pPlan.from.c},clearMonsters:true,clearItems:true})`);
  await sleep(200);
  const preTouch = await state();
  const tp = await cellPt(pPlan.to.r, pPlan.to.c);
  await touch(tp); await sleep(300);
  let touched = await pump(1.2);
  if (!(touched.r === pPlan.to.r && touched.c === pPlan.to.c)) {
    // headless can swallow the first emulated touch: a finger repeats
    await touch(tp); await sleep(300);
    touched = await pump(1.2);
  }
  ok(touched.r === pPlan.to.r && touched.c === pPlan.to.c, 'a real touch moves the hero in portrait', { after: [touched.r, touched.c], want: pPlan.to, pre: [preTouch.r, preTouch.c] });
  ok(touched.steps > preTouch.steps, 'the touch pass walks the hero', { before: preTouch.steps, after: touched.steps });
}
await shot('devilutionx-portrait.png');

// ---------- console hygiene ----------
const exceptions = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const consoleErrors = pageCdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
ok(exceptions.length === 0, 'no uncaught exceptions during the whole gate', exceptions.slice(0, 2).map((e) => e.params.exceptionDetails?.exception?.description));
ok(consoleErrors.length === 0, 'no console errors during the whole gate', consoleErrors.slice(0, 2).map((e) => e.params.args?.map((a) => a.value).join(' ')));

proc.kill('SIGKILL');
server.close();
if (fails.length) { console.error('\nFAILED ' + fails.length + '\n' + fails.join('\n')); process.exit(1); }
console.log('\nOK — DevilutionX boots, picks, walks on the live clock, fights, drinks, descends, wins on the Butcher, dies honestly and refits in portrait, all from real clicks');
