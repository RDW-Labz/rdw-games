#!/usr/bin/env node
// Splice the generated puzzle set into the port's CORE block, mechanically.
// Never retype a line: scripts/tactic-trainer-gen.mjs emits [from,to] indices, this bakes
// them into PUZZLES verbatim with the rating ladder, so a proven line cannot drift into an
// illegal one on the way through someone's eye.
// usage: node scripts/tactic-trainer-bake.mjs <puzzles.json> [port.html]
import { readFile, writeFile } from 'node:fs/promises';

const JSON_IN = process.argv[2] || '/tmp/tactic-puzzles.json';
const PORT = process.argv[3] || '/home/cluer/kaos/work/site/games/arcade/tactic-trainer/index.html';
const puzzles = JSON.parse(await readFile(JSON_IN, 'utf8'));

const one = puzzles.filter((p) => p.mate === 1);
const two = puzzles.filter((p) => p.mate === 2);
const rows = [];
one.forEach((p, i) => rows.push({ ...p, rating: 1440 + i * 30 }));
two.forEach((p, i) => rows.push({ ...p, rating: 1760 + i * 50 }));

const lit = rows.map((p) =>
  `  { mate: ${p.mate}, fen: '${p.fen}', line: ${JSON.stringify(p.line)}, theme: '${p.theme}', rating: ${p.rating} },`
).join('\n');
const block = `const PUZZLES = [\n${lit}\n];`;

const html = await readFile(PORT, 'utf8');
const start = html.indexOf('const PUZZLES = [');
const end = html.indexOf('];', start);
if (start < 0 || end < 0) { console.error('no PUZZLES block'); process.exit(1); }
const next = html.slice(0, start) + block + html.slice(end + 2);
await writeFile(PORT, next);
console.log(`baked ${rows.length} puzzles (${one.length} mate-in-1, ${two.length} mate-in-2) into ${PORT}`);
