#!/usr/bin/env node
// Interaction gate for the SuperTuxKart port. Real CDP key presses, a held pointer on the Drift
// button, a real touch on the left half of the track, and the race UI, all against the shipped bytes
// served straight out of the site repo, asserted through window.__stk:
//   boot (grid, HUD, camera behind the kart), auto-throttle, keyboard steering both ways, drift held
//   to the cap, a boost over the cap, dropped oil spinning the player, a box taken off the track, a
//   real finish at the flag with the sheet, Race again, a 390x844 touch-steer pass, and tile art.
// usage: node supertuxkart-gate.mjs [site-root]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const T = (m) => console.error('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const ROOT = resolve(process.argv[2] || '/home/cluer/Projects/rdw-games/shelf');
const FILE = 'games/arcade/supertuxkart/';
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
const PROFILE = mkdtempSync('/tmp/stk-gate-');
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
let booted = false;
for (let i = 0; i < 60; i++) {
  if ((await ev('typeof window.__stk')) === 'function') { booted = true; break; }
  await sleep(1000);
}
await sleep(1200);

const key = async (code, type, keyName) => {
  const keyMap = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Space: ' ' };
  await S('Input.dispatchKeyEvent', {
    type, code, key: keyName || keyMap[code] || code, windowsVirtualKeyCode: code === 'ArrowLeft' ? 37 : code === 'ArrowRight' ? 39 : 32,
  });
};
const holdKey = async (code, ms) => { await key(code, 'keyDown'); await sleep(ms); await key(code, 'keyUp'); };
const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
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
const state = () => ev('window.__stk()');

// ---------- 1. boot ----------
ok(booted, 'the boot hook appears within 60 s');
let st = await state();
T('boot ' + JSON.stringify(st && { lap: st.lap, place: st.place, s: st.s, v: st.v, karts: st.karts.length, boxes: st.boxes }));
if (!ok(st && !st.__err, 'boot state reads', st)) { proc.kill('SIGKILL'); process.exit(1); }
ok(st.laps === 3 && st.lap <= 0, 'the car starts on the grid at the line, three laps to run', { laps: st.laps, lap: st.lap });
ok(st.karts.length === 4 && st.karts.filter((k) => k.name !== 'you').length === 3, 'three rivals line up with the player', st.karts.map((k) => k.name));
ok(st.boxes >= 12, 'item boxes are on the track', { boxes: st.boxes });
ok(st.over === false && st.t < 5, 'the race is running and has not ended', { over: st.over, t: st.t });
const drawInfo = await ev(`(()=>{const c=document.querySelector('body > canvas');return {w:c.width,h:c.height,children:0};})()`);
ok(drawInfo && drawInfo.w > 300, 'the renderer canvas is sized', drawInfo);
const cam0 = await ev('window.__stk.camera()');
ok(cam0 && cam0.pos[1] > 2 && cam0.pos[1] < 12, 'the chase camera sits above and behind the kart', cam0);
const lapText = await ev("document.getElementById('lap').textContent");
ok(/^1\/3$/.test(lapText), 'the HUD reads lap 1 of 3 on the grid', { lapText });
await shot('supertuxkart-boot.png');

// ---------- 2. auto-throttle and the clock ----------
await sleep(1600);
const rolling = await state();
T('rolling ' + JSON.stringify({ v: rolling.v, s: rolling.s, t: rolling.t }));
ok(rolling.v > 12, 'the kart accelerates without any input', { v: rolling.v });
ok(rolling.t > 1, 'the race clock runs', { t: rolling.t });
const clockText = await ev("document.getElementById('clock').textContent");
ok(/^0:0\d$/.test(clockText) || /^0:[1-9]\d$/.test(clockText), 'the HUD clock counts up', { clockText });

// ---------- 3. keyboard steering both ways ----------
await ev('window.__stk.setup({lat:0, v:18})');
await sleep(150);
const beforeRight = await state();
await key('ArrowRight', 'keyDown');
await sleep(500);
const midRight = await state();
await key('ArrowRight', 'keyUp');
T('steer right ' + JSON.stringify({ lat0: beforeRight.lat, lat1: midRight.lat, steer: midRight.steer }));
ok(midRight.steer > 0, 'holding the right arrow registers as steer +1', { steer: midRight.steer });
ok(midRight.lat > beforeRight.lat + 0.3, 'holding right moves the kart right across the ribbon', { before: beforeRight.lat, after: midRight.lat });

