#!/usr/bin/env node
/* Stage the shippable site in dist/.
 *
 * The collection is static: everything the phone needs is already in the repo.
 * This copies exactly the runtime surface — launcher, the eight browser games,
 * the vendored payload, the catalog and the service worker — preserving the
 * relative paths the pages use, then drops a redirect at the root so
 * https://host/ opens the launcher.
 *
 * Used by `npm run dist`, which the ship pipeline runs as its build step.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/* docs are linked from the launcher and the games' "about" text, so they ship */
const TREES = ['shell', 'games', 'vendor', 'catalog', 'docs', 'ports'];
const FILES = ['sw.js', 'manifest.webmanifest', 'LICENSE', 'README.md', 'catalog/games.json'];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

let copied = 0;
let bytes = 0;
for (const tree of TREES) {
  const from = join(ROOT, tree);
  if (!existsSync(from)) continue;
  cpSync(from, join(DIST, tree), { recursive: true });
}
for (const file of FILES) {
  const from = join(ROOT, file);
  if (!existsSync(from)) continue;
  mkdirSync(dirname(join(DIST, file)), { recursive: true });
  cpSync(from, join(DIST, file));
}

/* count what actually landed, so the build log shows something real */
import { readdirSync } from 'node:fs';
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else { copied++; bytes += st.size; }
  }
};
walk(DIST);

writeFileSync(join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Awesome Offline Mobile Games</title>
<meta http-equiv="refresh" content="0; url=./shell/index.html">
<link rel="canonical" href="./shell/index.html">
<style>html,body{margin:0;height:100%;background:#0b0e14;color:#e9f1ff;font:16px/1.4 system-ui}
body{display:grid;place-items:center}a{color:#7cf5d0}</style>
</head>
<body><p>Opening the arcade … <a href="./shell/index.html">tap here if nothing happens</a></p></body>
</html>
`);

console.log(`dist/: ${copied} files, ${(bytes / 1048576).toFixed(2)} MB staged`);
