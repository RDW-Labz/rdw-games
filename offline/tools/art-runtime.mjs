#!/usr/bin/env node
/**
 * tools/art-runtime.mjs — what a title actually draws, measured at runtime.
 *
 * The static audit (tools/art-audit.py) only sees literal 'vendor/...' strings in
 * source, so it reports "draws nothing" for a title that resolves its sprites through
 * vendor *data* (VDATA['endless-sky/ships'][i].image + new Image()). That false
 * negative has already caused one wrong rebuild brief. This tool measures the claim
 * where it is true or false: in the browser.
 *
 *   injected before any page script:
 *     - every HTMLImageElement whose src is under /vendor/ is counted (loaded / failed)
 *     - every canvas 2D drawImage / createPattern and WebGL texImage2D that consumes
 *       one of those images is counted, per asset
 *   then the title is played with its real action script (tests/lib/acts.mjs) and the
 *   counters are read back.
 *
 *   node tools/art-runtime.mjs                 # every title, table + evidence/art-runtime.json
 *   node tools/art-runtime.mjs lanternfall ... # just these
 *   node tools/art-runtime.mjs --no-shot       # skip the PNG per title
 *
 * A title with donorBlits === 0 is drawing donor art nowhere, whatever its catalog
 * copy says. A title with donorLoaded > 0 and donorBlits === 0 is worse: it downloads
 * the art and paints something else.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureServer } from '../tests/lib/ensure-server.mjs';
import { ACTS } from '../tests/lib/acts.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const NO_SHOT = argv.includes('--no-shot');
const BASE = opt('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const W = parseInt(opt('w', '390'), 10);
const H = parseInt(opt('h', '844'), 10);
const DPR = parseFloat(opt('dpr', '2'));
const WAIT = parseInt(opt('wait', '1600'), 10);
const GAMES = argv.filter(a => !a.startsWith('--') && /^[a-z0-9-]+$/.test(a));
const TITLES = GAMES.length ? GAMES : (process.env.AOMG_GAMES ||
  'vaultbreak,tessera,ember-drift,rift-nine,siegehaus,charterline,nulltrace,lanternfall,cinderhold,wardenmarch,stormforge'
).split(',').map(s => s.trim()).filter(Boolean);

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

/* Instrumentation, installed before the game's first byte of script. It only wraps
   prototypes, so a game that fails to load still reports zeroes instead of throwing. */
const HOOK = `(function () {
  var S = window.__artStat = { loaded: {}, failed: {}, blits: {}, paints: 0, patterns: 0 };
  function donor(u) { return typeof u === 'string' && u.indexOf('/vendor/') >= 0; }
  function base(u) { var p = String(u).split('?')[0].split('/'); return p.slice(-2).join('/'); }
  // 1. image loads under /vendor/
  var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (desc && desc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set: function (v) {
        var self = this;
        if (donor(v)) {
          var k = base(v);
          if (!self.__donorHooked) {
            self.__donorHooked = true;
            self.addEventListener('load', function () { S.loaded[k] = (S.loaded[k] || 0) + 1; });
            self.addEventListener('error', function () { S.failed[k] = (S.failed[k] || 0) + 1; });
          }
        }
        return desc.set.call(self, v);
      }
    });
  }
  // 2. canvas 2D: drawImage / createPattern with a donor image
  function tally(img) {
    if (!img || typeof img !== 'object') return false;
    var u = img.currentSrc || img.src || '';
    if (!donor(u)) return false;
    var k = base(u);
    S.blits[k] = (S.blits[k] || 0) + 1;
    return true;
  }
  var C2 = window.CanvasRenderingContext2D;
  if (C2 && C2.prototype.drawImage) {
    var di = C2.prototype.drawImage;
    C2.prototype.drawImage = function (img) {
      S.paints++;
      tally(img);
      return di.apply(this, arguments);
    };
  }
  if (C2 && C2.prototype.createPattern) {
    var cp = C2.prototype.createPattern;
    C2.prototype.createPattern = function (img) {
      if (tally(img)) S.patterns++;
      return cp.apply(this, arguments);
    };
  }
  // 3. WebGL: texImage2D from a donor image (the three.js titles)
  ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach(function (name) {
    var G = window[name];
    if (!G || !G.prototype.texImage2D) return;
    var ti = G.prototype.texImage2D;
    G.prototype.texImage2D = function () {
      for (var i = 0; i < arguments.length; i++) if (tally(arguments[i])) break;
      return ti.apply(this, arguments);
    };
  });
})();`;

