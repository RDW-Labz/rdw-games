#!/usr/bin/env node
// Interaction gate for the Cubit port (arrow face). Real CDP mouse + touch clicks against the
// shipped bytes served straight out of the site repo, asserting state through the page's own hook:
//   boot + console errors, the picker round-trip on every cell, HUD-band framing, a blocking bump
//   (life lost, arrow kept), a free slide (arrow gone), the same-point double-tap guard, the full
//   reference solve to the win sheet, Play again, four bumps to the lose sheet, Back up, the level
//   select to a bigger cube, and a 390x844 portrait touch pass. Takes the tile-art screenshot.
// usage: node cubit-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/cubit/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const ART = '/home/cluer/cloned-free-games/.queue/lib-art/Cubit.png';
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
const PROFILE = mkdtempSync('/tmp/cubit-gate-');
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
const state = () => ev('window.__cubit()');
const sheet = () => ev(`(()=>({open:document.getElementById('over').classList.contains('open'),title:document.getElementById('overTitle').textContent}))()`);
const cellPt = (r, c) => ev(`window.__cubit.cellPoint(${r},${c})`);
const clickCell = async (r, c, wait = 260) => {
  const p = await cellPt(r, c);
  if (!p || p.__err) return { err: (p && p.__err) || 'no point', r, c };
  await click(p); await sleep(wait); return p;
};
const shot = async (name) => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const path = join(OUT, name);
  await writeFile(path, Buffer.from(r.data, 'base64'));
  T('shot ' + path);
  return path;
};

// ---------- 1. boot ----------
const hook = await ev('typeof window.__cubit');
ok(hook === 'function', 'window.__cubit is a callable hook', { hook });
let st = await state();
T('boot state ' + JSON.stringify(st));
if (!ok(st && !st.__err, 'boot state reads', st)) { T('aborting: no hook'); proc.kill('SIGKILL'); process.exit(1); }
ok(st.level === 1 && st.n === 6, 'boots on cube 1 (6x6)', st);
ok(st.arrows === st.total && st.total === 12, 'twelve arrows on the boot cube', { arrows: st.arrows, total: st.total });
ok(st.lives === 4 && st.bumps === 0 && st.over === false, 'fresh run: four lives, no bumps, not over', st);
ok(st.pinkOn === true && st.pink && st.pink.length === 2, 'the pink target sits on a live arrow', st.pink);
ok(st.free >= 1 && st.blocked >= 2, 'boot cube offers both free and blocked arrows', { free: st.free, blocked: st.blocked });
const drew = await ev(`(()=>{const c=document.querySelector('body > canvas');return c?{w:c.width,h:c.height}:null})()`);
ok(drew && drew.w > 300, 'the renderer canvas is sized', drew);
await shot('cubit-boot.png');

// ---------- 2. picker round-trip on every cell ----------
const rt = await ev(`(()=>{const w=window.__x,bad=[];for(let r=0;r<w().n;r++)for(let c=0;c<w().n;c++){const p=w.cellPoint(r,c);if(!p){bad.push([r,c,'nopoint']);continue;}const back=w.cellAt(p.x,p.y);if(!back||back[0]!==r||back[1]!==c)bad.push([r,c,back]);}return {bad,total:w().n*w().n};})()`);
ok(rt && rt.bad && rt.bad.length === 0, 'cellPoint -> cellAt round-trips on all ' + (rt && rt.total) + ' cells', rt && rt.bad);

// ---------- 3. HUD-band framing ----------
const band = await ev(`(()=>{const w=window.__x,b=w.bands(),n=w().n,bad=[];for(let r=0;r<n;r++)for(let c=0;c<n;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,aspect:w.camera().aspect,dist:w.camera().dist};})()`);
ok(band && band.bad && band.bad.length === 0, 'every cell projects inside the HUD band (not under the bars)', band && band.bad);
ok(band && band.aspect > 1, 'camera framed for the landscape viewport', band && band.aspect);

