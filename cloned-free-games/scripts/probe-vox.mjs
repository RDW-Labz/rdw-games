#!/usr/bin/env node
// Throwaway probe: what cell does the pick resolve for a projected block point?
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/tmp/minetest-stage');
const W = Number(process.argv[3] || 1280), H = Number(process.argv[4] || 800);
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = join(ROOT, p);
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const port = srv.address().port;

const bin = ['/usr/bin/chromium', '/usr/bin/brave'].find(existsSync);
const prof = mkdtempSync('/tmp/probe-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', `--window-size=${W},${H}`, '--no-first-run', `--user-data-dir=${prof}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools ' + err.slice(-200))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok) => (ws.onopen = ok));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); } };
const S = (method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/games/arcade/minetest-game.html` });
await sleep(5500);

const sites = await ev('window.__blockworld.sites()');
const out = [];
for (const s of sites) {
  const pTop = await ev(`window.__blockworld.blockPoint(${s.x},${s.h},${s.z})`);
  const pGold = await ev(`window.__blockworld.blockPoint(${s.x},${s.goldY},${s.z})`);
  const kTop = await ev(`window.__blockworld.pick(${pTop.x},${pTop.y})`);
  const kGold = await ev(`window.__blockworld.pick(${pGold.x},${pGold.y})`);
  const types = await ev(`({surface:window.__blockworld.blockType(${s.x},${s.h},${s.z}),gold:window.__blockworld.blockType(${s.x},${s.goldY},${s.z})})`);
  out.push({ site: [s.x, s.z], h: s.h, goldY: s.goldY, pTop, pGold, kTop, kGold, types });
}
console.log(JSON.stringify(out, null, 1));
proc.kill('SIGKILL'); srv.close(); process.exit(0);
