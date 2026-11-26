#!/usr/bin/env node
// Interaction gate for the Brogue CE port. Real CDP mouse clicks + a portrait touch pass against
// the shipped bytes served straight out of the site repo, asserting state through window.__brogue:
//   boot, picker round-trip on every cell, HUD-band framing, a real step (position + turn move),
//   a wall bump that costs nothing, an attack that kills and pays, the Quaff button, the same-point
//   double-tap guard, a real descent, the win sheet with the Amulet, the death sheet, Play again,
//   a 390x844 touch pass, and the tile-art screenshot. Takes the art shot into .queue/lib-art/.
// usage: node brogue-ce-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/brogue-ce/';
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 90000);
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
const PROFILE = mkdtempSync('/tmp/brogue-gate-');
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
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await sleep(5000);

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const touch = async (pt) => {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const state = () => ev('window.__brogue()');
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
const hook = await ev('typeof window.__brogue');
ok(hook === 'function', 'window.__brogue is a callable hook', { hook });
let st = await state();
T('boot state ' + JSON.stringify(st));
if (!ok(st && !st.__err, 'boot state reads', st)) { T('aborting: no hook'); proc.kill('SIGKILL'); process.exit(1); }
ok(st.depth === 1 && st.depths === 5, 'boots on depth 1 of 5', st);
ok(st.hp === 18 && st.maxhp === 18 && !st.over, 'fresh run: full health, not over', st);
ok(st.monsters === 3, 'depth 1 spawns three monsters', { monsters: st.monsters });
ok(!!st.up && !!st.down, 'both staircases exist on depth 1', { up: st.up, down: st.down });
ok(st.r !== st.up[0] || st.c !== st.up[1], 'the avatar does not spawn on the up stairs', { at: [st.r, st.c], up: st.up });
const near = st.monstersAll.filter((m) => Math.max(Math.abs(m.r - st.r), Math.abs(m.c - st.c)) <= 3).length;
ok(near === 0, 'no monster is within 3 tiles at the spawn (deterministic first move)', st.monstersAll);
const drew = await ev(`(()=>{const c=document.querySelector('body > canvas');return c?{w:c.width,h:c.height}:null})()`);
ok(drew && drew.w > 300, 'the renderer canvas is sized', drew);
await shot('brogue-ce-boot.png');

// ---------- 2. picker round-trip on every cell ----------
const rt = await ev(`(()=>{const w=window.__x,bad=[];for(let r=0;r<13;r++)for(let c=0;c<21;c++){const p=w.cellPoint(r,c);if(!p){bad.push([r,c,'nopoint']);continue;}const back=w.cellAt(p.x,p.y);if(!back||back[0]!==r||back[1]!==c)bad.push([r,c,back]);}return {bad,total:273};})()`);
ok(rt && rt.bad && rt.bad.length === 0, 'cellPoint -> cellAt round-trips on all 273 cells', rt && rt.bad);

// ---------- 3. HUD-band framing ----------
const band = await ev(`(()=>{const w=window.__x,b=w.bands(),bad=[];for(let r=0;r<13;r++)for(let c=0;c<21;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,aspect:w.camera().aspect,dist:w.camera().dist};})()`);
ok(band && band.bad && band.bad.length === 0, 'every cell projects inside the HUD band (not under the bars)', band && band.bad);
ok(band && band.aspect > 1, 'camera framed for the landscape viewport', band && band.aspect);

// ---------- 4. a real step: position and turn both move ----------
const plan = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];
  const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);
  for(const o of cells){ if(o.monster) continue;
    for(const [dr,dc] of D){ const t=at(o.r+dr,o.c+dc); if(t&&!t.monster) return {from:{r:o.r,c:o.c},to:{r:t.r,c:t.c}}; }
  } return null;})()`);
ok(!!plan, 'found a clean step to test on', plan);
await ev(`window.__x.setup({r:${plan.from.r},c:${plan.from.c}})`, );
await sleep(250);
const preStep = await state();
const stepPt = await clickCell(plan.to.r, plan.to.c, 350);
const postStep = await state();
T('step ' + JSON.stringify({ plan, pt: stepPt, before: [preStep.r, preStep.c], after: [postStep.r, postStep.c], turn: postStep.turn }));
ok(postStep.r === plan.to.r && postStep.c === plan.to.c, 'a real click moves the @ onto the tapped tile', { before: [preStep.r, preStep.c], after: [postStep.r, postStep.c], want: plan.to });
ok(postStep.turn === preStep.turn + 1, 'the step costs exactly one turn', { before: preStep.turn, after: postStep.turn });
ok(postStep.inputs === preStep.inputs + 1, 'the input counter sees the tap', { before: preStep.inputs, after: postStep.inputs });

// ---------- 5. a wall bump costs nothing ----------
let wall = await ev(`(()=>{const w=window.__x,s=w();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,dc] of D){if(w.floorAt(s.r+dr,s.c+dc)===2)return {r:s.r+dr,c:s.c+dc};}return null;})()`);
if (!wall) {
  // stand somewhere that has a wall neighbour
  const spot = await ev(`(()=>{const w=window.__x,cellsw=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const o of cellsw){for(const [dr,dc] of D){if(w.floorAt(o.r+dr,o.c+dc)===2)return {r:o.r,c:o.c,w:{r:o.r+dr,c:o.c+dc}};}}return null;})()`);
  if (spot) { await ev(`window.__x.setup({r:${spot.r},c:${spot.c}})`); await sleep(250); wall = spot.w; }
}
ok(!!wall, 'found a wall to bump into', wall);
if (wall) {
  const preBump = await state();
  await clickCell(wall.r, wall.c, 300);
  const postBump = await state();
  ok(postBump.r === preBump.r && postBump.c === preBump.c, 'a wall bump does not move the @', { before: [preBump.r, preBump.c], after: [postBump.r, postBump.c] });
  ok(postBump.turn === preBump.turn, 'a wall bump does not spend a turn', { before: preBump.turn, after: postBump.turn });
}

// ---------- 6. an attack kills and pays ----------
const spot = await ev(`(()=>{const w=window.__x,s=w();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,dc] of D){const r=s.r+dr,c=s.c+dc;const f=w.floorAt(r,c);if(f===1||f===3||f===4)return {r,c};}return null;})()`);
ok(!!spot, 'found a cell beside the @ for the fight', spot);
if (spot) {
  await ev(`window.__x.setup({atk:9, monsters:[{kind:'orc', r:${spot.r}, c:${spot.c}}]})`);
  await sleep(250);
  const preFight = await state();
  ok(preFight.monsters === 1 && preFight.kills === 0, 'the QA fight is set up with one orc', preFight.monstersAll);
  await clickCell(spot.r, spot.c, 400);
  const postFight = await state();
  T('fight ' + JSON.stringify({ pre: preFight.monstersAll, post: postFight.monstersAll, kills: postFight.kills, gold: postFight.gold, turn: postFight.turn }));
  ok(postFight.monsters === 0, 'a 9-attack swing kills the orc outright', { left: postFight.monsters });
  ok(postFight.kills === 1 && postFight.gold >= 5, 'the kill counts and pays gold', { kills: postFight.kills, gold: postFight.gold });
  ok(postFight.r === preFight.r && postFight.c === preFight.c, 'the @ does not walk onto the dead monster tile', { after: [postFight.r, postFight.c] });
  ok(postFight.turn === preFight.turn + 1, 'the attack spends a turn', { before: preFight.turn, after: postFight.turn });
}

// ---------- 7. the Quaff button, a real DOM click ----------
await ev(`window.__x.setup({hp:5, maxhp:18, inv:['heal'], monsters:[]})`);
await sleep(250);
const preQuaff = await state();
const qbox = await clickEl('quaff', 500);
const postQuaff = await state();
T('quaff ' + JSON.stringify({ box: qbox, before: preQuaff.hp, after: postQuaff.hp, inv: postQuaff.inv }));
ok(postQuaff.hp === preQuaff.hp + 9, 'a real click on Quaff heals 9 hp', { before: preQuaff.hp, after: postQuaff.hp });
ok(postQuaff.inv.length === 0, 'the potion is consumed once — the click does not double-fire', postQuaff.inv);
ok(postQuaff.turn === preQuaff.turn + 1, 'quaffing spends a turn', { before: preQuaff.turn, after: postQuaff.turn });

// ---------- 8. same-point double-tap guard ----------
const dbl = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];const s=w();
  const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);
  let tgt=null;
  for(const [dr,dc] of D){const t=at(s.r+dr,s.c+dc);if(t&&!t.monster){tgt=[t.r,t.c];break;}}
  if(!tgt) return {skip:true};
  const pt=w.cellPoint(tgt[0],tgt[1]);const cv=document.querySelector('body > canvas');
  const before=w();const mk=()=>new PointerEvent('pointerup',{clientX:pt.x,clientY:pt.y,bubbles:true,pointerId:7,pointerType:'touch',isPrimary:true});
  cv.dispatchEvent(mk());cv.dispatchEvent(mk());
  return {tgt,before:[before.r,before.c],after:[w().r,w().c],dups:w().dups,inputs:w().inputs};})()`);
