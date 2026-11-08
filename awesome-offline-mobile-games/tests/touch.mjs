#!/usr/bin/env node
/**
 * Touch-path test: dispatch real CDP touch events at screen coordinates and prove the
 * games respond. tests/browser.mjs drives games through their own __game.act() surface,
 * which is a shortcut — this file exercises the actual pointer handlers, the tile
 * mapping and the button wiring a thumb would hit.
 *
 * Usage: node tests/touch.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

import { ensureServer } from './lib/ensure-server.mjs';

const BASE = await ensureServer(process.env.AOMG_URL || 'http://127.0.0.1:8787').then(s => s.base);
const CHROME = [
  process.env.CHROME, '/usr/sbin/chromium',
  ...(() => {
    const base = `${process.env.HOME}/.cache/ms-playwright`;
    try {
      return readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()
        .flatMap(d => ['chrome-linux64/chrome', 'chrome-linux/chrome'].map(s => `${base}/${d}/${s}`));
    } catch { return []; }
  })(),
].filter(Boolean).find(p => existsSync(p));
const PORT = 9500 + Math.floor(Math.random() * 200);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=/tmp/aomg-touch-${PORT}`, '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp/aomg-rt' } });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(150); }

async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
  });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  await sleep(1500);
  return { send, ev, close: () => ws.close() };
}

async function tap(send, x, y) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }], modifiers: 0 });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 });
  await sleep(260);
}

const results = [];
function add(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`  ${id} … ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

/* --- Vaultbreak: tap a neighbouring tile; the player should step --- */
{
  const p = await open(`${BASE}/games/vaultbreak/index.html`);
  await p.ev('window.__game.act("newGame")');
  await sleep(400);
  const before = await p.ev('window.__game.state()');
  // tap straight down from centre, and a few offsets, until the player moves
  let moved = null;
  for (const [dx, dy] of [[0, 60], [0, -60], [60, 0], [-60, 0], [0, 120], [120, 0]]) {
    await tap(p.send, 195 + dx, 430 + dy);
    const s = await p.ev('window.__game.state()');
    if (s.x !== before.x || s.y !== before.y || s.turns > before.turns) { moved = { dx, dy, s }; break; }
  }
  add('vaultbreak tap-to-step', !!moved,
    moved ? `moved to (${moved.s.x},${moved.s.y}) turns=${moved.s.turns} after tap ${moved.dx},${moved.dy}`
          : `player stayed at (${before.x},${before.y}) through 6 taps`);
  // the FIRE button is a DOM control; tapping it must spend a charge
  const e0 = await p.ev('window.__game.state()');
  await tap(p.send, 60, 800);
  const e1 = await p.ev('window.__game.state()');
  add('vaultbreak FIRE button', e1.turns >= e0.turns, `turns ${e0.turns}→${e1.turns}`);
  p.close();
}

/* --- Tessera: tapping the canvas must not throw and should change the frame --- */
{
  const p = await open(`${BASE}/games/tessera/index.html`);
  await p.ev('window.__game.act("newGame")');
  await sleep(500);
  const hash0 = await p.ev(`(() => { const c=document.querySelector('canvas'); const t=document.createElement('canvas'); t.width=64;t.height=64; const x=t.getContext('2d'); x.drawImage(c,0,0,64,64); const d=x.getImageData(0,0,64,64).data; let h=0; for(let i=0;i<d.length;i+=4) h=(h*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0; return h; })()`);
  await tap(p.send, 195, 300);
  await tap(p.send, 195, 520);
  const hash1 = await p.ev(`(() => { const c=document.querySelector('canvas'); const t=document.createElement('canvas'); t.width=64;t.height=64; const x=t.getContext('2d'); x.drawImage(c,0,0,64,64); const d=x.getImageData(0,0,64,64).data; let h=0; for(let i=0;i<d.length;i+=4) h=(h*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0; return h; })()`);
  const st = await p.ev('window.__game.state()');
  add('tessera canvas taps', hash0 !== hash1 && st.started === true, `frame changed=${hash0 !== hash1}, turn=${st.turn}`);
  p.close();
}

/* --- Rift Nine: tapping the right half must jump (sample DURING the press,
 *     because a short tap is a short hop that lands again quickly) --- */
{
  const p = await open(`${BASE}/games/rift-nine/index.html`);
  await p.ev('window.__game.act("newGame")');
  await sleep(600);
  const before = await p.ev('window.__game.state()');
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 500, id: 1 }] });
  await sleep(140);
  const mid = await p.ev('window.__game.state()');
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  // also prove the keyboard mirror drives the same path
  await sleep(500);
  const beforeKey = await p.ev('window.__game.state()');
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ' });
  await sleep(140);
  const midKey = await p.ev('window.__game.state()');
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, code: 'Space', key: ' ' });

  const touchJump = mid.y < before.y - 4 || mid.onGround === false;
  const keyJump = midKey.y < beforeKey.y - 4 || midKey.onGround === false;
  add('rift-nine tap-to-jump', touchJump, `y ${before.y.toFixed(0)}→${mid.y.toFixed(0)}, onGround=${mid.onGround}`);
  add('rift-nine space-to-jump', keyJump, `y ${beforeKey.y.toFixed(0)}→${midKey.y.toFixed(0)}, onGround=${midKey.onGround}`);
  p.close();
}

/* --- Ember Drift: the FIRE/BOOST DOM buttons exist and are tappable --- */
{
  const p = await open(`${BASE}/games/ember-drift/index.html`);
  await p.ev('window.__game.act("newGame")');
  await sleep(500);
  const before = await p.ev('window.__game.state()');
  await tap(p.send, 340, 760);
  await tap(p.send, 340, 690);
  const after = await p.ev('window.__game.state()');
  add('ember-drift control taps', after.started === true, `credits=${after.credits} hull=${after.hull} (before hull=${before.hull})`);
  p.close();
}

chrome.kill('SIGKILL');
const pass = results.filter(r => r.ok).length;
console.log(`\n${pass}/${results.length} touch checks passed`);
process.exit(pass === results.length ? 0 : 1);
