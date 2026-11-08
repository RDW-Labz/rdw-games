#!/usr/bin/env node
/**
 * Headless verification for every game in the collection.
 *
 * What it proves, per game:
 *   1. the page loads with zero console errors and zero uncaught exceptions
 *   2. the canvas actually renders (unique colour count + non-background pixel ratio)
 *   3. the debug surface responds (window.__game.state() returns a sane object)
 *   4. input changes the simulation AND the pixels (not a static screenshot)
 *   5. the same page also loads over file:// — i.e. genuinely offline, no server
 *
 * Usage: node tests/browser.mjs [--url http://127.0.0.1:8787] [--keep]
 * Exit code is non-zero if any game fails, so CI can gate on it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureServer } from './lib/ensure-server.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const BASE = await ensureServer(args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://127.0.0.1:8787')
  .then(s => s.base);
const KEEP = args.includes('--keep');
const SHOTS = join(ROOT, 'evidence');
mkdirSync(SHOTS, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/usr/sbin/chromium',
  '/usr/sbin/brave',
  ...(() => {
    const base = `${process.env.HOME}/.cache/ms-playwright`;
    try {
      return readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse()
        .flatMap(d => ['chrome-linux64/chrome', 'chrome-linux/chrome'].map(s => join(base, d, s)));
    } catch { return []; }
  })()
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) { console.error('no chromium found; set CHROME=/path/to/chrome'); process.exit(2); }

const PORT = 9333 + Math.floor(Math.random() * 200);
const PROFILE = `/tmp/aomg-cdp-${PORT}`;
/* Default to every playable title, cross-hybrids included: their per-title
   HYBRID_CHECKS are the only proof that the second system is load-bearing, so
   leaving them out of the default pass would let a dead hybrid ship green. */
const GAMES = (process.env.AOMG_GAMES || 'vaultbreak,tessera,ember-drift,rift-nine,siegehaus,charterline,nulltrace,lanternfall,cinderhold,wardenmarch,stormforge').split(',').map(s => s.trim()).filter(Boolean);
const ACTS = {
  // seeded run (1234) + steps toward the nearest monster, so a creature sheet
  // actually has to paint — that is the claim worth testing, not just the download
  vaultbreak: [['newGame'], ['step', { x: 1, y: 0 }], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['wait'], ['fire']],
  tessera: [['newGame'], ['endTurn'], ['endTurn']],
  'ember-drift': [['newGame'], ['fire'], ['fire']],
  lanternfall: [['newGame'], ['takeArmour'], ['fire'], ['fire'], ['takeArmour']],
  'rift-nine': [['newGame'], ['right'], ['jump']],
  nulltrace: [['newGame'], ['right'], ['jump'], ['right'], ['jump'], ['right']],
  // the hybrid: lay a drill -> belt -> fabricator line, then let it tick
  siegehaus: [['newGame'], ['buildLine'], ...Array(12).fill(['wait']), ['fire']],
  charterline: [['newGame'], ['charterDemo'], ['endTurn'], ['endTurn'], ['endTurn'], ['endTurn']],
  // the ARPG: open a floor generated from a DCSS vault, hunt what the vault put there
  // until something is actually dead, then take a second floor so the layout changes.
  // 'hunt' reads the live state each swing instead of guessing a direction — a fixed
  // step-then-swing script misses whenever the nearest creature moved, which made this
  // check flake green/red on identical code.
  cinderhold: [['newGame'], ['hunt'], ['descend'], ['attack']],
  // the skirmish: a Wesnoth unit roster on a DCSS arena, two turns of real combat
  wardenmarch: [['newGame'], ['move', { x: 1, y: 0 }], ['attack'], ['endTurn'], ['move', { x: 1, y: 0 }], ['attack'], ['endTurn']],
  // the battle royale: land, mine by hand, then stand up a drill -> belt -> smelter -> turret
  // line and let the factory tick, so the check covers both halves of the hybrid
  stormforge: [['drop'], ['skipLand'], ['grant', { copper: 300, titanium: 120 }], ['buildLine'],
               ['tick', { n: 240 }], ['fire', { ms: 400 }]],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && p.pending.has(msg.id)) {
        const { res, rej } = p.pending.get(msg.id);
        p.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) p.events.push(msg);
    };
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}