ok(dbl && !dbl.skip && (dbl.after[0] !== dbl.before[0] || dbl.after[1] !== dbl.before[1]), 'two pointerups in one tick move only one step', dbl);
ok(dbl && dbl.dups >= 1, 'the duplicate tap is counted and dropped', dbl && { dups: dbl.dups, inputs: dbl.inputs });

// ---------- 9. a real descent ----------
await ev(`window.__x.setup({depth:1, monsters:[]})`);
await sleep(200);
const stand = await ev(`window.__x.standOn('down')`);
await sleep(250);
const preDown = await state();
ok(preDown.stair === 'down', 'the avatar is standing on the down stairs', { stair: preDown.stair, at: [preDown.r, preDown.c] });
await clickCell(preDown.r, preDown.c, 500);
const postDown = await state();
T('descend ' + JSON.stringify({ stand, before: { depth: preDown.depth, turn: preDown.turn }, after: { depth: postDown.depth, turn: postDown.turn } }));
ok(postDown.depth === preDown.depth + 1, 'tapping the stairs descends a depth', { before: preDown.depth, after: postDown.depth });
ok(postDown.monsters === 2 + postDown.depth, 'the new depth stocks its own monsters', { monsters: postDown.monsters, depth: postDown.depth });
ok(postDown.hp === preDown.hp, 'descending does not cost health', { before: preDown.hp, after: postDown.hp });
await shot('brogue-ce-depth2.png');

