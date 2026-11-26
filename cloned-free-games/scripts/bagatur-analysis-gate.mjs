#!/usr/bin/env node
// Analysis-desk gate for the Bagatur/DroidFish chess port.
// Proves the live analysis strip (depth, score, principal variation) is a real, legal
// engine line — replayed through the page's own move generator — and that a real
// pointer click on the board repaints it.
// usage: node bagatur-analysis-gate.mjs <dir-containing-games/arcade>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const FILE = 'games/arcade/bagatur-chess-engine/index.html';
const OUT = '/home/cluer/cloned-free-games/.queue/playtest';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws')); });
    const c = new CDP(ws);
    c.events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.p.has(msg.id)) { const { ok, bad } = c.p.get(msg.id); c.p.delete(msg.id); msg.error ? bad(new Error(msg.error.message)) : ok(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.p.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.p.delete(id)) bad(new Error('timeout ' + method)); }, 60000);
    });
  }
}

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/chess-an-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', '--no-first-run',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });

let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + err.slice(-300))), 120000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  proc.on('exit', (c) => bad(new Error('chromium exit ' + c + ': ' + err.slice(-300))));
});
const cdp = await CDP.attach(endpoint);
const server = await serve();
const port = server.address().port;
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => cdp.send(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value;
};

await S('Runtime.enable'); await S('Page.enable'); await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const tNav = Date.now();
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });

// Poll for the boot hook rather than sleeping blind.
let booted = false;
for (let i = 0; i < 90; i++) {
  const ok = await ev(`typeof window.__bagatur === 'function'`);
  if (ok === true) { booted = true; break; }
  await sleep(500);
}
const bootMs = Date.now() - tNav;

const click = async (pt) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
};
const clickSquare = async (r, c) => {
  const p = await ev(`window.__bagatur.tilePoint(${r},${c})`);
  if (!p || p.__err) throw new Error('tilePoint failed ' + JSON.stringify(p));
  await click(p);
  await sleep(260);
  return p;
};
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  const out = join(OUT, `${name}.png`);
  await writeFile(out, Buffer.from(s.data, 'base64'));
  return out;
};
const pollAnalysis = async (maxMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const a = await ev(`(window.__bagatur()||{}).analysis || null`);
    if (a && a.depth) return { a, waited: Date.now() - t0 };
    await sleep(250);
  }
  return { a: null, waited: Date.now() - t0 };
};

// ---- 1) boot + the analysis strip appears with a real line
const s0 = await ev('window.__bagatur()');
const { a: an0, waited: wait0 } = await pollAnalysis();
const ver0 = await ev('window.__bagatur.verifyLine()');
const timing = await ev('window.__bagatur.analysisNow()');
const shotBoot = await shot('bagatur-analysis-boot');

// ---- 2) a real click-click move repaints the strip with a fresh legal line
const boardBefore = await ev('window.__bagatur.board()');
await clickSquare(6, 4);
await clickSquare(4, 4);
const sAfter = await ev('window.__bagatur()');
const { a: an1, waited: wait1 } = await pollAnalysis();
const ver1 = await ev('window.__bagatur.verifyLine()');
const shotMove = await shot('bagatur-analysis-move');
const boardAfter = await ev('window.__bagatur.board()');

// ---- 3) the strip tracks the position: playing e4 must change the score/line
const differs = !!(an0 && an1) && (an0.score !== an1.score || an0.san.join(' ') !== an1.san.join(' '));

const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' '))
  .slice(0, 4).join(' | ');

const checks = {
  boot: booted && !!s0 && s0.pieces === 32 && s0.turn === 'w' && s0.ply === 0,
  analysisAppears: !!an0 && an0.depth === 3,
  lineLength: !!an0 && Array.isArray(an0.san) && an0.san.length === 3,
  lineLegal: !!ver0 && ver0.ok === true && ver0.plies === 3,
  hudMatchesLine: !!ver0 && ver0.matchesHud === true,
  stripVisible: !!(s0 && s0.analysisShown && /^pv d3 [+-]/.test(s0.analysisShown) && s0.analysisShown.includes('·')),
  fastEnough: !!timing && timing.ms < 4000,
  movePlayed: !!sAfter && sAfter.ply >= 1 && boardBefore[52] === 'P' && boardAfter[52] === '.',
  repainted: !!an1 && an1.depth === 3 && Array.isArray(an1.san) && an1.san.length === 3,
  repaintLegal: !!ver1 && ver1.ok === true && ver1.plies === 3 && ver1.matchesHud === true,
  tracksPosition: differs,
  noErrors: !errors,
};

console.log(JSON.stringify({
  checks, errors, bootMs, wait0, wait1,
  an0: an0 && { depth: an0.depth, score: an0.score, san: an0.san },
  an1: an1 && { depth: an1.depth, score: an1.score, san: an1.san },
  ver0, ver1, timing,
  strip: s0 && s0.analysisShown,
  shots: [shotBoot, shotMove],
}, null, 0));
console.log(Object.values(checks).every(Boolean) ? 'ANALYSIS GATE PASS' : 'ANALYSIS GATE FAIL');
proc.kill('SIGKILL'); server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