await ev('window.__stk.setup({lat:0, v:18})');
await sleep(150);
await key('ArrowLeft', 'keyDown');
await sleep(500);
const midLeft = await state();
await key('ArrowLeft', 'keyUp');
T('steer left ' + JSON.stringify({ lat: midLeft.lat, steer: midLeft.steer }));
ok(midLeft.steer < 0, 'holding the left arrow registers as steer -1', { steer: midLeft.steer });
ok(midLeft.lat < -0.3, 'holding left moves the kart left across the ribbon', { lat: midLeft.lat });

// ---------- 4. drift held on the button exceeds the plain cap ----------
await ev('window.__stk.setup({newRace:true, seed:20261126, lat:0})');
await sleep(200);
await sleep(1400);
const plainTop = await state();
const driftBox = await ev(`(()=>{const e=document.getElementById('drift');const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width};})()`);
ok(driftBox && driftBox.w > 0, 'the Drift button is on screen', driftBox);
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: driftBox.x, y: driftBox.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(900);
const drifting = await state();
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: driftBox.x, y: driftBox.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
await sleep(300);
const released = await state();
T('drift ' + JSON.stringify({ plainV: plainTop.v, driftV: drifting.v, drift: drifting.drift, after: released.drift }));
ok(drifting.drift === true, 'holding the Drift button sets the drift flag', { drift: drifting.drift });
ok(drifting.v > plainTop.v + 0.4, 'drifting runs past the plain top speed', { plain: plainTop.v, drift: drifting.v });
ok(released.drift === false, 'releasing the button stops the drift', { drift: released.drift });

// ---------- 5. a boost takes the kart past its cap ----------
await ev('window.__stk.setup({boost:4, v:26, lat:0})');
await sleep(900);
const boosted = await state();
T('boost ' + JSON.stringify({ v: boosted.v, boost: boosted.boost }));
ok(boosted.v > 28.5, 'a boost pushes the kart past the normal top speed', { v: boosted.v });

// ---------- 6. a box on the track is taken ----------
const boxBefore = await state();
const firstBox = (boxBefore.boxList || []).find((b) => b.alive);
ok(!!firstBox, 'a live box exists to drive through', boxBefore.boxList && boxBefore.boxList.slice(0, 3));
if (firstBox) {
  await ev(`window.__stk.setup({s:${firstBox.s}, lat:${firstBox.lat}, v:18})`);
  await sleep(350);
  const boxAfter = await state();
  const stillThere = (boxAfter.boxList || []).some((b) => b.alive && Math.abs(b.s - firstBox.s) < 0.01 && Math.abs(b.lat - firstBox.lat) < 0.01);
  T('box ' + JSON.stringify({ before: boxBefore.boxes, after: boxAfter.boxes, at: firstBox }));
  ok(!stillThere, 'driving through a box takes it off the track', { at: firstBox, after: boxAfter.boxes });
  ok(boxAfter.boxes === boxBefore.boxes - 1, 'exactly one box is consumed', { before: boxBefore.boxes, after: boxAfter.boxes });
}

// ---------- 7. dropped oil spins the player ----------
await ev(`window.__stk.setup({v:20, lat:0})`);
await sleep(150);
const preOil = await state();
await ev(`window.__stk.setup({oils:[{s:${preOil.s.toFixed(2)}, lat:0, life:5}], v:20})`);
await sleep(400);
const spun = await state();
T('oil ' + JSON.stringify({ spin: spun.spin, v: spun.v, wasV: preOil.v }));
ok(spun.spin > 0, 'oil on the ribbon spins the kart out', { spin: spun.spin });
ok(spun.v < preOil.v, 'the spin costs speed', { before: preOil.v, after: spun.v });

