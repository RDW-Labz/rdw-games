import fs from 'node:fs'; import path from 'node:path';
import { reworkBySkill } from '/Users/prime/.project-swarm/current/tools/session-metrics.mjs';
const [since, until, ...roots] = process.argv.slice(2); const s = Date.parse(since), u = Date.parse(until);
const jobs = [];
for (const root of roots) { const dir = path.join(root, '.swarm/runs'); if (!fs.existsSync(dir)) continue;
  for (const id of fs.readdirSync(dir)) { let st; try { st = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8')); } catch { continue; }
    for (const j of st.jobs ?? []) { if (j.status !== 'complete') continue; const f = Date.parse(j.finishedAt ?? ''); if (!(f >= s && f <= u)) continue;
      jobs.push({ root: path.resolve(root), runId: st.id, startedAt: j.startedAt, finishedAt: j.finishedAt, outputs: (j.outputs ?? []).filter(o => !o.startsWith('docs/_swarm/')), skills: j.skills ?? [], id: j.id }); } } }
const DAY = 864e5;
const followed = job => jobs.some(o => o !== job && o.root === job.root && o.runId !== job.runId && Date.parse(o.startedAt) > Date.parse(job.finishedAt) && Date.parse(o.startedAt) - Date.parse(job.finishedAt) <= DAY && o.outputs.some(f => job.outputs.includes(f)));
const build = jobs.filter(j => j.outputs.length);
const rw = build.filter(followed).length;
console.log(JSON.stringify({ window: [since, until], roots: roots.length, completeJobsWithOutputs: build.length, reworkJobs: rw, reworkShare: build.length ? +(rw / build.length).toFixed(3) : null, bySkill: reworkBySkill(jobs) }));