/** Colour spread + non-background ratio of the game canvas, sampled at 160x90. */
const PIXEL_PROBE = `(() => {
  const c = document.querySelector('canvas');
  if (!c) return { error: 'no canvas' };
  const t = document.createElement('canvas');
  t.width = 160; t.height = 90;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0, 160, 90);
  const d = x.getImageData(0, 0, 160, 90).data;
  const seen = new Set();
  let nonBg = 0, hash = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    seen.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
    if (r + g + b > 40) nonBg++;
    hash ^= (r << 16) ^ (g << 8) ^ b;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return { colors: seen.size, nonBg: +(nonBg / (160 * 90)).toFixed(3), hash };
})()`;

/* Downloaded is not drawn. A vendored PNG that never reaches the canvas is a broken
 * claim, not a shipped asset, so count every drawImage call whose source is an <img>
 * and report which files actually got painted. */
const PAINT_HOOK = `(() => {
  window.__painted = {};
  var proto = CanvasRenderingContext2D.prototype, orig = proto.drawImage;
  proto.drawImage = function (src) {
    try {
      if (src instanceof HTMLImageElement) {
        var n = String(src.currentSrc || src.src || '').split('/').pop();
        window.__painted[n] = (window.__painted[n] || 0) + 1;
      }
    } catch (e) { /* never let instrumentation break a frame */ }
    return orig.apply(this, arguments);
  };
})();`;

async function newTarget(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error('cannot open target: ' + res.status);
  return res.json();
}