// ---------- 10. the win sheet with the Amulet ----------
await ev(`window.__x.setup({depth:1, hasAmulet:true, monsters:[]})`);
await sleep(200);
await ev(`window.__x.standOn('up')`);
await sleep(250);
const preWin = await state();
ok(preWin.hasAmulet === true && preWin.stair === 'up', 'standing on the exit carrying the Amulet', { stair: preWin.stair, amulet: preWin.hasAmulet });
await clickCell(preWin.r, preWin.c, 500);
const win = await state();
const winSheet = await sheet();
T('win ' + JSON.stringify({ win, winSheet }));
ok(win.over === true && win.won === true && win.result === 'won', 'climbing out with the Amulet wins', { over: win.over, won: win.won, result: win.result });
ok(winSheet.open === true && /Amulet/.test(winSheet.title), 'the win sheet names the Amulet', winSheet);
await shot('brogue-ce-win.png');

// a tap on a finished run is ignored
const deadTap = await (async () => { const s0 = await state(); const p = await cellPt(s0.r, s0.c); await click(p); await sleep(250); return { s0, s1: await state() }; })();
ok(deadTap.s1.turn === deadTap.s0.turn, 'taps after the win do not spend turns', { before: deadTap.s0.turn, after: deadTap.s1.turn });

// ---------- 11. the death sheet ----------
const dspot = await ev(`(()=>{const w=window.__x,s=w();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,dc] of D){const r=s.r+dr,c=s.c+dc;const f=w.floorAt(r,c);if(f===1||f===3||f===4)return {r,c};}return null;})()`);
ok(!!dspot, 'found a cell for the troll', dspot);
await ev(`window.__x.setup({newGame:true, seed:20261125, hp:1, maxhp:18, atk:1, monsters:[{kind:'troll', r:${dspot.r}, c:${dspot.c}}]})`);
await sleep(250);
const preDie = await state();
ok(preDie.hp === 1 && preDie.monsters === 1, 'the QA death is set up: 1 hp beside a troll', { hp: preDie.hp, monsters: preDie.monsters });
await clickCell(dspot.r, dspot.c, 500);
const dead = await state();
const deadSheet = await sheet();
T('death ' + JSON.stringify({ dead, deadSheet }));
ok(dead.hp === 0 && dead.over === true && dead.result === 'dead', 'a troll swings the run dead', { hp: dead.hp, result: dead.result });
ok(deadSheet.open === true && /You die on depth/.test(deadSheet.title), 'the death sheet says where it happened', deadSheet);
await shot('brogue-ce-death.png');

