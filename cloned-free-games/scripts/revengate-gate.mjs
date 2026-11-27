#!/usr/bin/env node
// Interaction gate for the Revengate port. Real CDP mouse clicks + a portrait touch pass against
// the shipped bytes served straight out of the site repo, asserting state through window.__revengate:
//   boot, picker round-trip on every cell, HUD-band framing, a real step (position + turn move),
//   a wall bump that costs nothing, a melee kill that pays, the Throw button + a thrown dagger that
//   damages a body on the line, the Blast button + a 3x3 dynamite burst, the Quaff button, the
//   same-point double-tap guard, a real descent, taking the ledger off the study floor, the win
//   sheet at the street door, the death sheet, Play again, a 390x844 touch pass, and tile art.
// Takes the art shot into .queue/lib-art/revengate.png.
// usage: node revengate-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/revengate/';
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
const PROFILE = mkdtempSync('/tmp/revengate-gate-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok2, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 60000);
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
// poll for the boot hook rather than sleeping a fixed interval
let booted = false;
for (let i = 0; i < 60; i++) {
  if ((await ev('typeof window.__revengate')) === 'function') { booted = true; break; }
  await sleep(1000);
}
await sleep(1200);

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
const state = () => ev('window.__revengate()');
const sheet = () => ev('window.__x.sheet()');
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
ok(booted, 'the boot hook appears within 60 s');
const hook = await ev('typeof window.__revengate');
ok(hook === 'function', 'window.__revengate is a callable hook', { hook });
let st = await state();
T('boot state ' + JSON.stringify(st));
if (!ok(st && !st.__err, 'boot state reads', st)) { T('aborting: no hook'); proc.kill('SIGKILL'); process.exit(1); }
ok(st.depth === 1 && st.depths === 4, 'boots on depth 1 of 4', st);
ok(st.hp === 20 && st.maxhp === 20 && !st.over, 'fresh case: full health, not over', st);
ok(st.monsters === 4, 'depth 1 spawns four bodies', { monsters: st.monsters });
ok(st.inv.filter((k) => k === 'dagger').length === 2, 'the investigator starts with two daggers', st.inv);
ok(!!st.up && !!st.down, 'both staircases exist on depth 1', { up: st.up, down: st.down });
ok(st.r !== st.up[0] || st.c !== st.up[1], 'the investigator does not spawn on the up stairs', { at: [st.r, st.c], up: st.up });
const near = st.monstersAll.filter((m) => Math.max(Math.abs(m.r - st.r), Math.abs(m.c - st.c)) <= 3).length;
ok(near === 0, 'no monster is within 3 tiles at the spawn (deterministic first move)', st.monstersAll);
const drew = await ev(`(()=>{const c=document.querySelector('body > canvas');return c?{w:c.width,h:c.height}:null})()`);
ok(drew && drew.w > 300, 'the renderer canvas is sized', drew);
await shot('revengate-boot.png');

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
await ev(`window.__x.setup({r:${plan.from.r},c:${plan.from.c}, monsters:[]})`);
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
  const spot = await ev(`(()=>{const w=window.__x,cellsw=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const o of cellsw){for(const [dr,dc] of D){if(w.floorAt(o.r+dr,o.c+dc)===2)return {r:o.r,c:o.c,w:{r:o.r+dr,c:o.c+dc}};}}return null;})()`);
  if (spot) { await ev(`window.__x.setup({r:${spot.r},c:${spot.c}, monsters:[]})`); await sleep(250); wall = spot.w; }
}
ok(!!wall, 'found a wall to bump into', wall);
if (wall) {
  const preBump = await state();
  await clickCell(wall.r, wall.c, 300);
  const postBump = await state();
  ok(postBump.r === preBump.r && postBump.c === preBump.c, 'a wall bump does not move the @', { before: [preBump.r, preBump.c], after: [postBump.r, postBump.c] });
  ok(postBump.turn === preBump.turn, 'a wall bump does not spend a turn', { before: preBump.turn, after: postBump.turn });
}

// ---------- 6. a melee kill that pays ----------
const mspot = await ev(`(()=>{const w=window.__x,s=w();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,dc] of D){const r=s.r+dr,c=s.c+dc;const f=w.floorAt(r,c);if(f===1||f===3||f===4)return {r,c};}return null;})()`);
ok(!!mspot, 'found a cell beside the @ for the fight', mspot);
if (mspot) {
  await ev(`window.__x.setup({atk:9, monsters:[{kind:'outlaw', r:${mspot.r}, c:${mspot.c}}]})`);
  await sleep(250);
  const preFight = await state();
  ok(preFight.monsters === 1 && preFight.kills === 0, 'the QA fight is set up with one outlaw', preFight.monstersAll);
  await clickCell(mspot.r, mspot.c, 400);
  const postFight = await state();
  T('fight ' + JSON.stringify({ pre: preFight.monstersAll, post: postFight.monstersAll, kills: postFight.kills, francs: postFight.francs, turn: postFight.turn }));
  ok(postFight.monsters === 0, 'a 9-attack swing drops the outlaw outright', { left: postFight.monsters });
  ok(postFight.kills === 1 && postFight.francs >= 4, 'the kill counts and pays francs', { kills: postFight.kills, francs: postFight.francs });
  ok(postFight.r === preFight.r && postFight.c === preFight.c, 'the @ does not walk onto the dead body', { after: [postFight.r, postFight.c] });
  ok(postFight.turn === preFight.turn + 1, 'the melee blow spends a turn', { before: preFight.turn, after: postFight.turn });
}