// ---------- 4. a blocked arrow: bump, life lost, arrow kept ----------
const beforeBump = await state();
const blockedList = await ev('window.__cubit.blocked()');
const bumpCell = blockedList[0];
const bp = await clickCell(bumpCell[0], bumpCell[1], 380);
let afterBump = await state();
T('bump ' + JSON.stringify({ cell: bumpCell, pt: bp, before: beforeBump.lives, after: afterBump.lives }));
ok(afterBump.bumps === beforeBump.bumps + 1, 'a blocked tap counts a bump', { before: beforeBump.bumps, after: afterBump.bumps });
ok(afterBump.lives === beforeBump.lives - 1, 'a blocked tap costs a life', { before: beforeBump.lives, after: afterBump.lives });
ok(afterBump.arrows === beforeBump.arrows, 'a blocked tap leaves the arrow on the face', { before: beforeBump.arrows, after: afterBump.arrows });
ok(afterBump.lastBlock && afterBump.lastBlock.length === 2, 'the hook names the arrow that was in the way', afterBump.lastBlock);
await shot('cubit-bump.png');

// ---------- 5. a free arrow slides off ----------
const freeList = await ev('window.__cubit.free()');
const beforeFree = await state();
const fp = await clickCell(freeList[0][0], freeList[0][1], 380);
const afterFree = await state();
T('free ' + JSON.stringify({ cell: freeList[0], pt: fp, before: beforeFree.arrows, after: afterFree.arrows }));
ok(afterFree.arrows === beforeFree.arrows - 1, 'a free tap takes one arrow off the face', { before: beforeFree.arrows, after: afterFree.arrows });
ok(afterFree.freed === beforeFree.freed + 1, 'the freed counter climbs with it', { before: beforeFree.freed, after: afterFree.freed });
ok(afterFree.free >= 1, 'the cube still offers moves after a slide', { free: afterFree.free });

// ---------- 6. same-point double-tap guard ----------
const dbl = await ev(`(async()=>{const w=window.__x,p=w.free()[0];if(!p)return {skip:true};const pt=w.cellPoint(p[0],p[1]);const cv=document.querySelector('body > canvas');const before=w();const mk=()=>new PointerEvent('pointerup',{clientX:pt.x,clientY:pt.y,bubbles:true,pointerId:7,pointerType:'touch',isPrimary:true});cv.dispatchEvent(mk());cv.dispatchEvent(mk());return {cell:p,arrows0:before.arrows,arrows1:w().arrows,dups:w().dups,inputs:w().inputs};})()`);
ok(dbl && !dbl.skip && dbl.arrows1 === dbl.arrows0 - 1, 'two pointerups in one tick remove only one arrow', dbl);
ok(dbl && dbl.dups >= 1, 'the duplicate tap is counted and dropped', dbl && { dups: dbl.dups });

// ---------- 7. the full reference solve -> win ----------
let steps = 0, solvable = true;
for (let guard = 0; guard < 200; guard++) {
  const s = await state();
  if (s.over) break;
  const sol = await ev('window.__cubit.solution()');
  if (!sol || !sol.length) { solvable = false; break; }
  const [r, c] = sol[0];
  const p = await clickCell(r, c, 200);
  steps++;
  const now = await state();
  if (now.__err) { solvable = false; break; }
  if (now.arrows === s.arrows) { T('solve stalled at ' + JSON.stringify({ r, c, p, s })); solvable = false; break; }
}
const win = await state();
const winSheet = await sheet();
T('solve ' + JSON.stringify({ steps, win, winSheet }));
ok(solvable, 'the reference solve never stalls', { steps });
ok(win.over === true && win.won === true, 'the solve reaches a win', win);
ok(win.pinkOn === false, 'the pink arrow is off the face at the win', { pinkOn: win.pinkOn });
ok(winSheet.open === true && /Dug it out|Full clear/.test(winSheet.title), 'the win sheet names the result', winSheet);
ok(win.arrows === 0 || win.fullClear === false, 'a partial win still leaves arrows behind honestly', { arrows: win.arrows, fullClear: win.fullClear });
await shot('cubit-win.png');