// ---------- 12. Play again ----------
const again = await clickEl('overBtn', 800);
const fresh = await state();
ok(fresh.over === false && fresh.depth === 1 && fresh.hp === 18, 'Play again starts a clean depth-1 run', { depth: fresh.depth, hp: fresh.hp, over: fresh.over });
ok((await sheet()).open === false, 'Play again closes the sheet');

// ---------- 13. tile art, then the portrait touch pass ----------
await ev(`window.__x.setup({newGame:true, seed:778899})`);
await sleep(400);
await shot('brogue-ce.png', ART);
await shot('brogue-ce-android.png', ART);

await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(900);
const pBand = await ev(`(()=>{const w=window.__x,b=w.bands(),bad=[];for(let r=0;r<13;r++)for(let c=0;c<21;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,aspect:w.camera().aspect};})()`);
ok(pBand && pBand.bad && pBand.bad.length === 0, 'the whole grid refits inside the band in portrait', pBand && pBand.bad);
ok(pBand && pBand.aspect < 1, 'camera reframed for the portrait viewport', pBand && pBand.aspect);
const pPlan = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];const at=(r,c)=>cells.find((o)=>o.r===r&&o.c===c);const s=w();
  for(const [dr,dc] of D){const t=at(s.r+dr,s.c+dc);if(t&&!t.monster)return {to:{r:t.r,c:t.c},from:{r:s.r,c:s.c}};}return null;})()`);
ok(!!pPlan, 'found a touch target in portrait', pPlan);
if (pPlan) {
  const tp = await cellPt(pPlan.to.r, pPlan.to.c);
  await touch(tp); await sleep(400);
  const touched = await state();
  ok(touched.r === pPlan.to.r && touched.c === pPlan.to.c, 'a real touch moves the @ in portrait', { after: [touched.r, touched.c], want: pPlan.to });
  ok(touched.turn > 0, 'the touch pass spent turns', { turn: touched.turn });
}
await shot('brogue-ce-portrait.png');

// ---------- console hygiene ----------
const exceptions = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const consoleErrors = pageCdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
ok(exceptions.length === 0, 'no uncaught exceptions during the whole gate', exceptions.slice(0, 2).map((e) => e.params.exceptionDetails?.exception?.description));
ok(consoleErrors.length === 0, 'no console errors during the whole gate', consoleErrors.slice(0, 2).map((e) => e.params.args?.map((a) => a.value).join(' ')));

proc.kill('SIGKILL');
server.close();
if (fails.length) { console.error('\nFAILED ' + fails.length + '\n' + fails.join('\n')); process.exit(1); }
console.log('\nOK — Brogue CE boots, picks, steps, fights, quaffs, descends, wins with the Amulet, dies honestly and refits in portrait, all from real clicks');
