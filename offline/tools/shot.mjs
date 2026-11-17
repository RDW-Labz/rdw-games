#!/usr/bin/env node
/**
 * tools/shot.mjs — visual QA: drive one game, screenshot it, keep the pixels.
 *
 * tests/browser.mjs answers "does every title still boot and paint". It does not
 * answer "does it look good", because it throws its frames away and only reports
 * colour counts. Judging art needs the frame itself.
 *
 *   node tools/shot.mjs cinderhold --acts 'newGame,hunt,hunt,attack' \
 *        --out evidence/qa-cinderhold.png
 *
 * Options
 *   --acts a,b,{json}   actions run through window.__game.act (default: newGame)
 *   --out <path>        PNG path (default evidence/qa-<game>.png)
 *   --w/--h             viewport in CSS px (default 390x844, a phone in portrait)
 *   --dpr               device pixel ratio (default 2)
 *   --wait ms           settle time before the shot (default 1400)
 *   --url <base>        library base (default http://127.0.0.1:8787)
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureServer } from '../tests/lib/ensure-server.mjs';

const argv = process.argv.slice(2);
const game = argv[0];
if (!game || game.startsWith('--')) {
  console.error('usage: node tools/shot.mjs <game> [--acts ...] [--out ...]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = opt('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const W = parseInt(opt('w', '390'), 10);
const H = parseInt(opt('h', '844'), 10);
const DPR = parseFloat(opt('dpr', '2'));
const WAIT = parseInt(opt('wait', '1400'), 10);
const OUT = opt('out', `evidence/qa-${game}.png`);
/* split on TOP-LEVEL commas only: an act argument is JSON and contains commas of
 * its own, which the old split(',') cut in half and crashed on */
const splitTop = s => {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
};
const ACTS = splitTop(opt('acts', 'newGame')).map(s => {
  if (!s.startsWith('{')) return [s];
  const o = JSON.parse(s);
  return [o.act, o.arg];
});

const CHROME = [process.env.CHROME, '/usr/sbin/chromium', '/usr/sbin/brave',
  ...(() => {
    const base = `${process.env.HOME}/.cache/ms-playwright`;
    try {
      return readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()
        .flatMap(d => ['chrome-linux64/chrome', 'chrome-linux/chrome'].map(s => join(base, d, s)));
    } catch { return []; }
  })()].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('no chromium found; set CHROME=/path/to/chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = await ensureServer(BASE);
const PORT = 9500 + Math.floor(Math.random() * 300);
const PROFILE = `/tmp/aomg-shot-${PORT}`;

const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: '/tmp' } });

async function targetUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { }
    await sleep(100);
  }
  throw new Error('chromium never opened a debugging target');
}

const wsUrl = await targetUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 20000);
});
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: `${BASE}/games/${game}/` });
for (let i = 0; i < 100; i++) {
  if (await evaluate('!!window.__game').catch(() => false)) break;
  await sleep(100);
}

for (const [act, arg] of ACTS) {
  try {
    await evaluate(`(function(){var g=window.__game; if(!g||!g.act) return 'no-act'; return String(g.act(${JSON.stringify(act)}${arg ? ',' + JSON.stringify(arg) : ''}));})()`);
  } catch (e) { console.error(`${game}: act ${act} failed: ${e.message}`); }
  await sleep(90);
}
await sleep(WAIT);

/* --composite: for a two-canvas title (#game WebGL under a transparent #hud) some
 * headless builds hand back a black page screenshot — the accelerated layer never
 * reaches the compositor — while the drawing buffers are perfectly good. Compositing
 * them inside the page gets the real frame instead. Also forces one HUD repaint so
 * the shot matches the state the acts left behind. */
if (argv.includes('--composite')) {
  const dataUrl = await evaluate(`(() => {
    try { if (window.__game.act) window.__game.act('redraw'); } catch (e) { }
    const gl = document.querySelector('#game'), hd = document.querySelector('#hud');
    if (!gl || !hd) return '';
    const out = document.createElement('canvas');
    out.width = gl.width; out.height = gl.height;
    const c = out.getContext('2d');
    c.drawImage(gl, 0, 0, out.width, out.height);
    c.drawImage(hd, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  })()`);
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    console.error('composite capture failed; falling back to the page screenshot');
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
}
if (!argv.includes('--composite') || !existsSync(OUT)) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
}
const probe = opt('eval', '');
if (probe) {
  try { console.log('eval:', await evaluate(probe)); }
  catch (e) { console.log('eval failed:', e.message); }
}
const st = await evaluate('(() => { try { return JSON.stringify(window.__game.state()) } catch(e){ return "{}" } })()');
console.log(`${OUT}  ${W}x${H}@${DPR}x  state=${st.slice(0, 240)}`);

ws.close();
/* kill the whole process GROUP: SIGKILL on the parent alone leaves chromium's
   renderer and crashpad children running, and enough of them poison the next run */
try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
server.stop();
process.exit(0);
