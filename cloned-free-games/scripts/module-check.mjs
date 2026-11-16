// Extract every inline <script type="module"> from an HTML file and syntax-check it.
// usage: node module-check.mjs <file.html> [more.html ...]
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
let bad = 0;
for (const file of process.argv.slice(2)) {
  const html = await readFile(file, 'utf8');
  const mods = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!mods.length) { console.log(`NO-MODULE ${file}`); bad++; continue; }
  const tmp = `/tmp/modcheck-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`;
  await writeFile(tmp, mods.join('\n'));
  try {
    await run(process.execPath, ['--check', tmp]);
    console.log(`OK ${file} (${mods.length} module block(s), ${mods.join('').split('\n').length} lines)`);
  } catch (e) {
    console.log(`SYNTAX ${file}\n${(e.stderr || e.message).slice(0, 1200)}`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
