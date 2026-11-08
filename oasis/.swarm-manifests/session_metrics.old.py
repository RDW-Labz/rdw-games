"""Session metrics for coordination/swarm-metrics.md (decision #143).

Usage: python3 coordination/tools/session_metrics.py --since <ISO start> [--until <ISO end>] ROOT [ROOT ...]
ROOT = every worktree/repo that ran swarm jobs this session. Reads .swarm/runs/*/state.json
(agent jobs only; checks, CI, nightly and builds are not jobs). Prints one JSON line.
- idle_min: minutes inside [since, until] with zero agent jobs running (TASK.md always had work
  this far; if it did not, subtract that time by hand and say so).
- parallel_avg: time-weighted average running jobs while at least one ran.
- gaps: idle stretches of 1 minute or more, so the report can name what caused them.
Wall time per merged PR is measured separately: merge time minus the first run for that PR.
"""
import argparse, datetime as dt, glob, json, os

def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

ap = argparse.ArgumentParser()
ap.add_argument('--since', required=True)
ap.add_argument('--until')
ap.add_argument('roots', nargs='+')
a = ap.parse_args()
since = ts(a.since)
iv = []
for root in a.roots:
    for st in glob.glob(os.path.join(os.path.expanduser(root), '.swarm/runs/*/state.json')):
        for j in json.load(open(st)).get('jobs', []):
            if j.get('startedAt') and j.get('finishedAt'):
                s, e = max(ts(j['startedAt']), since), ts(j['finishedAt'])
                if e > s:
                    iv.append((s, e))
until = ts(a.until) if a.until else max((e for _, e in iv), default=since)
iv = [(s, min(e, until)) for s, e in iv if s < until]
ev = sorted([(s, 1) for s, _ in iv] + [(e, -1) for _, e in iv])
busy = weighted = idle = 0.0
cur, prev, gaps = 0, since, []
for x, d in ev + [(until, 0)]:
    span = (x - prev).total_seconds()
    if cur > 0:
        busy += span; weighted += cur * span
    elif span > 0:
        idle += span
        if span >= 60:
            gaps.append([prev.strftime('%H:%MZ'), x.strftime('%H:%MZ'), round(span / 60, 1)])
    cur += d; prev = x
print(json.dumps({'window_min': round((until - since).total_seconds() / 60, 1), 'jobs': len(iv),
                  'idle_min': round(idle / 60, 1), 'parallel_avg': round(weighted / busy, 2) if busy else 0,
                  'gaps': gaps}))