// ---------- 8. Play again restores the cube ----------
await ev(`document.getElementById('overBtn').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
await sleep(700);
let again = await state();
ok(again.over === false && again.arrows === again.total && again.lives === 4, 'Play again rebuilds a full cube', again);

// ---------- 9. four bumps -> the lose sheet ----------
for (let i = 0; i < 4; i++) {
  const bl = await ev('window.__cubit.blocked()');
  if (!bl || !bl.length) break;
  await clickCell(bl[0][0], bl[0][1], 240);
}
const lose = await state();
const loseSheet = await sheet();
T('lose ' + JSON.stringify({ lose, loseSheet }));
ok(lose.over === true && lose.won === false, 'lives run out into a loss', { lives: lose.lives, over: lose.over, won: lose.won });
ok(loseSheet.open === true && /Out of lives/.test(loseSheet.title), 'the lose sheet says the arrows won', loseSheet);
await shot('cubit-lose.png');

// a tap on a finished cube is ignored
const deadTap = await (async () => { const s0 = await state(); const p = await cellPt(0, 0); await click(p); await sleep(200); return { s0, s1: await state() }; })();
ok(deadTap.s1.arrows === deadTap.s0.arrows, 'taps on a finished cube do not move it', { before: deadTap.s0.arrows, after: deadTap.s1.arrows });

// ---------- 10. Back up, then a bigger cube ----------
await ev(`document.getElementById('overBack').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
await sleep(300);
ok((await sheet()).open === false, 'Back up dismisses the sheet');
await ev(`(()=>{const s=document.getElementById('level');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(900);
const big = await state();
ok(big.n === 8 && big.arrows === big.total && big.total === 22, 'level select loads cube 2 (8x8, 22 arrows)', big);
const bigBand = await ev(`(()=>{const w=window.__x,n=w().n,b=w.bands(),bad=[];for(let r=0;r<n;r++)for(let c=0;c<n;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2)bad.push([r,c]);}return bad;})()`);
ok(bigBand && bigBand.length === 0, 'cube 2 refits inside the band too', bigBand);
// one honest tap on the bigger cube
const bigFree = await ev('window.__cubit.free()');
await clickCell(bigFree[0][0], bigFree[0][1], 350);
const bigAfter = await state();
ok(bigAfter.arrows === big.arrows - 1, 'cube 2 accepts a real tap', { before: big.arrows, after: bigAfter.arrows });
await shot('cubit-cube2.png');

// ---------- 11. portrait touch pass ----------
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
// prime the override with a neutral press on the HUD, per the headless first-event lesson
await click({ x: 195, y: 60 });
await sleep(300);
await ev(`window.__cubit.level(0)`);
await sleep(900);
const pgo = await ev(`(()=>{const w=window.__x,b=w.bands(),n=w().n,bad=[];for(let r=0;r<n;r++)for(let c=0;c<n;c++){const p=w.cellPoint(r,c);if(!p||p.y<b.top-2||p.y>b.bottom+2||p.x<0||p.x>innerWidth)bad.push([r,c,p]);}return {bad,band:b,cam:w.camera(),st:w()};})()`);
ok(pgo && pgo.bad && pgo.bad.length === 0, 'portrait: every cell sits inside the HUD band', pgo && pgo.bad);
ok(pgo && pgo.cam.aspect < 1, 'portrait: the camera reframed for the tall viewport', pgo && pgo.cam);
const pFree = await ev('window.__cubit.free()');
const pPt = await ev(`window.__cubit.cellPoint(${pFree[0][0]},${pFree[0][1]})`);
await touch(pPt);
await sleep(450);
let pSt = await state();
if (!pSt || pSt.arrows !== pgo.st.arrows - 1) { await touch(pPt); await sleep(450); pSt = await state(); }
ok(pSt.arrows === pgo.st.arrows - 1, 'portrait: a finger tap slides an arrow off', { before: pgo.st.arrows, after: pSt && pSt.arrows, pt: pPt });
const artShot = await shot('cubit-portrait.png');
await mkdir('/home/cluer/cloned-free-games/.queue/lib-art', { recursive: true });
await writeFile(ART, await readFile(artShot));
T('art ' + ART);

// ---------- 12. console errors ----------
const bad = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' &&
   !/favicon|net::ERR_ABORTED/.test(e.params.entry.text || '')));
ok(bad.length === 0, 'no console errors or exceptions', bad.slice(0, 3).map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.exception?.description));

T(fails.length ? `CUBIT GATE FAILED ${fails.length}` : 'CUBIT GATE PASS');
for (const f of fails) T(' - ' + f);
proc.kill('SIGKILL');
server.close();
process.exit(fails.length ? 1 : 0);
