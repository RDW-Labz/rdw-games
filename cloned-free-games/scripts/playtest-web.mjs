#!/usr/bin/env node
// Headless playtest for detected web-ready games.
// Loads each game's static dir over a local http server in headless Chromium via CDP,
// records uncaught exceptions / console errors / failed local requests, checks the page
// actually rendered something (canvas pixels or visible text), and writes a screenshot.
//
// usage: node scripts/playtest-web.mjs <slug>=<dir> [...]
//        node scripts/playtest-web.mjs --from-queue     # playtest every unpromoted web-ready item
// output: .queue/playtest.json  +  .queue/playtest/<slug>.png

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.queue/playtest');
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.txt': 'text/plain', '.map': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function serve(dir) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(dir, p);
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      }).end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.on = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { ok, bad } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method && c.on.has(msg.method)) {
        for (const fn of c.on.get(msg.method)) fn(msg.params);
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.pending.delete(id)) bad(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  listen(method, fn) { if (!this.on.has(method)) this.on.set(method, []); this.on.get(method).push(fn); }
}

// systemd user units do not inherit the login shell's PATH, so resolve tools both ways:
// absolute fallbacks first (never trust a bare `which`), then a PATH scan.
function which(...names) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of ['/usr/sbin', '/usr/bin', '/usr/local/bin', ...dirs]) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function launch() {
  const bin = which('chromium', 'chromium-browser', 'google-chrome-stable', 'brave');
  if (!bin) throw new Error('chromium not found');
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/tmp/playtest-chromium', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
  let stderr = '';
  const endpoint = await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('no devtools endpoint: ' + stderr.slice(-400))), 30000);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    proc.on('exit', (code) => bad(new Error(`chromium exited ${code}: ${stderr.slice(-400)}`)));
  });
  const cdp = await CDP.attach(endpoint);
  return { proc, cdp };
}

async function playtest(cdp, slug, dir, path = '/') {
  const server = await serve(dir);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${path}`;

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  const errors = [];
  const failed = [];
  const reqUrl = new Map();
  cdp.listen('Network.requestWillBeSent', (p) => reqUrl.set(p.requestId, p.request?.url || ''));
  cdp.listen('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push((d.exception?.description || d.text || 'exception').split('\n')[0].slice(0, 200));
  });
  cdp.listen('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const txt = p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200);
    errors.push('console: ' + txt);
  });
  cdp.listen('Network.loadingFailed', (p) => {
    if (p.canceled) return;
    const url = reqUrl.get(p.requestId) || '';
    // A third-party script that never loads (CDN analytics, font host) is a warning, not a
    // broken game. Only a request for the game's own files means the build is incomplete.
    const external = url && !url.startsWith(`http://127.0.0.1:${port}`);
    failed.push(`${p.errorText || 'failed'} ${external ? 'external ' : ''}${url.replace(`http://127.0.0.1:${port}`, '')}`.slice(0, 160));
    if (external) failed[failed.length - 1] = '~' + failed[failed.length - 1];
  });

  await S('Runtime.enable');
  await S('Page.enable');
  await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url });

  // let it boot: wait for load, then give rAF/asset loads time to settle
  await new Promise((r) => setTimeout(r, 7000));

  const probe = await S('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: false,
    expression: `(() => {
      const cs = [...document.querySelectorAll('canvas')];
      let pixels = 0, live = 0, variance = 0, colors = 0;
      for (const c of cs) {
        try {
          const w = c.width || c.clientWidth, h = c.height || c.clientHeight;
          if (!w || !h) continue;
          pixels += w * h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          // A WebGL canvas hands back a null 2d context: it is drawing, but we cannot read it.
          if (!ctx) { live++; variance = Math.max(variance, 1); colors = Math.max(colors, 8); continue; }
          const sw = Math.min(w, 200), sh = Math.min(h, 200);
          const d = ctx.getImageData(0, 0, sw, sh).data;
          const hist = new Map();
          let opaque = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 8) continue;
            opaque++;
            const k = (d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4);
            hist.set(k, (hist.get(k) || 0) + 1);
          }
          colors = Math.max(colors, hist.size);
          if (opaque) {
            const top = Math.max(...hist.values());
            const v = 1 - top / opaque;           // share of pixels that are not the modal colour
            if (v > 0.02) { live++; variance = Math.max(variance, v); }
          }
        } catch (e) {}
      }
      const text = (document.body?.innerText || '').replace(/\\s+/g,' ').trim();
      return {
        title: document.title, url: location.href,
        canvases: cs.length, canvasPixels: pixels, canvasShaded: live,
        canvasVariance: +variance.toFixed(3), canvasColors: colors,
        textLen: text.length, text: text.slice(0, 160),
        nodes: document.body?.querySelectorAll('*').length || 0,
        scripts: document.querySelectorAll('script[src]').length,
        bg: getComputedStyle(document.body || document.documentElement).backgroundColor,
      };
    })()`,
  });
  const info = probe.result?.value || {};

  const shot = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const png = join(OUT, `${slug}.png`);
  await writeFile(png, Buffer.from(shot.data, 'base64'));

  // The screenshot, not the engine's own report, decides whether anything was drawn: a WebGL
  // canvas gives us no readable pixels, but it cannot fake an image. A flat fill (blank page,
  // white flash, single-colour splash left behind) has almost no standard deviation.
  const { execFile } = await import('node:child_process');
  const magick = which('magick', 'convert');
  const spread = await new Promise((ok) => {
    if (!magick) return ok(null);
    execFile(magick, [png, '-colorspace', 'gray', '-format', '%[fx:standard_deviation]', 'info:'],
      (err, stdout) => ok(err ? null : Number(stdout.trim())));
  });
  info.imageStdDev = Number.isFinite(spread) ? +spread.toFixed(4) : null;

  await cdp.send('Target.closeTarget', { targetId });
  server.close();

  const localFails = failed.filter((f) => !f.startsWith('~'));
  const externalFails = failed.filter((f) => f.startsWith('~'));
  const rendered = (info.imageStdDev !== null && info.imageStdDev > 0.02) || info.textLen > 40;
  const bad = errors.length > 0 || localFails.length > 0 || !rendered;
  return {
    slug, verdict: bad ? 'fail' : 'pass',
    why: [
      !rendered ? `blank page (screenshot stddev ${info.imageStdDev}, ${info.textLen} chars of text)` : null,
      errors.length ? `${errors.length} js error(s): ${errors.slice(0, 3).join(' | ')}` : null,
      localFails.length ? `${localFails.length} failed local request(s): ${localFails.slice(0, 3).join(' | ')}` : null,
      externalFails.length ? `${externalFails.length} external request(s) blocked (ignored)` : null,
    ].filter(Boolean).join('; '),
    errors: errors.slice(0, 6),
    failed: localFails.slice(0, 6),
    externalWarnings: externalFails.slice(0, 6),
    ...info,
  };
}