const server = await ensureServer(BASE);
const PORT = 9800 + Math.floor(Math.random() * 150);
const PROFILE = `/tmp/aomg-art-${PORT}`;
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: '/tmp' } });

let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { }
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) { console.error('chromium never opened a debugging target'); process.exit(2); }

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

const rows = [];
for (const game of TITLES) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await send('Page.navigate', { url: `${BASE}/games/${game}/` });
  let booted = false;
  for (let i = 0; i < 120; i++) {
    if (await evaluate('!!window.__game').catch(() => false)) { booted = true; break; }
    await sleep(100);
  }
  const acts = ACTS[game] || [['newGame']];
  for (const [act, arg] of acts) {
    try {
      await evaluate(`(function(){var g=window.__game; if(!g||!g.act) return 'no-act'; return String(g.act(${JSON.stringify(act)}${arg ? ',' + JSON.stringify(arg) : ''}));})()`);
    } catch (e) { /* an act that throws is browser.mjs's problem, not this tool's */ }
    await sleep(110);
  }
  await sleep(WAIT);

  const stat = booted ? await evaluate('(() => { const s = window.__artStat || {}; return JSON.stringify({ loaded: s.loaded||{}, failed: s.failed||{}, blits: s.blits||{}, paints: s.paints||0, patterns: s.patterns||0 }); })()') : '{}';
  const state = booted ? await evaluate('(() => { try { return JSON.stringify(window.__game.state()) } catch (e) { return "{}" } })()') : '{}';
  let shotPath = null;
  if (!NO_SHOT && booted) {
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    shotPath = `evidence/art-${game}.png`;
    mkdirSync(dirname(shotPath), { recursive: true });
    writeFileSync(shotPath, Buffer.from(png.data, 'base64'));
  }
  const s = JSON.parse(stat);
  const blits = Object.values(s.blits).reduce((a, b) => a + b, 0);
  const loaded = Object.values(s.loaded).reduce((a, b) => a + b, 0);
  const failed = Object.values(s.failed).reduce((a, b) => a + b, 0);
  const top = Object.entries(s.blits).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `${k.split('/').pop()}x${v}`).join(' ');
  rows.push({
    game, booted, donorImagesLoaded: loaded, donorImagesFailed: failed,
    donorBlits: blits, paints: s.paints, patterns: s.patterns,
    distinctAssets: Object.keys(s.blits).length, topBlits: top,
    failedAssets: Object.keys(s.failed), shot: shotPath, state: JSON.parse(state),
  });
  console.log(`${game.padEnd(13)} blits=${String(blits).padStart(4)} imgs=${String(loaded).padStart(3)}` +
    ` fail=${String(failed).padStart(2)} paints=${String(s.paints).padStart(5)} ${top}`);
}

mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/art-runtime.json', JSON.stringify(rows, null, 1) + '\n');

const silent = rows.filter(r => r.donorBlits === 0);
console.log(`\n${rows.length - silent.length}/${rows.length} titles painted donor art this run.`);
if (silent.length) console.log('painted none:', silent.map(r => r.game).join(', '));

ws.close();
/* kill the whole process GROUP: SIGKILL on the parent alone leaves chromium's
   renderer and crashpad children running, and enough of them poison the next run */
try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
server.stop();
process.exit(silent.length ? 1 : 0);
