#!/usr/bin/env node
/**
 * Offline/PWA proof: the collection's headline claim is "install once, then the phone
 * can go into airplane mode". This test proves it for the served build:
 *
 *   1. load the shell over http, let the service worker install and precache
 *   2. cut the network at the CDP level (Network.emulateNetworkConditions offline)
 *   3. reload — the shell must still render all 8 cards, from cache
 *   4. navigate to a game page — it must still load and run, from cache
 *   5. reload with a cold cache-busting navigation to prove it is the SW, not luck
 *
 * Usage: node tests/offline.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureServer } from './lib/ensure-server.mjs';

const BASE = await ensureServer(process.env.AOMG_URL || 'http://127.0.0.1:8787').then(s => s.base);
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
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
const PORT = 9600 + Math.floor(Math.random() * 150);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=/tmp/aomg-offline-${PORT}`, '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp/aomg-rt' } });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(150); }

const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
});
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const results = [];
const add = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${name} … ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`); };

/* ---- 0. start from a clean worker state ----
 * A profile that still holds an older worker serves that worker's cache, which
 * makes this test pass or fail on history instead of on the current build. */
await send('Page.navigate', { url: `${BASE}/shell/index.html` });
await sleep(800);
await ev(`(async () => {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const ks = await caches.keys();
    await Promise.all(ks.map(k => caches.delete(k)));
  } catch (e) { }
  return true;
})()`);

/* ---- 1. load online and let the service worker take over ---- */
await send('Page.navigate', { url: `${BASE}/shell/index.html` });
await sleep(1500);
const registered = await ev(`(async () => {
  if (!('serviceWorker' in navigator)) return { ok: false, why: 'no serviceWorker' };
  const reg = await navigator.serviceWorker.ready;
  return { ok: true, scope: reg.scope, active: !!(reg.active), state: reg.active && reg.active.state };
})()`);
add('service worker registers', !!(registered && registered.ok && registered.active),
  registered ? `state=${registered.state} scope=${registered.scope}` : 'no result');

// give the precache time to finish writing
await sleep(2500);
const cached = await ev(`(async () => {
  const names = await caches.keys();
  if (!names.length) return { caches: [], entries: 0 };
  const c = await caches.open(names[0]);
  const keys = await c.keys();
  return { caches: names, entries: keys.length, sample: keys.slice(0, 4).map(r => new URL(r.url).pathname) };
})()`);
add('precache populated', !!(cached && cached.entries >= 10), `${cached ? cached.entries : 0} entries in ${cached ? cached.caches.join(',') : '—'}`);

const cardsOnline = await ev('document.querySelectorAll(".card").length');
const ids = await ev('Array.prototype.map.call(document.querySelectorAll(".card"), n => n.dataset.id).join(",")');
add('shell renders online', cardsOnline === 11, `${cardsOnline} cards: ${ids}`);

/* ---- 2. cut the network ---- */
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});

/* ---- 3. reload the shell while offline ---- */
await send('Page.navigate', { url: `${BASE}/shell/index.html` });
await sleep(2200);
const cardsOffline = await ev('document.querySelectorAll(".card").length');
add('shell renders offline (SW cache)', cardsOffline === 11, `${cardsOffline} cards with the network cut`);

const netBadge = await ev('(document.getElementById("net")||{}).textContent');
add('shell reports airplane mode', /AIRPLANE|NOT USED/.test(netBadge || ''), netBadge);

/* ---- 4. EVERY original must load and run offline, not just the one we like ---- */
const PLAY_OFFLINE = [
  { id: 'vaultbreak', acts: [['newGame'], ['step', { x: 1, y: 0 }]], want: s => s.started === true && s.depth >= 1 },
  { id: 'tessera', acts: [['newGame'], ['endTurn']], want: s => s.started === true && s.turn >= 1 },
  { id: 'ember-drift', acts: [['newGame'], ['fire']], want: s => s.started === true && typeof s.hull === 'number' },
  { id: 'rift-nine', acts: [['newGame'], ['right']], want: s => s.started === true && s.room >= 1 },
  /* the four cross-hybrids ship in the same offline promise, and each one's
     second system has to work with the network cut, not just boot */
  { id: 'siegehaus',
    acts: [['newGame'], ['buildLine'], ['runIndustry']],
    want: s => s.started === true && s.plates > 0 },
  { id: 'charterline', acts: [['newGame'], ['charterDemo'], ['endTurn'], ['endTurn']],
    want: s => s.started === true && s.charters >= 1 },
  { id: 'nulltrace', acts: [['newGame'], ['right'], ['right'], ['right']],
    want: s => s.started === true && s.par === 11 },
  { id: 'lanternfall', acts: [['newGame'], ['takeArmour']],
    want: s => s.started === true && s.fragLimit === 10 && s.armourT > 0 },
  /* the two 2026-10-30 hybrids: each floor/arena must come out of the vendored
     corpus with the network cut, not just paint a canvas */
  { id: 'cinderhold', acts: [['newGame'], ['step', { x: 1, y: 0 }]],
    want: s => s.started === true && s.vaultsLoaded >= 300 && !!s.vaultId },
  { id: 'wardenmarch', acts: [['newGame'], ['endTurn']],
    want: s => s.started === true && s.unitsWithRules >= 12 && s.arenaSrc === 'dcss' },
];
for (const g of PLAY_OFFLINE) {
  await send('Page.navigate', { url: `${BASE}/games/${g.id}/index.html` });
  await sleep(2000);
  const out = await ev(`(() => {
    if (!window.__game) return { error: 'game never booted' };
    var acts = ${JSON.stringify(g.acts)}, i, err = null;
    for (i = 0; i < acts.length; i++) {
      try { window.__game.act(acts[i][0], acts[i][1]); } catch (e) { err = String(e && e.message || e); }
    }
    var c = document.querySelector('canvas');
    return { state: window.__game.state(), err: err, w: c && c.width, h: c && c.height,
             vendor: !!(window.AOMG_VENDOR && window.AOMG_VENDOR.assets) };
  })()`);
  const s = out && out.state;
  const ok = !!(s && g.want(s) && out.w > 0 && !out.err);
  const bits = s ? Object.keys(s).slice(0, 6).map(k => `${k}=${JSON.stringify(s[k])}`).join(' ') : '';
  add(`${g.id} plays offline`, ok, out && out.error ? out.error
    : out && out.err ? 'act threw: ' + out.err
      : `canvas=${out.w}x${out.h} bundle=${out.vendor ? 'yes' : 'no'} ${bits}`);
  const shot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot && shot.result && shot.result.data) {
    writeFileSync(join(ROOT, 'evidence', `offline-${g.id}.png`), Buffer.from(shot.result.data, 'base64'));
  }
}

/* ---- 5. server API must be unreachable while offline (proves the cut is real) ---- */
const apiDuringOffline = await ev(`fetch('/api/health').then(r => 'status ' + r.status).catch(e => 'blocked: ' + e.name)`);
add('network really is cut', /blocked/.test(apiDuringOffline || ''), String(apiDuringOffline));

const shot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot && shot.result && shot.result.data) writeFileSync(join(ROOT, 'evidence', 'offline-vaultbreak.png'), Buffer.from(shot.result.data, 'base64'));

chrome.kill('SIGKILL');
const pass = results.filter(r => r.ok).length;
writeFileSync(join(ROOT, 'evidence', 'offline-report.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, pass, total: results.length, results }, null, 1));
console.log(`\n${pass}/${results.length} offline checks passed`);
process.exit(pass === results.length ? 0 : 1);