// ---------- 7. the Throw button: arm, then a real click on a body down the line ----------
const tline = await ev(`(()=>{const w=window.__x;const cells=w.walkable();
  for (const o of cells) {
    for (const [dr,dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      for (let k=4;k>=3;k--) {
        const r=o.r+dr*k, c=o.c+dc*k;
        if (!cells.find(x=>x.r===r&&x.c===c)) continue;
        const line=w.line(o.r,o.c,r,c);
        if (line.length!==k) continue;
        if (!line.every(([rr,cc])=>{const f=w.floorAt(rr,cc);return f===1||f===3||f===4;})) continue;
        return {from:{r:o.r,c:o.c}, to:{r,c}, k};
      }
    }
  }
  return null;})()`);
ok(!!tline, 'found a clean four-tile throwing line', tline);
if (tline) {
  await ev(`window.__x.setup({r:${tline.from.r}, c:${tline.from.c}, inv:['dagger'], monsters:[{kind:'gamin', r:${tline.to.r}, c:${tline.to.c}, hp:99}]})`);
  await sleep(250);
  const preThrow = await state();
  const armBox = await clickEl('throw', 400);
  const armed = await state();
  T('arm ' + JSON.stringify({ box: armBox, arm: armed.arm }));
  ok(armed.arm === 'dagger', 'the Throw button arms a dagger throw', { arm: armed.arm });
  await clickCell(tline.to.r, tline.to.c, 500);
  const postThrow = await state();
  T('throw ' + JSON.stringify({ before: preThrow.inv, after: postThrow.inv, hp: postThrow.monstersAll, arm: postThrow.arm }));
  ok(postThrow.inv.filter((k) => k === 'dagger').length === preThrow.inv.filter((k) => k === 'dagger').length - 1, 'the thrown dagger is spent', { before: preThrow.inv, after: postThrow.inv });
  ok(postThrow.monstersAll.length === 1 && postThrow.monstersAll[0].hp < 99, 'the dagger damages the body on the line', postThrow.monstersAll);
  ok(postThrow.arm === null, 'the throw disarms after it lands', { arm: postThrow.arm });
  ok(postThrow.turn === preThrow.turn + 1, 'the throw spends a turn', { before: preThrow.turn, after: postThrow.turn });
  await shot('revengate-throw.png');
}

// ---------- 8. the Blast button: a 3x3 dynamite burst ----------
const bline = await ev(`(()=>{const w=window.__x;const cells=w.walkable();
  for (const o of cells) {
    for (const [dr,dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
      const r=o.r+dr*3, c=o.c+dc*3;
      if (!cells.find(x=>x.r===r&&x.c===c)) continue;
      const line=w.line(o.r,o.c,r,c);
      if (line.length!==3) continue;
      if (!line.every(([rr,cc])=>{const f=w.floorAt(rr,cc);return f===1||f===3||f===4;})) continue;
      const n=cells.find(x=>x.r===r+1&&x.c===c);
      if (!n) continue;
      return {from:{r:o.r,c:o.c}, to:{r,c}, mate:{r:n.r,c:n.c}};
    }
  }
  return null;})()`);
ok(!!bline, 'found a three-tile line with a neighbour cell for the burst', bline);
if (bline) {
  await ev(`window.__x.setup({r:${bline.from.r}, c:${bline.from.c}, inv:['dynamite'], monsters:[
    {kind:'outlaw', r:${bline.to.r}, c:${bline.to.c}, hp:20},
    {kind:'gamin', r:${bline.mate.r}, c:${bline.mate.c}, hp:20}]})`);
  await sleep(250);
  const preBlast = await state();
  ok(preBlast.monsters === 2, 'the blast fixture stands two bodies in the burst', preBlast.monstersAll);
  await clickEl('blast', 400);
  const armedB = await state();
  ok(armedB.arm === 'dynamite', 'the Blast button arms a stick', { arm: armedB.arm });
  await clickCell(bline.to.r, bline.to.c, 500);
  const postBlast = await state();
  T('blast ' + JSON.stringify({ before: preBlast.monstersAll, after: postBlast.monstersAll, inv: postBlast.inv }));
  ok(postBlast.monstersAll.length === 2 && postBlast.monstersAll.every((m) => m.hp === 11), 'the 3x3 burst takes exactly 9 hp off each body', postBlast.monstersAll);
  ok(postBlast.inv.filter((k) => k === 'dynamite').length === 0, 'the stick is spent', postBlast.inv);
  ok(postBlast.arm === null, 'the blast disarms after it lands', { arm: postBlast.arm });
}

