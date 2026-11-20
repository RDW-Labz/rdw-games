#!/usr/bin/env node
// Print every console/exception message from booting one arcade page. usage: node probe-page.mjs <url>
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
const URL0 = process.argv[2];
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const PROFILE = mkdtempSync('/tmp/probe-');
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800',
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const endpoint = await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('no devtools ' + err.slice(-300))), 30000);
  proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});
const dport = new URL(endpoint).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const tgt = list.find((t) => t.type === 'page');
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((ok) => { ws.onopen = ok; });
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j.result); pend.delete(j.id); } else events.push(j); };
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL0 });
await new Promise((r) => setTimeout(r, 7000));
for (const e of events) {
  if (e.method === 'Runtime.exceptionThrown') console.log('EXC: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
  else if (e.method === 'Runtime.consoleAPICalled') console.log('CONSOLE ' + e.params.type + ': ' + (e.params.args || []).map((a) => a.value || a.description).join(' '));
  else if (e.method === 'Log.entryAdded') console.log('LOG ' + e.params.entry.level + ': ' + e.params.entry.text);
}
const t = await send('Runtime.evaluate', { expression: process.argv[3] || 'typeof window.__bubble', returnByValue: true });
console.log('probe: ' + JSON.stringify(t.result?.value ?? t.exceptionDetails));
proc.kill('SIGKILL');
process.exit(0);
