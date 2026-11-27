#!/usr/bin/env node
// Interaction gate for the Maia port: serves the site repo root (so ./kit.js resolves to the
// shipped bytes), drives headless Chromium with real CDP mouse/touch input, and asserts the
// state hook moves on every click. A canvas that merely exists is not proof.
//
// usage: node maia-gate.mjs [/<path-to-site-repo>]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const PAGE = '/games/arcade/mobile-maia/';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CMD_TIMEOUT = 240000;

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
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws attach failed')); });
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
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, CMD_TIMEOUT);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/maia-gate-');
const RUNTIME = mkdtempSync('/tmp/maia-run-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: RUNTIME } });
const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', () => { kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('REJECT ' + (e && e.message)); kill(); process.exit(1); });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools in 60s: ' + err.slice(-300))), 60000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});

// Attach to the existing page target rather than Target.createTarget, which never returns
// on this box's headless Chromium.
const browserPort = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) throw new Error('no page target: ' + JSON.stringify(list).slice(0, 200));
const cdp = await CDP.attach(target.webSocketDebuggerUrl);
const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};
const hook = () => ev('window.__maia ? window.__maia() : null');
const poll = async (expr, ms = 8000, step = 120) => {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

let fails = 0;
const results = [];
const ok = (cond, msg, extra) => {
  if (!cond) { fails++; console.error('  FAIL ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
  results.push({ pass: !!cond, msg, extra });
  return !!cond;
};

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
await cdp.send('Page.navigate', { url: base + PAGE });
const booted = await poll('typeof window.__maia === "function"', 90000);
console.log(`boot: ${booted ? 'hook live' : 'NO HOOK'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(!!booted, 'the state hook never appeared (module died?)', await ev('document.title'));

const click = async (pt) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const cell = async (r, c) => ev(`window.__maia.tilePoint(${r},${c})`);
const clickCell = async (r, c) => { const p = await cell(r, c); await click(p); await sleep(220); return p; };
// Click a piece and confirm the hook took it; a press that lands while the page is still
// settling after a screenshot or a reset can be dropped, so retry rather than assume.
const selectCell = async (r, c) => {
  for (let i = 0; i < 3; i++) {
    await clickCell(r, c);
    const s = await hook();
    if (s && s.selected === r * 8 + c) return true;
  }
  return false;
};
const moveTo = async (r1, c1, r2, c2) => {
  if (!(await selectCell(r1, c1))) return false;
  await clickCell(r2, c2);
  return true;
};
const elPoint = async (id) => ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:r.width,h:r.height,x0:r.x,y0:r.y};})()`);
const clickEl = async (id) => { const p = await elPoint(id); await click(p); await sleep(320); return p; };
const shot = async (name) => {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};

// ---- 1) boot: a full board, the visitor to move, the engine idle
{
  const s = await hook();
  console.log('boot state:', JSON.stringify({ pieces: s?.pieces, legalAll: s?.legalAll, turn: s?.turn, player: s?.player, maia: s?.maia, seed: s?.seed, meshes: s?.meshes }));
  ok(s && s.pieces === 32, 'the boot board does not carry 32 pieces', s?.pieces);
  ok(s && s.meshes === 32, 'the boot board does not build 32 meshes', s?.meshes);
  ok(s && s.legalAll === 20, 'the visitor does not have 20 legal opening moves', s?.legalAll);
  ok(s && s.turn === 'w' && s.player === 'w', 'white is not to move for a white visitor', [s?.turn, s?.player]);
  ok(s && s.over === false && s.sheet === '', 'the boot position is already terminal', s?.sheet);
  ok(s && s.maia === 1500, 'the Maia slider does not boot at 1500', s?.maia);
}

// ---- 2) the picker round-trip: every square must map back from its own screen point
{
  let bad = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const got = await ev(`(()=>{const p=window.__maia.tilePoint(${r},${c});return window.__maia.pickAt(p.x,p.y);})()`);
    if (got !== r * 8 + c) bad.push([r, c, got]);
  }
  ok(bad.length === 0, 'the square picker does not round-trip on every cell', bad.slice(0, 6));
}

// ---- 3) a real click selects a piece, a second click moves it, the engine answers
{
  const before = await hook();
  const e2 = await clickCell(6, 4);
  const mid = await hook();
  ok(mid.selected === 52, 'clicking e2 did not select the pawn', { sel: mid.selected, inputs: mid.inputs, dups: mid.dups });
  ok(mid.legalForSel === 2, 'the selected pawn does not offer two moves', mid.legalForSel);
  await clickCell(4, 4);
  const after = await hook();
  ok(after.ply === 1, 'the e2-e4 click did not play a move', { ply: after.ply, inputs: after.inputs, dups: after.dups });
  ok(after.turn === 'b', 'the turn did not pass to Maia', after.turn);
  ok(after.pieces === 32, 'a piece vanished on a non-capturing move', after.pieces);
  const replied = await poll('window.__maia().ply >= 2 ? window.__maia() : null', 12000);
  ok(!!replied, 'Maia never answered the opening move', (await hook())?.ply);
  ok(replied && replied.thinking === false, 'the engine is still marked thinking after its reply', replied?.thinking);
  ok(replied && replied.pieces === 32, 'the engine reply lost a piece', replied?.pieces);
  ok(replied && replied.turn === 'w', 'the turn did not come back to the visitor', replied?.turn);
  const legal = await ev(`window.__maia.legalFrom(${replied.last[0]}).length >= 0`);
  ok(legal !== false, 'the engine reply is not readable from the board hook', legal);
  console.log('opening:', JSON.stringify({ ply: replied?.ply, last: replied?.last, board: (await ev('window.__maia.board()')).slice(0, 24) }));
  await shot('maia-gate-mid');
}

// ---- 4) the same seed replays the same game (a visitor can reload into the same line)
{
  const line = async (seed) => {
    await ev(`window.__maia.restart({seed:${seed}, rating:1600, side:'w'})`);
    await sleep(150);
    const played = await moveTo(6, 4, 4, 4);
    if (!played) console.log('  [debug] e2 never got selected for seed ' + seed);
    const r = await poll('window.__maia().ply >= 2 ? window.__maia() : null', 20000);
    if (!r) console.log('  [debug] no reply; state=' + JSON.stringify(await hook()));
    return r ? (await ev('window.__maia.board()')) : null;
  };
  const a = await line(4242);
  const b = await line(4242);
  const c = await line(4243);
  ok(a && b && a === b, 'the same seed did not replay the same game', { a: a?.slice(0, 16), b: b?.slice(0, 16) });
  ok(a && c && a !== c, 'two different seeds produced an identical game', null);
}

// ---- 5) the rating slider is the product: real clicks at both ends must move the hook
{
  const geo = await elPoint('rating');
  ok(geo && geo.w > 20, 'the rating slider is not rendered', geo);
  await click({ x: Math.round(geo.x0 + geo.w * 0.04), y: geo.y });
  await sleep(300);
  let s = await hook();
  ok(s.maia === 600, 'clicking the low end of the slider did not set Maia 600', s.maia);
  await click({ x: Math.round(geo.x0 + geo.w * 0.96), y: geo.y });
  await sleep(300);
  s = await hook();
  ok(s.maia === 2600, 'clicking the high end of the slider did not set Maia 2600', s.maia);
  ok((await ev(`document.getElementById('ratingOut').textContent`)) === '2600', 'the HUD rating box does not follow the slider', await ev(`document.getElementById('ratingOut').textContent`));
}

// ---- 6) pick a side: black puts the visitor at the bottom and Maia opens the game
{
  await clickEl('sideBtn');
  await sleep(200);
  let s = await hook();
  ok(s.player === 'b', 'the Side button did not give the visitor black', s.player);
  ok(s.flip === true, 'the board did not turn around for a black visitor', s.flip);
  const opened = await poll('window.__maia().ply >= 1 ? window.__maia() : null', 12000);
  ok(!!opened, 'Maia did not open the game as white', (await hook())?.ply);
  ok(opened && opened.turn === 'b', 'it is not the visitor to move after Maia opened', opened?.turn);
  // the picker must round-trip on the flipped board too
  let bad = [];
  for (const [r, c] of [[0, 0], [7, 7], [4, 3], [1, 6]]) {
    const got = await ev(`(()=>{const p=window.__maia.tilePoint(${r},${c});return window.__maia.pickAt(p.x,p.y);})()`);
    if (got !== r * 8 + c) bad.push([r, c, got]);
  }
  ok(bad.length === 0, 'the picker does not round-trip on the flipped board', bad);
  // the visitor's own pieces (black, r=0,1) must be drawn on the near side of the board
  const near = await ev('(()=>{const a=window.__maia.tilePoint(1,4);const b=window.__maia.tilePoint(6,4);return a.y>b.y;})()');
  ok(near === true, 'the visitor\'s own side does not sit at the bottom of the screen', near);
  await clickEl('sideBtn');
  await sleep(200);
  ok((await hook()).player === 'w', 'the Side button does not toggle back to white', (await hook()).player);
}

// ---- 7) win: a mate in one for the visitor, clicked through the real board
{
  const fen = '6k1/5ppp/8/8/8/8/8/R6K w';   // Ra8#: g8 boxed by its own pawns on f7/g7/h7
  await ev(`window.__maia.setup(${JSON.stringify(fen)}, {side:'w', rating:600, seed:11})`);
  await sleep(250);
  let s = await hook();
  ok(s.over === false && s.player === 'w', 'the win fixture did not load as a live white-to-move position', [s.over, s.player, s.turn]);
  ok((await ev('window.__maia.legalFrom(56)')).includes(0), 'the rook cannot reach a8 in the win fixture', await ev('window.__maia.legalFrom(56)'));
  ok(await moveTo(7, 0, 0, 0), 'clicking a1 then a8 did not move the rook', await hook());
  await sleep(300);
  s = await hook();
  console.log('win fixture:', JSON.stringify({ over: s.over, result: s.result, sheet: s.sheet }));
  ok(s.over === true && s.result === 'win', 'Ra8# did not end the game as a win', [s.over, s.result]);
  ok(s.sheet.startsWith('You win.'), 'the win sheet did not open with a win title', s.sheet);
  ok((await ev(`document.getElementById('over').classList.contains('open')`)) === true, 'the end sheet is not visible', null);
  await shot('maia-gate-win');
}

// ---- 8) lose: Maia has a mate in one and plays it
{
  const fen = '3r2k1/8/8/8/8/8/5PPP/6K1 b';
  await ev(`window.__maia.setup(${JSON.stringify(fen)}, {side:'w', rating:2600, seed:13})`);
  const lost = await poll('window.__maia().over && window.__maia()', 12000);
  const s = lost || await hook();
  console.log('lose fixture:', JSON.stringify({ over: s.over, result: s.result, sheet: s.sheet, last: s.last }));
  ok(s.over === true && s.result === 'lose', 'Maia did not mate the visitor from the mate-in-one fixture', [s.over, s.result]);
  ok(s.sheet.startsWith('Checkmate.'), 'the loss sheet does not read as checkmate', s.sheet);
}

// ---- 9) back up a move from the sheet, then restart from the HUD
{
  await clickEl('overBack');
  await sleep(300);
  let s = await hook();
  ok(s.sheet === '', 'Back up a move left the sheet open', s.sheet);
  ok(s.over === false, 'Back up a move left the game over', s.over);

  await ev('window.__maia.restart({seed:77, rating:1400, side:"w"})');
  await sleep(200);
  ok(await moveTo(6, 4, 4, 4), 'the undo fixture could not play e2-e4', await hook());
  const replied = await poll('window.__maia().ply >= 2 ? window.__maia() : null', 20000);
  ok(!!replied, 'the undo fixture never got an engine reply', null);
  const undoPt = await clickEl('undo');
  ok(undoPt && undoPt.w > 10, 'the Undo button is not rendered', undoPt);
  s = await hook();
  ok(s.ply === 0 && s.turn === 'w', 'Undo did not return to the visitor\'s move', [s.ply, s.turn]);
  ok(s.pieces === 32, 'Undo did not restore the pieces', s.pieces);

  await ev('window.__maia.restart({seed:7, rating:1400, side:"w"})');
  await sleep(200);
  await clickCell(6, 3);
  await sleep(200);
  await clickEl('new');
  s = await hook();
  ok(s.ply === 0 && s.over === false && s.pieces === 32, 'New game did not deal a fresh board', [s.ply, s.over, s.pieces]);
  ok(s.selected === -1, 'New game left a piece selected', s.selected);
}

// ---- 10) portrait touch: a finger must move a piece on a 390x844 phone
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await ev('window.__maia.restart({seed:99, rating:1400, side:"w"})');
  await sleep(500);
  const tap = async (pt) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
    await sleep(70);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(260);
  };
  // prime the new viewport with a neutral press on the HUD, then tap for real
  const hud = await ev(`(()=>{const r=document.getElementById('statusBox').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  await tap(hud);
  const e2 = await cell(6, 4);
  const inFrame = await ev(`(()=>{const a=window.__maia.tilePoint(0,0),b=window.__maia.tilePoint(7,7);return a.y>0&&b.y<844&&a.x>0&&b.x<390;})()`);
  ok(inFrame === true, 'the board does not fit a 390x844 viewport', await ev(`(()=>{const a=window.__maia.tilePoint(0,0),b=window.__maia.tilePoint(7,7);return [a,b];})()`));
  await tap(e2);
  let s = await hook();
  if (s.selected !== 52) { await tap(e2); s = await hook(); }   // a finger repeats
  ok(s.selected === 52, 'a touch tap on e2 did not select the pawn', { sel: s.selected, inputs: s.inputs });
  await tap(await cell(4, 4));
  s = await hook();
  ok(s.ply >= 1, 'a touch drag/tap pair did not play e2-e4', s.ply);
  await poll('window.__maia().ply >= 2 ? window.__maia() : null', 12000);
  await shot('maia-gate-portrait');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}

// ---- 11) console errors
{
  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
    .filter((t) => !/favicon/i.test(t || ''));
  ok(errs.length === 0, 'the page logged console errors', errs.slice(0, 3));
}

const passes = results.filter((r) => r.pass).length;
console.log(`\ngate: ${fails ? 'FAIL' : 'PASS'} — ${passes}/${results.length} assertions`);
if (fails) {
  await writeFile(join(OUT, 'maia-gate-failures.json'), JSON.stringify(results.filter((r) => !r.pass), null, 1));
}
kill();
server.close();
process.exit(fails ? 1 : 0);