// ---------- 9. the Quaff button, a real DOM click ----------
await ev(`window.__x.setup({hp:5, maxhp:20, inv:['absinthe'], monsters:[]})`);
await sleep(250);
const preQuaff = await state();
const qbox = await clickEl('quaff', 500);
const postQuaff = await state();
T('quaff ' + JSON.stringify({ box: qbox, before: preQuaff.hp, after: postQuaff.hp, inv: postQuaff.inv }));
ok(postQuaff.hp === preQuaff.hp + 9, 'a real click on Quaff heals 9 hp', { before: preQuaff.hp, after: postQuaff.hp });
ok(postQuaff.inv.length === 0, 'the flask is consumed once — the click does not double-fire', postQuaff.inv);
ok(postQuaff.turn === preQuaff.turn + 1, 'quaffing spends a turn', { before: preQuaff.turn, after: postQuaff.turn });

// ---------- 10. same-point double-tap guard ----------
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

// ---------- 11. a real descent ----------
await ev(`window.__x.setup({depth:1, monsters:[]})`);
await sleep(200);
const stand = await ev(`window.__x.standOn('down')`);
await sleep(250);
const preDown = await state();
ok(preDown.stair === 'down', 'the investigator is standing on the down stairs', { stair: preDown.stair, at: [preDown.r, preDown.c] });
await clickCell(preDown.r, preDown.c, 500);
const postDown = await state();
T('descend ' + JSON.stringify({ stand, before: { depth: preDown.depth, turn: preDown.turn }, after: { depth: postDown.depth, turn: postDown.turn } }));
ok(postDown.depth === preDown.depth + 1, 'tapping the stairs descends a depth', { before: preDown.depth, after: postDown.depth });
ok(postDown.monsters === 3 + postDown.depth, 'the new depth stocks its own bodies', { monsters: postDown.monsters, depth: postDown.depth });
ok(postDown.hp === preDown.hp, 'descending does not cost health', { before: preDown.hp, after: postDown.hp });

// ---------- 12. taking the ledger off the study floor ----------
await ev(`window.__x.setup({depth:4, clearMonsters:true, monsters:[]})`);
await sleep(250);
const st4 = await state();
const led = (st4.itemsAll || []).find((i) => i.kind === 'ledger');
ok(!!led, 'the ledger lies on the bottom depth', st4.itemsAll);
if (led) {
  const adj = await ev(`(()=>{const w=window.__x;const cells=w.walkable();const D=[[-1,0],[1,0],[0,-1],[0,1]];
    for(const [dr,dc] of D){const t=cells.find(o=>o.r===${led.r}+dr&&o.c===${led.c}+dc);if(t&&!t.monster)return {r:t.r,c:t.c};}return null;})()`);
  ok(!!adj, 'found a floor cell beside the ledger', adj);
  if (adj) {
    await ev(`window.__x.setup({depth:4, clearMonsters:true, monsters:[], r:${adj.r}, c:${adj.c}})`);
    await sleep(250);
    const prePick = await state();
    ok(prePick.hasLedger === false, 'the ledger is not carried before the step', prePick.hasLedger);
    await clickCell(led.r, led.c, 450);
    const postPick = await state();
    ok(postPick.hasLedger === true, 'stepping onto the ledger takes it', { hasLedger: postPick.hasLedger, at: [postPick.r, postPick.c] });
    ok((postPick.inv || []).length === 0, 'the ledger is a quest item, not pack clutter', postPick.inv);
  }
}

// ---------- 13. the win sheet at the street door ----------
await ev(`window.__x.setup({depth:1, hasLedger:true, clearMonsters:true, monsters:[]})`);
await sleep(200);
await ev(`window.__x.standOn('up')`);
await sleep(250);
const preWin = await state();
ok(preWin.hasLedger === true && preWin.stair === 'up', 'standing on the street door carrying the ledger', { stair: preWin.stair, ledger: preWin.hasLedger });
await clickCell(preWin.r, preWin.c, 500);
const win = await state();
const winSheet = await sheet();
T('win ' + JSON.stringify({ win, winSheet }));
ok(win.over === true && win.won === true && win.result === 'won', 'climbing out with the ledger wins', { over: win.over, won: win.won, result: win.result });
ok(winSheet.open === true && /ledger/i.test(winSheet.title), 'the win sheet names the ledger', winSheet);
await shot('revengate-win.png');

