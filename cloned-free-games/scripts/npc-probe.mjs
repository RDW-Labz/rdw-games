#!/usr/bin/env node
// Ad-hoc probe: boot the port at a given viewport and print plate points + HUD rects, so
// I can see numerically whether a plate sits under a bar. usage: node npc-probe.mjs W H
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve('/home/cluer/kaos/work/site');
const FILE = 'games/arcade/rpg-npc-generator/index.html';
const W = Number(process.argv[2] || 390), H = Number(process.argv[3] || 844);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const bin = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find(existsSync);
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=' + W + ',' + H, '--no-first-run',
  `--user-data-dir=${mkdtempSync('/tmp/npcprobe-')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let err = '';
const ws = await new Promise((ok) => { proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); }); });
const dport = new URL(ws).port;
const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
const tgt = list.find((t) => t.type === 'page');
const sock = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((ok) => (sock.onopen = ok));
let id = 0; const pend = new Map();
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const S = (method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); sock.send(JSON.stringify({ id: i, method, params })); });
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
await S('Page.navigate', { url: `http://127.0.0.1:${port}/${FILE}` });
await new Promise((r) => setTimeout(r, 5000));
const r = await S('Runtime.evaluate', { returnByValue: true, expression: `(()=>{
  const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; };
  const pts = []; for (let i=0;i<8;i++) pts.push({i, ...window.__npc.platePoint(i), back: window.__npc.pickAt(...Object.values(window.__npc.platePoint(i)))});
  return { viewport:{w:innerWidth,h:innerHeight}, die: window.__npc.diePoint(),
    hud: { top: rect('.top'), stats: rect('.stats'), btns: rect('.btns'), roster: rect('.roster') },
    pts: pts.map(p=>({i:p.i,x:p.x,y:p.y,back:p.back})),
    hint: rect('.hint') };
})()` });
const rv = r.result && r.result.result ? r.result.result : null;
console.log(JSON.stringify(rv && rv.value !== undefined ? rv.value : rv, null, 1));
server.close(); proc.kill('SIGKILL'); process.exit(0);