// ---- main ----
const AUTO_PROMOTE = process.argv.includes('--auto-promote');
const ALLOW_FILES = ['scripts/playable-allow.txt', 'scripts/playable-auto.txt'];
const BLOCK_FILE = 'scripts/playable-block.txt';

async function readList(rel) {
  try {
    const txt = await readFile(join(ROOT, rel), 'utf8');
    return txt.split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);
  } catch { return []; }
}
async function setOf(rels) {
  const s = new Set();
  for (const r of rels) for (const x of await readList(r)) s.add(x);
  return s;
}
async function appendLine(rel, line) {
  const p = join(ROOT, rel);
  let cur = '';
  try { cur = await readFile(p, 'utf8'); } catch {}
  if (cur && !cur.endsWith('\n')) cur += '\n';
  await writeFile(p, cur + line + '\n');
}

let targets = [];
if (process.argv[2] === '--from-queue' || (AUTO_PROMOTE && !process.argv.slice(2).some((a) => a.includes('=')))) {
  const q = JSON.parse(await readFile(join(ROOT, '.queue/web-playable.json'), 'utf8'));
  const allow = await setOf(ALLOW_FILES);
  const blocked = await setOf([BLOCK_FILE]);
  targets = q.items
    .filter((i) => !allow.has(i.slug) && !blocked.has(i.slug))
    .map((i) => ({ slug: i.slug, dir: i.base }));
} else {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    const [slug, spec] = arg.split('=');
    const [dir, path] = spec.split('#');
    targets.push({ slug, dir: resolve(dir), path: path || '/' });
  }
}
if (!targets.length) { console.log('nothing to test'); process.exit(0); }

const { proc, cdp } = await launch();
const results = [];
for (const t of targets) {
  try {
    const r = await playtest(cdp, t.slug, t.dir, t.path);
    results.push(r);
    console.log(`${r.verdict.toUpperCase().padEnd(4)} ${t.slug.padEnd(24)} sd=${String(r.imageStdDev).padEnd(6)} text=${String(r.textLen).padEnd(5)} ${r.why ? '— ' + r.why : ''}`);
  } catch (e) {
    results.push({ slug: t.slug, verdict: 'error', why: String(e.message).slice(0, 200) });
    console.log(`ERROR ${t.slug}: ${e.message}`);
  }
}
proc.kill('SIGKILL');

const existing = existsSync(join(ROOT, '.queue/playtest.json'))
  ? JSON.parse(await readFile(join(ROOT, '.queue/playtest.json'), 'utf8')) : {};
const merged = { ...(existing.results ? existing : { results: {} }) };
merged.results = { ...(merged.results || {}) };
for (const r of results) merged.results[r.slug] = { ...r, at: new Date().toISOString() };
merged.pass = Object.entries(merged.results).filter(([, v]) => v.verdict === 'pass').map(([k]) => k).sort();
merged.fail = Object.entries(merged.results).filter(([, v]) => v.verdict !== 'pass').map(([k]) => k).sort();
await writeFile(join(ROOT, '.queue/playtest.json'), JSON.stringify(merged, null, 1));
console.log(`\nthis run — pass: ${results.filter((r) => r.verdict === 'pass').map((r) => r.slug).join(' ') || '(none)'}`);
console.log(`this run — fail: ${results.filter((r) => r.verdict !== 'pass').map((r) => r.slug).join(' ') || '(none)'}`);
console.log(`cumulative pass: ${merged.pass.join(' ')}`);
console.log(`cumulative fail: ${merged.fail.join(' ')}`);

if (AUTO_PROMOTE) {
  const allow = await setOf(ALLOW_FILES);
  const blocked = await setOf([BLOCK_FILE]);
  for (const r of results) {
    if (r.verdict === 'pass' && !allow.has(r.slug)) {
      await appendLine('scripts/playable-auto.txt', r.slug);
      console.log(`allow-listed ${r.slug}`);
    } else if (r.verdict !== 'pass' && !blocked.has(r.slug)) {
      const why = (r.why || r.verdict).replace(/\s+/g, ' ').slice(0, 120);
      await appendLine(BLOCK_FILE, `${r.slug}  # playtest: ${why}`);
      console.log(`blocked ${r.slug}: ${why}`);
    }
  }
}