const deadTap = await (async () => { const s0 = await state(); const p = await cellPt(s0.r, s0.c); await click(p); await sleep(250); return { s0, s1: await state() }; })();
ok(deadTap.s1.turn === deadTap.s0.turn, 'taps after the win do not spend turns', { before: deadTap.s0.turn, after: deadTap.s1.turn });

// ---------- 14. the death sheet ----------
await ev(`window.__x.setup({newGame:true, seed:20261126, hp:1, maxhp:20, atk:1, monsters:[]})`);
await sleep(250);
const dspot = await ev(`(()=>{const w=window.__x,s=w();const D=[[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,dc] of D){const r=s.r+dr,c=s.c+dc;const f=w.floorAt(r,c);if(f===1||f===3||f===4)return {r,c};}return null;})()`);
ok(!!dspot, 'found a cell for the vampire at the fresh spawn', dspot);
if (dspot) {
  await ev(`window.__x.setup({newGame:true, seed:20261126, hp:1, maxhp:20, atk:1, monsters:[{kind:'vampire', r:${dspot.r}, c:${dspot.c}}]})`);
  await sleep(250);
}
const preDie = await state();
ok(preDie.hp === 1 && preDie.monsters === 1, 'the QA death is set up: 1 hp beside a vampire', { hp: preDie.hp, monsters: preDie.monsters });
await clickCell(dspot.r, dspot.c, 500);
const dead = await state();
const deadSheet = await sheet();
T('death ' + JSON.stringify({ dead, deadSheet }));
ok(dead.hp === 0 && dead.over === true && dead.result === 'dead', 'a vampire swings the run dead', { hp: dead.hp, result: dead.result });
ok(deadSheet.open === true && /You are found on depth/.test(deadSheet.title), 'the death sheet says where it happened', deadSheet);
await shot('revengate-death.png');

// ---------- 15. Play again ----------
await clickEl('overBtn', 800);
const fresh = await state();
ok(fresh.over === false && fresh.depth === 1 && fresh.hp === 20, 'Play again starts a clean depth-1 case', { depth: fresh.depth, hp: fresh.hp, over: fresh.over });
ok((await sheet()).open === false, 'Play again closes the sheet');

// ---------- 16. tile art, then the portrait touch pass ----------
await ev(`window.__x.setup({newGame:true, seed:778899, monsters:[]})`);
await sleep(250);
// put two bodies inside the lantern light so the card shows a crawl, not an empty board
const artSpot = await ev(`(()=>{const w=window.__x,s=w();const cells=w.walkable();
  const D=[[1,0],[-1,0],[0,1],[0,-1]];
  for(const o of cells){
    const d=Math.max(Math.abs(o.r-s.r),Math.abs(o.c-s.c));
    if(d<3||d>5) continue;
    if(!w.litAt(o.r,o.c)) continue;
    const mate=D.map(([dr,dc])=>cells.find(x=>x.r===o.r+dr&&x.c===o.c+dc)).find(x=>x&&w.litAt(x.r,x.c));
    if(!mate) continue;
    w.setup({monsters:[{kind:'outlaw',r:o.r,c:o.c},{kind:'vampire',r:mate.r,c:mate.c}]});
    return {a:[o.r,o.c],b:[mate.r,mate.c]};
  }
  return null;})()`);
T('art spot ' + JSON.stringify(artSpot));
await sleep(500);
const artCheck = await ev(`(()=>{const w=window.__x,s=w();return {n:s.monstersAll.length, lit:s.monstersAll.map(m=>w.litAt(m.r,m.c)), sheet:w.sheet().open};})()`);
ok(artCheck && artCheck.n === 2 && artCheck.lit.every(Boolean) && !artCheck.sheet, 'the art fixture has both bodies standing inside the light', artCheck);
await shot('revengate.png', ART);

await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
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
await shot('revengate-portrait.png');

// ---------- console hygiene ----------
const exceptions = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const consoleErrors = pageCdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
ok(exceptions.length === 0, 'no uncaught exceptions during the whole gate', exceptions.slice(0, 2).map((e) => e.params.exceptionDetails?.exception?.description));
ok(consoleErrors.length === 0, 'no console errors during the whole gate', consoleErrors.slice(0, 2).map((e) => e.params.args?.map((a) => a.value).join(' ')));

proc.kill('SIGKILL');
server.close();
if (fails.length) { console.error('\nFAILED ' + fails.length + '\n' + fails.join('\n')); process.exit(1); }
console.log('\nOK — Revengate boots, picks, steps, fights, throws, blasts, quaffs, descends, takes the ledger, wins at the street door, dies honestly and refits in portrait, all from real clicks');
