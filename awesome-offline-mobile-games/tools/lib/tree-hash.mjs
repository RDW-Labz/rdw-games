/* A single hash for a whole directory tree.
 *
 * Used to prove the iOS payload is byte-for-byte the same collection the browser
 * tests just played: same files, same names, same bytes, no stragglers. Sorting
 * by relative path keeps it stable across machines, and hashing the "path\0sha"
 * lines means a renamed file changes the tree hash even when the bytes are equal.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function listTree(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function treeHash(root) {
  const files = listTree(root);
  const h = createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const buf = readFileSync(join(root, rel));
    bytes += buf.length;
    h.update(rel).update('\0').update(createHash('sha256').update(buf).digest('hex')).update('\n');
  }
  return { files: files.length, bytes, sha256: h.digest('hex') };
}

export function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
