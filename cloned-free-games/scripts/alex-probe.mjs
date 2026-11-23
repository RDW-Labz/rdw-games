#!/usr/bin/env node
// quick look: boot the port, print the hook + camera, save one screenshot
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '/home/cluer/kaos/work/site');
const W = +(process.argv[3] || 1280), H = +(process.argv[4] || 800);
const OUT = process.argv[5] || '/home/cluer/cloned-free-games/.queue/playtest/alex-probe.png';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }).end(await readFile(f));
  } catch { if (!res.headersSent) res.writeHead(404).end('404'); else res.end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/games/arcade/alex-vs-bus/`;
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const prof = mkdtempSync('/tmp/alex-probe-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', `--window-size=${W},${H}`, '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--user-data-dir=${prof}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const ep = await new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error(err)), 25000); proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } }); });
const dport = new URL(ep).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((ok) => (ws.onopen = ok));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg.result); pend.delete(msg.id); } };
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 5200));
console.log(JSON.stringify(await ev('window.__alex()')));
const s = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(s.data, 'base64'));
console.log('shot ' + OUT);
proc.kill('SIGKILL'); server.close(); process.exit(0);