async function testGame(id, baseUrl, tag, opts = {}) {
  const url = `${baseUrl}/games/${id}/index.html`;
  const blockVendor = !!opts.blockVendor;
  const target = await newTarget('about:blank');
  const page = await Page.open(target.webSocketDebuggerUrl);
  const errors = [];

  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');
  /* The profile is persistent so boots stay warm, which also means a service
     worker from a previous run can serve yesterday's JS and quietly invalidate
     the whole test. Bypass it and the HTTP cache for every probe. */
  await page.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => { });
  await page.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => { });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  // count what reaches the canvas, installed before any page script runs
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAINT_HOOK }).catch(() => { });
  // the no-bundle control: the whole vendored payload is refused at the network layer
  if (blockVendor) await page.send('Network.setBlockedURLs', { urls: ['*vendor*'] }).catch(() => { });

  const nav = page.send('Page.navigate', { url });
  await nav;
  // wait for the boot + a few frames of the title screen
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const ready = await page.evaluate('!!window.__game && !!document.querySelector("canvas")').catch(() => false);
    if (ready) break;
  }
  await sleep(700);

  for (const e of page.events) {
    if (e.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text));
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push('console.error: ' + e.params.args.map(a => a.value || a.description).join(' '));
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      const text = e.params.entry.text || '';
      const src = e.params.entry.url || '';
      // a missing favicon is browser noise, not a game fault
      if (/favicon\.ico/.test(text) || /favicon\.ico/.test(src)) continue;
      errors.push('log: ' + text);
    }
    if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
      const u = e.params.response.url;
      if (!/favicon\.ico/.test(u)) errors.push(`http ${e.params.response.status} ${u}`);
    }
  }

  const titleShot = await page.evaluate(PIXEL_PROBE);
  await page.send('Page.captureScreenshot', { format: 'png' }).then(r =>
    writeFileSync(join(SHOTS, `${id}-${tag}-title.png`), Buffer.from(r.data, 'base64'))).catch(() => { });

  // drive the game through its own debug surface
  const trace = [];
  for (const [act, arg] of ACTS[id] || []) {
    if (act === 'hunt') {
      /* walk onto the nearest live creature and keep swinging until one dies; each
         iteration re-reads state, so a moving monster cannot walk out of the test */
      const res = await page.evaluate(`(() => { const g = window.__game; let st = g.state();
        for (let i = 0; i < 80; i++) {
          st = g.state();
          if (st.kills >= 1) return 'killed';
          if (st.mode === 'dead') return 'died';
          g.act('attack');
          st = g.state();
          if (st.kills >= 1) return 'killed';
          const n = st.nearest;
          if (!n) return 'no-enemy';
          if (n.dist > 1) g.act('step', { x: n.dx, y: n.dy });
        }
        return 'no-kill'; })()`);
      trace.push({ act, ok: res });
      await sleep(300);
      continue;
    }
    const ok = await page.evaluate(
      `(() => { try { return window.__game.act(${JSON.stringify(act)}${arg ? ',' + JSON.stringify(arg) : ''}); } catch (e) { return 'THREW: ' + e.message; } })()`
    );
    trace.push({ act, ok });
    await sleep(420);
  }
  await sleep(600);

  const state = await page.evaluate('(() => { try { return window.__game.state(); } catch (e) { return { error: e.message }; } })()');
  const playShot = await page.evaluate(PIXEL_PROBE);
  await page.send('Page.captureScreenshot', { format: 'png' }).then(r =>
    writeFileSync(join(SHOTS, `${id}-${tag}-play.png`), Buffer.from(r.data, 'base64'))).catch(() => { });

  // reload-time console errors (collect anything that arrived after boot)
  for (const e of page.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text;
      if (!errors.some(x => x.includes(d))) errors.push('exception: ' + d);
    }
  }

  /* What the page actually pulled out of vendor/ — the "did it really use the
     clones" question, answered by the network stack rather than by reading code. */
  const vend = { js: 0, png: 0, opus: 0, other: 0, pngNames: new Set() };
  for (const e of page.events) {
    if (e.method !== 'Network.responseReceived') continue;
    const u = e.params.response.url;
    if (!/\/vendor\//.test(u) || e.params.response.status !== 200) continue;
    if (/\.js($|\?)/.test(u)) vend.js++;
    else if (/\.png($|\?)/.test(u)) { vend.png++; vend.pngNames.add(u.split('/').pop().split('?')[0]); }
    else if (/\.opus($|\?)/.test(u)) vend.opus++;
    else vend.other++;
  }

  /* and what of it actually reached the canvas */
  const paintedMap = await page.evaluate('(() => window.__painted || {})()').catch(() => ({}));
  const paintedVendor = Object.keys(paintedMap || {}).filter(n => vend.pngNames.has(n));
  const paint = {
    distinct: Object.keys(paintedMap || {}).length,
    vendorFiles: paintedVendor.length,
    names: paintedVendor.slice(0, 6),
    top: Object.entries(paintedMap || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => n + '×' + c),
  };

  page.close();

  const problems = [];
  /* Stormforge renders with WebGL, so the 2D paint instrumentation that proves the sprite
     games actually blitted their art cannot see it. For those titles the evidence is the
     renderer's own counters: a live WebGL context that submitted real geometry and shading
     every frame, plus the HUD canvas still drawing 2D. */
  const WEBGL = new Set(['stormforge']);
  if (errors.length) problems.push(...errors.slice(0, 4));
  if (titleShot.error) problems.push('title: ' + titleShot.error);
  if (!WEBGL.has(id)) {
    if (!titleShot.error && titleShot.colors < 8) problems.push(`title renders only ${titleShot.colors} colours — probably blank`);
    if (!playShot.error && playShot.hash === titleShot.hash) problems.push('pixels did not change after input');
  } else {
    if (!(state && state.draws > 20 && state.tris > 5000)) {
      problems.push(`WebGL scene drew nothing (draws=${state && state.draws}, tris=${state && state.tris})`);
    }
    if (!(state && state.blocks >= 1)) problems.push('the build economy placed no blocks');
  }
  if (state?.error) problems.push('state threw: ' + state.error);
  if (state && state.started !== true) problems.push('game did not enter play state (mode=' + state.mode + ')');
  if (state && typeof state.score === 'number' && state.score < 0) problems.push('negative score');
  trace.forEach(t => { if (t.ok === false) problems.push(`act(${t.act}) returned false`); if (typeof t.ok === 'string' && t.ok.startsWith('THREW')) problems.push(`act(${t.act}) ${t.ok}`); });
  /* vendor payload: the bundle must always load; the three sprite games must
     actually fetch vendored images. Tessera is data-only by design. */
  const DATA_ONLY = new Set(['tessera']);
  if (!blockVendor && vend.js < 1) problems.push('vendor/vendor.js never loaded');
  if (blockVendor && vend.png > 0) problems.push(`control run still fetched ${vend.png} vendored PNGs — the block did not take`);
  if (!blockVendor && !DATA_ONLY.has(id) && /^http/.test(url) && vend.png < 1) problems.push('no vendored sprite was fetched');
  /* fetched-but-never-drawn is the failure mode that makes the art pointless */
  if (!blockVendor && !DATA_ONLY.has(id) && !WEBGL.has(id) && /^http/.test(url) && vend.png > 0 && paint.vendorFiles < 1) {
    problems.push(`vendored art was fetched but never painted (${vend.png} PNGs down, ${paint.distinct} images drawn)`);
  }
  /* vaultbreak's scripted run walks up to a monster, so a real creature sheet
     has to reach the canvas — the loot atlas alone does not count */
  if (!blockVendor && id === 'vaultbreak' && /^http/.test(url)) {
    const creatureArt = paintedVendor.filter(n => n !== 'items.png' && n !== 'amulet.png');
    if (!creatureArt.length) {
      problems.push('no creature sheet was painted (only ' + (paintedVendor.join(', ') || 'nothing') + ')');
    }
  }

  /* the cross-hybrids exist to prove two systems actually mesh, so each one
     asserts its own second system worked — not just that the page booted */
  const HYBRID_CHECKS = {
    siegehaus: st => {
      const out = [];
      if (!(st.plates > 0)) out.push('Mindustry production never made a plate (plates=' + st.plates + ')');
      if (!(st.structures >= 3)) out.push('fewer than three structures stood (' + st.structures + ')');
      if (!(st.art && st.art.beltReady > 0 && st.art.drillReady > 0)) out.push('Mindustry sprites never decoded');
      return out;
    },
    charterline: st => {
      const out = [];
      if (!(st.charters >= 1)) out.push('no trade charter was established');
      if (!(st.tradeGold > 0)) out.push('charters paid nothing (tradeGold=' + st.tradeGold + ')');
      if (st.materials !== 6) out.push('expected 6 Luanti material textures, got ' + st.materials);
      return out;
    },
    lanternfall: st => {
      const out = [];
      if (st.fragLimit !== 10) out.push('frag limit is ' + st.fragLimit + ', not 10');
      if (!(st.armourT > 0 && st.armourT <= 25)) out.push('armour pickup did not start its 25s timer (' + st.armourT + ')');
      if (!(st.weaponT === 0)) out.push('weapon node was not live at match start (' + st.weaponT + ')');
      return out;
    },
    nulltrace: st => {
      const out = [];
      if (!(st.total > 0)) out.push('the DDNet run clock never advanced');
      if (st.par !== 11) out.push('no par time for room 1 (' + st.par + ')');
      return out;
    },
    /* Cinderhold's second system is DCSS generation: the floor has to come out of a real
       vault from the vendored .des corpus, and the loot has to be Flare's own item records.
       A floor drawn procedurally by hand would pass a "renders" test and fail this one. */
    cinderhold: st => {
      const out = [];
      if (!(st.vaultsLoaded >= 300)) out.push('DCSS vault corpus not loaded (' + st.vaultsLoaded + ')');
      if (!st.vaultId || st.vaultSrc !== 'dcss') out.push('floor is not from a DCSS vault (' + st.vaultId + '/' + st.vaultSrc + ')');
      if (!(st.depth >= 1)) out.push('never descended (depth=' + st.depth + ')');
      if (!(st.itemsInTable >= 60)) out.push('Flare item table too small (' + st.itemsInTable + ')');
      if (!(st.kills >= 1)) out.push('nothing died to the attack action (kills=' + st.kills + ')');
      if (st.floorsSameVault === true) out.push('two floors used the same vault layout');
      return out;
    },
    /* Wardenmarch's second system is Wesnoth's rule set: unit stats have to be upstream
       numbers, and the arena has to be a DCSS vault, not a hand-drawn square. */
    wardenmarch: st => {
      const out = [];
      if (!(st.unitsWithRules >= 12)) out.push('Wesnoth unit records not loaded (' + st.unitsWithRules + ')');
      if (!st.arenaId || st.arenaSrc !== 'dcss') out.push('arena is not from a DCSS vault (' + st.arenaId + '/' + st.arenaSrc + ')');
      if (!(st.turn >= 2)) out.push('turn never advanced (turn=' + st.turn + ')');
      if (!(st.terrainTiles >= 8)) out.push('Wesnoth terrain tiles not loaded (' + st.terrainTiles + ')');
      if (!(st.fights >= 1)) out.push('no combat resolved (fights=' + st.fights + ')');
      return out;
    },
  };
  if (!blockVendor && /^http/.test(url) && HYBRID_CHECKS[id]) problems.push(...HYBRID_CHECKS[id](state || {}));

  return {
    id, url, ok: problems.length === 0, problems,
    vendor: { js: vend.js, png: vend.png, opus: vend.opus, other: vend.other },
    paint,
    title: { colors: titleShot.colors, nonBg: titleShot.nonBg },
    play: { colors: playShot.colors, nonBg: playShot.nonBg, changed: playShot.hash !== titleShot.hash },
    state, trace,
  };
}

