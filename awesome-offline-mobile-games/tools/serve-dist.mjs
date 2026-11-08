#!/usr/bin/env node
/* Serves dist/ the way a host will: correct MIME types, Range requests (the games
 * use <audio> with seeking), and no-store on sw.js so a cached worker can update.
 *
 *   node tools/serve-dist.mjs            # http://127.0.0.1:8400
 *   node tools/serve-dist.mjs --port 9000 --host 0.0.0.0
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg('port', 8400));
const HOST = arg('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  if (body) res.end(body); else res.end();
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url).replace(/^([/\\])+/, '');
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT + sep) && file !== ROOT) return send(res, 403, { 'content-type': 'text/plain' }, 'forbidden');
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return send(res, 404, { 'content-type': 'text/plain' }, 'not found: ' + url);

  const { size } = statSync(file);
  const type = MIME[extname(file)] || 'application/octet-stream';
  const base = {
    'content-type': type,
    'cache-control': /(^|\/)sw\.js$/.test(file) ? 'no-store' : 'no-cache',
    'accept-ranges': 'bytes',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      return send(res, 416, { ...base, 'content-range': `bytes */${size}` });
    }
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...base, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(PORT, HOST, () => console.log(`serving ${ROOT} on http://${HOST}:${PORT}/`));

export { PORT, HOST };
