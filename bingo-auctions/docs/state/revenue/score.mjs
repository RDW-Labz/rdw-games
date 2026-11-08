// Computes rubric totals for candidates.json. Run: node docs/state/revenue/score.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(new URL('./rubric.json', import.meta.url)));
const c = JSON.parse(readFileSync(new URL('./candidates.json', import.meta.url)));
const rows = c.candidates.map((x) => {
  const total = x.disqualified ? 0 : r.criteria.reduce((a, k) => a + (x.scores[k.key] * k.weight) / 5, 0);
  return { id: x.id, name: x.name, total: Math.round(total * 10) / 10, disqualified: x.disqualified };
}).sort((a, b) => b.total - a.total);
const out = { pass_mark: r.pass_mark, top: rows[0], runner_up: rows[1], passes: rows.filter((x) => x.total >= r.pass_mark).map((x) => x.id), ranking: rows };
writeFileSync(new URL('./scores.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
for (const x of rows) console.log(String(x.total).padStart(5), x.id, x.disqualified ? '[DQ]' : '', x.name.slice(0, 80));
console.log('passes >= ' + r.pass_mark + ':', out.passes.length ? out.passes.join(',') : 'NONE');