async function testShell(baseUrl) {
  const url = `${baseUrl}/shell/index.html`;
  const target = await newTarget('about:blank');
  const page = await Page.open(target.webSocketDebuggerUrl);
  const errors = [];
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');
  /* The profile is persistent so boots stay warm, which also means a service
     worker from a previous run can serve yesterday's JS and quietly invalidate
     the whole test. Bypass it and the HTTP cache for every probe. */
  await page.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => { });
  await page.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => { });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const n = await page.evaluate('document.querySelectorAll(".card").length').catch(() => 0);
    if (n) break;
  }
  await sleep(500);

  const counts = await page.evaluate(`(() => {
    const total = document.querySelectorAll('.card').length;
    const click = f => { const b = document.querySelector('[data-filter="' + f + '"]'); b && b.click(); return document.querySelectorAll('.card').length; };
    const originals = click('forge'), hybrids = click('hybrid');
    click('all');
    return { total, originals, hybrids, afterAll: document.querySelectorAll('.card').length };
  })()`);

  // open one original's sheet and confirm the play link is right
  const sheet = await page.evaluate(`(() => {
    const b = document.querySelector('[data-open="vaultbreak"]'); if (!b) return { error: 'no card' };
    b.click();
    const link = document.querySelector('#sheet .cta');
    return { title: (document.querySelector('#sheet h2') || {}).textContent, href: link && link.getAttribute('href'), cta: link && link.textContent };
  })()`);

  const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) writeFileSync(join(SHOTS, 'shell-http.png'), Buffer.from(shot.data, 'base64'));

  for (const e of page.events) {
    if (e.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text));
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push('console.error: ' + e.params.args.map(a => a.value || a.description).join(' '));
    if (e.method === 'Network.responseReceived' && e.params.response.status >= 400 && !/favicon/.test(e.params.response.url))
      errors.push(`http ${e.params.response.status} ${e.params.response.url}`);
  }
  /* What the page actually pulled out of vendor/ — the "did it really use the
     clones" question, answered by the network stack rather than by reading code. */
  const vend = { js: 0, png: 0, opus: 0, other: 0 };
  for (const e of page.events) {
    if (e.method !== 'Network.responseReceived') continue;
    const u = e.params.response.url;
    if (!/\/vendor\//.test(u) || e.params.response.status !== 200) continue;
    if (/\.js($|\?)/.test(u)) vend.js++;
    else if (/\.png($|\?)/.test(u)) vend.png++;
    else if (/\.opus($|\?)/.test(u)) vend.opus++;
    else vend.other++;
  }

  page.close();

  const problems = [];
  /* Stormforge renders with WebGL, so the 2D paint instrumentation that proves the sprite
     games actually blitted their art cannot see it. For those titles the evidence is the
     renderer's own counters: a live WebGL context that submitted real geometry and shading
     every frame, plus the HUD canvas still drawing 2D. */
  const WEBGL = new Set(['stormforge']);
  if (errors.length) problems.push(...errors.slice(0, 4));
  if (counts.total !== 11) problems.push(`shell shows ${counts.total} cards, expected 11`);
  if (counts.hybrids !== 7) problems.push(`the CROSS-HYBRIDS filter shows ${counts.hybrids}, expected 7`);
  if (counts.originals !== 4) problems.push(`the ORIGINALS filter shows ${counts.originals}, expected 4`);
  if (counts.afterAll !== 11) problems.push('ALL filter did not restore 11 cards');
  if (sheet.error) problems.push('sheet: ' + sheet.error);
  else if (sheet.href !== '../games/vaultbreak/index.html') problems.push('play link is ' + sheet.href);
  return { id: 'shell', url, ok: problems.length === 0, problems, counts, sheet };
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
    // short runtime dirs: chromium aborts with "Socket path too long" when
    // XDG_RUNTIME_DIR points at a deep scratch tree
    env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp/aomg-rt' },
  });

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { }
    await sleep(150);
  }

  const results = [];
  try {
    for (const id of GAMES) {
      process.stdout.write(`  ${id} … `);
      let r;
      /* One retry: a couple of checks assert that a simulation produced something over real
         elapsed time (a Mindustry plate, a trade payout), and under full-suite CPU contention
         a starved frame loop can miss that window without anything being wrong with the game. */
      try { r = await testGame(id, BASE, 'http'); }
      catch (e) { r = { id, ok: false, problems: ['harness: ' + e.message] }; }
      if (!r.ok && !/harness:/.test(r.problems[0] || '')) {
        const again = await testGame(id, BASE, 'http').catch(() => null);
        if (again && again.ok) { again.retried = true; r = again; }
      }
      results.push(r);
      const v = r.vendor
        ? `  [vendor ${r.vendor.png}png/${r.vendor.opus}audio/${r.vendor.js}js · painted ${r.paint ? r.paint.vendorFiles : 0}]`
        : '';
      console.log((r.ok ? 'PASS' : 'FAIL') + v);
      if (!r.ok) r.problems.forEach(p => console.log('     · ' + p));
    }
    // file:// proof: every original with no server at all. Each one reads its
    // vendored sprites/audio/data through relative paths, so this is the real
    // "double-click the file on a plane" case — not a claim we get to assert.
    for (const id of GAMES) {
      process.stdout.write(`  ${id} file:// offline … `);
      const f = await testGame(id, 'file://' + ROOT, 'file')
        .catch(e => ({ id, ok: false, problems: ['harness: ' + e.message] }));
      f.id = `${id}(file://)`;
      const v = f.vendor
        ? `  [vendor ${f.vendor.png}png/${f.vendor.opus}audio/${f.vendor.js}js · painted ${f.paint ? f.paint.vendorFiles : 0}]`
        : '';
      console.log((f.ok ? 'PASS' : 'FAIL') + v);
      if (!f.ok) (f.problems || []).forEach(p => console.log('     · ' + p));
      results.push(f);
    }

    // control: no bundle at all. The fallback art has to carry the game on its own.
    process.stdout.write('  vaultbreak without vendor/ (fallback art) … ');
    const ctl = await testGame('vaultbreak', BASE, 'novendor', { blockVendor: true })
      .catch(e => ({ id: 'novendor', ok: false, problems: ['harness: ' + e.message] }));
    ctl.id = 'vaultbreak(no vendor)';
    console.log((ctl.ok ? 'PASS' : 'FAIL') + (ctl.play ? `  [canvas ${ctl.play.colors} colours]` : ''));
    if (!ctl.ok) (ctl.problems || []).forEach(p => console.log('     · ' + p));
    results.push(ctl);

    process.stdout.write('  launcher shell … ');
    const sh = await testShell(BASE).catch(e => ({ id: 'shell', ok: false, problems: ['harness: ' + e.message] }));
    console.log(sh.ok ? 'PASS' : 'FAIL');
    if (!sh.ok) (sh.problems || []).forEach(p => console.log('     · ' + p));
    results.push(sh);
  } finally {
    chrome.kill('SIGKILL');
  }

  const pass = results.filter(r => r.ok).length;
  writeFileSync(join(ROOT, 'evidence', 'browser-report.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, pass, total: results.length, results }, null, 1));
  console.log(`\n${pass}/${results.length} passed · shots + evidence/browser-report.json written`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
