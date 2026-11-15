// lib-art.mjs — capture real in-game art for the library face.
//
// The grid used to be monogram plates (generated). A shelf of games should show the
// games: this drives headless Chromium over raw CDP (no npm deps), loads each tile's
// launch URL, waits for the canvas to have painted, and saves a 1200x780 viewport shot
// to <out>/<slug>.png. index.html uses those as tile art with background-size:cover, so
// no cropping is needed here.
//
// usage: node scripts/lib-art.mjs --base http://127.0.0.1:8791 --out .queue/lib-art
//        (--base must serve the same tree the tiles live in: /play/<slug>/ + /games/arcade/)
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:8791').replace(/\/$/, '');
const OUT = arg('--out', '.queue/lib-art');
const TILES = arg('--tiles', '.queue/library-art-tiles.json');
const WAIT = Number(arg('--wait', '6500'));
const PORTRANGE = [9411, 9530];

import { mkdirSync } from 'node:fs';
try { mkdirSync('/tmp/libart-run', { recursive: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result);
    }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      setTimeout(() => { if (this.pending.delete(id)) bad(new Error('timeout ' + method)); }, 40000);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function launch() {
  for (const port of PORTRANGE) {
    const child = spawn('chromium', [
      '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--hide-scrollbars', '--user-data-dir=/tmp/libart-profile', '--window-size=1200,780', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'],
         // TMPDIR here is Hermes's deep scratch path; chromium's process-singleton socket
       // path has a ~100 byte limit and aborts with "Socket path too long" without this.
       env: { ...process.env, TMPDIR: '/tmp', XDG_RUNTIME_DIR: '/tmp/libart-run' } });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return { child, port, info: await r.json() };
      } catch {}
      if (child.exitCode !== null) break;
    }
    try { child.kill('SIGKILL'); } catch {}
    if (port === PORTRANGE[PORTRANGE.length - 1]) throw new Error('chromium never opened a debug port: ' + err.slice(-300));
  }
}

const { child, port, info } = await launch();
// /json/version is the BROWSER endpoint (no Page domain); the page target's own socket
// does. Pick the first page target and drive that.
let pageWs = null;
for (let i = 0; i < 20 && !pageWs; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    pageWs = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || null;
  } catch {}
  if (!pageWs) await sleep(300);
}
if (!pageWs) throw new Error('no page target exposed by chromium');
const ws = new WebSocket(pageWs);
await new Promise((ok, bad) => { ws.addEventListener('open', ok); ws.addEventListener('error', bad); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });

const tiles = JSON.parse(await readFile(TILES, 'utf8'));
await mkdir(OUT, { recursive: true });
let ok = 0, failed = [];
for (const t of tiles) {
  const url = BASE + t.url;
  try {
    await cdp.send('Page.navigate', { url });
    await sleep(WAIT);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 12000) throw new Error(`suspiciously small shot (${buf.length} B)`);
    await writeFile(join(OUT, (t.slug || t.name).replace(/[^A-Za-z0-9._-]+/g, '-') + '.png'), buf);
    ok++;
    console.log(`OK   ${t.name} -> ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    failed.push(`${t.name}: ${e.message}`);
    console.log(`FAIL ${t.name}: ${e.message}`);
  }
}
try { await cdp.send('Browser.close'); } catch {}
try { child.kill('SIGKILL'); } catch {}
console.log(`ART ${ok}/${tiles.length} captured -> ${OUT}`);
if (failed.length) console.log('FAILED ' + failed.join(' | '));
process.exit(ok === 0 ? 1 : 0);
