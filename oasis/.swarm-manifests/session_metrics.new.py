"""Session metrics for coordination/swarm-metrics.md (decision #143).

Usage: python3 coordination/tools/session_metrics.py --since <ISO start> [--until <ISO end>]
       [--agent-log FILE ...] ROOT [ROOT ...]
ROOT = every worktree/repo that ran swarm jobs this session. Reads .swarm/runs/*/state.json
(agent jobs only; checks, CI, nightly and builds are not jobs). Prints one JSON line.
- idle_min: minutes inside [since, until] with zero agent jobs running (TASK.md always had work
  this far; if it did not, subtract that time by hand and say so).
- parallel_avg: time-weighted average running jobs while at least one ran.
- gaps: idle stretches of 1 minute or more, so the report can name what caused them.
- still_running: jobs/agent-log rows that had started but had no finish time by --until (they
  count as running from their start through --until instead of being dropped).
- agent_log_intervals: how many of the counted intervals came from --agent-log files rather
  than from a root's .swarm/runs/*/state.json.

Workers launched through the Claude Code Agent tool don't write state.json, so they're invisible
to the roots above. Pass --agent-log FILE (repeatable) to also load JSON-Lines rows of the form
{"label": str, "start": ISO-8601, "end": ISO-8601 or null}; "end": null (or omitted) means the
worker was still running at --until. If --agent-log is never passed and
coordination/agent-tool-jobs.jsonl exists relative to the current directory, it is read by
default. Blank lines are skipped; any other malformed line is a hard error naming the file and
line number.

Wall time per merged PR is measured separately: merge time minus the first run for that PR.
"""
import argparse, datetime as dt, glob, json, os, sys

def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

def load_swarm_jobs(root):
    """Yield (start, end_or_None) for every job with a startedAt in root's state.json files."""
    for st in glob.glob(os.path.join(os.path.expanduser(root), '.swarm/runs/*/state.json')):
        data = json.load(open(st))
        for j in data.get('jobs', []):
            if not j.get('startedAt'):
                continue
            end = ts(j['finishedAt']) if j.get('finishedAt') else None
            yield ts(j['startedAt']), end

def load_agent_log(path):
    """Yield (start, end_or_None) for each JSON-Lines row in an --agent-log file."""
    with open(path) as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                start = ts(row['start'])
                end = ts(row['end']) if row.get('end') else None
            except Exception as exc:
                sys.exit(f'{path}:{lineno}: malformed agent log line: {exc}')
            yield start, end

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until')
    ap.add_argument('--agent-log', action='append', default=[], dest='agent_log')
    ap.add_argument('roots', nargs='+')
    a = ap.parse_args()
    since = ts(a.since)

    raw = []  # list of (start, end_or_None, source)
    for root in a.roots:
        for s, e in load_swarm_jobs(root):
            raw.append((s, e, 'swarm'))

    agent_logs = list(a.agent_log)
    default_log = 'coordination/agent-tool-jobs.jsonl'
    if not agent_logs and os.path.exists(default_log):
        agent_logs = [default_log]
    for path in agent_logs:
        for s, e in load_agent_log(path):
            raw.append((s, e, 'agent'))

    until = ts(a.until) if a.until else max((e for _, e, _ in raw if e), default=since)

    iv = []
    still_running = 0
    agent_log_intervals = 0
    for s, e, source in raw:
        cs = max(s, since)
        open_ended = e is None
        ce = until if open_ended else min(e, until)
        if ce > cs:
            iv.append((cs, ce))
            if open_ended:
                still_running += 1
            if source == 'agent':
                agent_log_intervals += 1

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
                      'gaps': gaps, 'still_running': still_running, 'agent_log_intervals': agent_log_intervals}))

if __name__ == '__main__':
    main()