// ---------- 8. a real finish at the flag ----------
await ev(`window.__stk.setup({newRace:true, seed:20261126})`);
await sleep(300);
const nearLine = await ev(`(()=>{const w=window.__stk,s=w();
  w.setup({lap:2, s: s.trackLength - 2.2, v:25});
  return w();})()`);
T('near line ' + JSON.stringify({ lap: nearLine.lap, s: nearLine.s, L: nearLine.trackLength }));
ok(nearLine.lap === 2 && nearLine.s > nearLine.trackLength - 3, 'the player is set a kart-length from the flag on the last lap', { lap: nearLine.lap, s: nearLine.s, L: nearLine.trackLength });
let finished = null;
for (let i = 0; i < 60; i++) {
  const s2 = await state();
  if (s2.over) { finished = s2; break; }
  await sleep(100);
}
T('finish ' + JSON.stringify(finished && { t: finished.t, place: finished.place, won: finished.won, over: finished.over }));
ok(!!finished, 'crossing the line on the last lap ends the race');
if (finished) {
  ok(finished.t > 0, 'the finish carries a race time', { t: finished.t });
  ok(finished.lap === 3, 'three laps are on the card at the flag', { lap: finished.lap });
  ok(finished.sheet === true, 'the end-of-race sheet opens', { sheet: finished.sheet });
  ok(/win the penguin circuit|finish/i.test(finished.title), 'the sheet names the result', { title: finished.title });
  await shot('supertuxkart-finish.png');
}

// ---------- 9. Race again ----------
await clickEl('overBtn', 800);
const again = await state();
ok(again.over === false && again.t < 1.2, 'Race again restarts the clock', { over: again.over, t: again.t });
ok(again.lap === -1, 'Race again puts the kart back behind the line', { lap: again.lap });
ok(again.s > again.trackLength - 16, 'Race again puts the kart back on the grid, not mid-lap', { s: again.s, L: again.trackLength });
ok(again.sheet === false, 'Race again closes the sheet');

// ---------- 10. tile art, then a portrait touch-steer pass ----------
await ev('window.__stk.setup({newRace:true, seed:778899})');
await sleep(1400);
await shot('supertuxkart.png', ART);
await shot('SuperTuxKart.png', ART);

await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }).catch(() => {});
await sleep(1400);
const pBand = await ev('window.__stk.bands()');
ok(pBand && pBand.bottom > pBand.top + 200, 'the portrait viewport still leaves a tall track band', pBand);
const preTouch = await state();
const ty = Math.round((pBand.top + pBand.bottom) / 2);
await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: ty, id: 1 }] });
const series = [];
for (let i = 0; i < 7; i++) { await sleep(100); series.push(await ev('window.__stk.touch()')); }
const touching = await state();
await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(200);
const afterTouch = await state();
T('touch ' + JSON.stringify({ lat0: preTouch.lat, lat1: touching.lat, steer: touching.steer, lat2: afterTouch.lat, ty, series }));
ok(touching.steer < 0, 'holding the left half steers left on touch', { steer: touching.steer });
ok(touching.lat < preTouch.lat, 'the touch moves the kart left', { before: preTouch.lat, after: touching.lat });
ok(Math.abs(afterTouch.steer) < 0.01, 'lifting the thumb releases the steer', { steer: afterTouch.steer });
await shot('supertuxkart-portrait.png');

// ---------- console hygiene ----------
const exceptions = pageCdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
const consoleErrors = pageCdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
ok(exceptions.length === 0, 'no uncaught exceptions during the whole gate', exceptions.slice(0, 2).map((e) => e.params.exceptionDetails?.exception?.description));
ok(consoleErrors.length === 0, 'no console errors during the whole gate', consoleErrors.slice(0, 2).map((e) => e.params.args?.map((a) => a.value).join(' ')));

proc.kill('SIGKILL');
server.close();
if (fails.length) { console.error('\nFAILED ' + fails.length + '\n' + fails.join('\n')); process.exit(1); }
console.log('\nOK — SuperTuxKart boots on the grid, throttles, steers both ways from the keyboard, drifts on a held button, boosts, spins on oil, takes a box, finishes at the flag with its sheet, restarts and steers by touch in portrait');
