#!/usr/bin/env node
/**
 * Input-path check for a title driven by touch: dispatch real PointerEvents the way a
 * thumb would, and assert the simulation responds. Drives nothing through __game.act,
 * so it proves the actual listeners rather than the test surface.
 *
 *   node tests/touch-galevault.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureServer } from './lib/ensure-server.mjs';

const BASE = process.env.AOMG_URL || 'http://127.0.0.1:8787';
const PORT = 9410 + Math.floor(Math.random() * 80);
const CHROME = [process.env.CHROME, '/usr/sbin/chromium',
  ...(() => {
    const base = `${process.env.HOME}/.cache/ms-playwright`;
    try {
      return readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()
        .flatMap(d => ['chrome-linux64/chrome', 'chrome-linux/chrome'].map(s => join(base, d, s)));
    } catch { return []; }
  })()].filter(Boolean).find(p => existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = await ensureServer(BASE);
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/aomg-touch-gv-${PORT}`, '--no-sandbox', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--mute-audio', '--window-size=390,844', 'about:blank'],
  { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: '/tmp' } });

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { }
  await sleep(100);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 20000);
});
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const touch = (type, x, y, pid = 1) => send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: pid, radiusX: 12, radiusY: 12, force: 1 }]
});

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: `${BASE}/games/galevault/index.html` });
for (let i = 0; i < 150; i++) {
  if (await ev('!!(window.__game && window.__game.state)').catch(() => false)) break;
  await sleep(100);
}
await sleep(600);

const out = [];
const ok = (name, cond, detail) => { out.push({ name, ok: !!cond, detail }); };

/* Wait for the SIMULATION to advance, not the wall clock: a headless software renderer
 * runs the fixed-step loop at a few frames a second, so "sleep 2s" is worth a fraction
 * of a second of game time and any meter-rate assertion read as a failure. */
async function waitSim(seconds, timeoutMs = 20000) {
  const t0 = (await ev('window.__game.state()')).t;
  const start = Date.now();
  let now = t0;
  while (Date.now() - start < timeoutMs) {
    await sleep(120);
    now = (await ev('window.__game.state()')).t;
    if (now - t0 >= seconds) break;
  }
  return +(now - t0).toFixed(2);
}

/* 1. LAUNCH by touch: the title screen starts a run on a tap in the lower half */
let st = await ev('window.__game.state()');
ok('boots to the title screen', st.phase === 'title', `phase=${st.phase}`);
await touch('touchStart', 195, 620);
await touch('touchEnd', 195, 620);
await sleep(500);
st = await ev('window.__game.state()');
ok('tap on LAUNCH starts a run', st.phase === 'flying', `phase=${st.phase} t=${st.t}`);

/* 2. steering: a drag on the left half moves the yaw */
const before = await ev('window.__game.state()');
await touch('touchStart', 120, 500);
for (let i = 1; i <= 6; i++) { await touch('touchMove', 120 + i * 18, 500); await sleep(40); }
await sleep(350);
const afterSteer = await ev('window.__game.state()');
await touch('touchEnd', 228, 500);
ok('thumb drag on the left changes heading',
  Math.abs(afterSteer.yaw - before.yaw) > 0.05,
  `yaw ${before.yaw.toFixed(2)} → ${afterSteer.yaw.toFixed(2)}`);

/* 3. boost: holding the bottom-right button drains the meter */
await ev('window.__game.act("newGame")');   // fresh meter
await sleep(200);
const b0 = await ev('window.__game.state()');
await touch('touchStart', 330, 750, 2);
const heldSim = await waitSim(0.5);
const b1 = await ev('window.__game.state()');
await touch('touchEnd', 330, 750, 2);
/* rate, not absolute drop: a software renderer advances the fixed-step sim slowly, so
   the meters move less per wall second here than they will on a phone */
ok('holding BOOST drains the meter', b1.boosting === true && b1.boost < b0.boost - 5,
  `boosting=${b1.boosting} boost ${b0.boost} → ${b1.boost} over ${heldSim}s of sim`);

/* 4. releasing lets it recharge */
const releasedSim = await waitSim(0.5);
const b2 = await ev('window.__game.state()');
ok('releasing BOOST lets it recharge', b2.boost > b1.boost + 2,
  `boost ${b1.boost} → ${b2.boost} over ${releasedSim}s of sim`);

/* 5. the run keeps advancing with no input at all (throttle is automatic) */
const t0 = (await ev('window.__game.state()')).t;
await sleep(700);
const t1 = (await ev('window.__game.state()')).t;
ok('the clock runs without input', t1 > t0, `t ${t0} → ${t1}`);

ok('no runtime errors', errors.length === 0, errors.slice(0, 2).join(' | '));

const pass = out.filter(o => o.ok).length;
for (const o of out) console.log(`  ${o.ok ? 'PASS' : 'FAIL'}  ${o.name} — ${o.detail}`);
console.log(`\n${pass}/${out.length} touch checks passed`);
ws.close(); /* kill the whole process GROUP: SIGKILL on the parent alone leaves chromium's
   renderer and crashpad children running, and enough of them poison the next run */
try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
server.stop();
process.exit(pass === out.length ? 0 : 1);
