#!/usr/bin/env node
// Dump page errors for a port that never publishes its hook (throw-on-load probe).
// usage: node port-probe.mjs <relative-url-path> [siteRoot]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(process.argv[3] || '/home/cluer/kaos/work/site');
const FILE = process.argv[2];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p);
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const port = srv.address().port;

const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/brave'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800', `--user-data-dir=${mkdtempSync('/tmp/probe-')}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let buf = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools: ' + buf.slice(-400))), 120000);
  proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok) => { ws.onopen = ok; });
let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg); pending.delete(msg.id); } else if (msg.method) events.push(msg); };
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await new Promise((r) => setTimeout(r, 6000));
const hookKeys = await send('Runtime.evaluate', { expression: 'Object.keys(window).filter(k=>k.startsWith("__"))', returnByValue: true });
const bodyLen = await send('Runtime.evaluate', { expression: 'document.body.innerHTML.length', returnByValue: true });
const msgs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
  .map((e) => ({ m: e.method, t: e.params.type, text: e.params.exceptionDetails?.exception?.description || e.params.entry?.text || (e.params.args || []).map((a) => a.description || a.value).join(' ') || e.params.exceptionDetails?.text }))
  .filter((e) => e.text);
console.log(JSON.stringify({ hookKeys: hookKeys.result?.value, bodyLen: bodyLen.result?.value, msgs: msgs.slice(0, 12) }, null, 1));
proc.kill('SIGKILL'); srv.close(); process.exit(0);
