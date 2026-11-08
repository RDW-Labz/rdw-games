"""Session metrics for coordination/swarm-metrics.md (decision #143).

Usage: python3 coordination/tools/session_metrics.py --since <ISO start> [--until <ISO end>]
       [--agent-log FILE ...] ROOT [ROOT ...]
ROOT = every worktree/repo that ran swarm jobs this session. Reads .swarm/runs/*/state.json
(agent jobs only; checks, CI, nightly and builds are not jobs). Prints one JSON line.
- idle_min: minutes inside [since, until] with zero agent jobs running (TASK.md always had work
  this far; if it did not, subtract that time by hand and say so).
- parallel_avg: time-weighted average running jobs while at least one ran (a job whose
  state.json status is refused or blocked, or that never started a worker, is not counted).
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
default. Blank lines are skipped; event rows without a start are skipped with a warning.
Any other malformed line is a hard error naming the file and line number.
Open agent-log rows older than 12 hours before --since are ignored with a warning.

Wall time per merged PR is measured separately: merge time minus the first run for that PR.

Rework (swarm improvement loop, first step is measurement): each ROOT's .swarm/runs/*/state.json
keeps only the LAST integrate attempt per run, so a run that was red and later re-integrated green
is counted as green here -- this undercounts red/rework. --rework-only prints just
{"rework": {...}} and skips loading jobs for the idle/parallel computation.

Ship (E2, measurement first): --ship-logs FILE-OR-GLOB (repeatable) reads swarm ship log files,
one JSON object per line or per file, with fields including branch, status (refused/held/
ci-failed/merged), reason, code and timing. Each ROOT's worktrees/*-ship*.log is also read
automatically. Reports per branch: attempts (count of ship records), refusedCodes (tally of
`code` on refused records) and minutesToFirstPush, the minutes from the first attempt to the
first record whose status is held or merged, or that carries a sha pushed by a non-refused
attempt. These log records carry no wall-clock timestamp, so minutesToFirstPush is computed
from each log file's mtime; `minutesToFirstPushSource` says so ("mtime", vs "timestamp" if a
record ever carries one). Malformed or branch-less lines are skipped and counted in `skipped`.
--ship-only prints just {"ship": {...}}; otherwise the block is added to the default output.
"""
import argparse, datetime as dt, glob, json, os, re, sys

def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

_EXCLUDED_JOB_STATUSES = {'refused', 'blocked'}

def load_swarm_jobs(root):
    """Yield (start, end_or_None) for every job with a startedAt in root's state.json files.
    A job that never started a worker (no startedAt) or whose status is refused or blocked --
    it was stopped by a gate, not a run doing counted work -- is excluded (decision #325);
    this keeps such runs from being read as still-running through --until when they have no
    finishedAt."""
    for st in glob.glob(os.path.join(os.path.expanduser(root), '.swarm/runs/*/state.json')):
        data = json.load(open(st))
        for j in data.get('jobs', []):
            if not j.get('startedAt'):
                continue
            if j.get('status') in _EXCLUDED_JOB_STATUSES:
                continue
            end = ts(j['finishedAt']) if j.get('finishedAt') else None
            yield ts(j['startedAt']), end

def load_states(root):
    """Yield the parsed state.json dict for every run under root's .swarm/runs/."""
    for st in glob.glob(os.path.join(os.path.expanduser(root), '.swarm/runs/*/state.json')):
        yield json.load(open(st))

_ENV_RE = re.compile(r"ModuleNotFound|No module named|command not found|ENOENT|Executable doesn't exist|version mismatch")
_TIMEOUT_RE = re.compile(r'timed out|Timeout')
_LINT_NAMES = {'ruff', 'eslint', 'whitespace', 'lint', 'format'}
_TYPES_NAMES = {'mypy', 'typecheck', 'tsc', 'types', 'types-win32'}

def classify_red(failing_checks):
    """Bucket one red run into tests/lint/types/timeout/env from its failing checks."""
    tails = [c.get('tail') or '' for c in failing_checks]
    if any(_ENV_RE.search(t) for t in tails):
        return 'env'
    if any(_TIMEOUT_RE.search(t) for t in tails):
        return 'timeout'
    names = {c.get('name') for c in failing_checks}
    if names and names <= _LINT_NAMES:
        return 'lint'
    if names and names <= _TYPES_NAMES:
        return 'types'
    return 'tests'

def compute_rework(roots, since, until):
    """Rework object for every state.json across roots with integratedAt in [since, until]."""
    integrated = integrated_no_checks = red = 0
    red_by_check = {}
    red_kind = {'tests': 0, 'lint': 0, 'types': 0, 'timeout': 0, 'env': 0}
    red_cost_usd = 0.0
    for root in roots:
        for data in load_states(root):
            integrated_at = data.get('integratedAt')
            if not integrated_at:
                continue
            t = ts(integrated_at)
            if not (since <= t <= until):
                continue
            if data.get('checksSkipped') is True:
                integrated_no_checks += 1
                continue
            integrated += 1
            if data.get('checksPassed') is False:
                red += 1
                failing = [c for c in data.get('checks') or [] if c.get('status') != 'passed']
                for c in failing:
                    name = c.get('name')
                    red_by_check[name] = red_by_check.get(name, 0) + 1
                red_kind[classify_red(failing)] += 1
                for j in data.get('jobs', []):
                    red_cost_usd += j.get('costUsd', 0) or 0
    return {
        'integrated': integrated,
        'integrated_no_checks': integrated_no_checks,
        'red': red,
        'red_rate': round(red / integrated, 2) if integrated else None,
        'red_by_check': red_by_check,
        'red_kind': red_kind,
        'red_cost_usd': round(red_cost_usd, 2),
    }

def load_agent_log(path, stale_open_before=None):
    """Yield (start, end_or_None), excluding stale open rows when requested."""
    with open(path) as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                if isinstance(row, dict) and 'event' in row and 'start' not in row:
                    print(f'{path}:{lineno}: warning: skipping agent log event row', file=sys.stderr)
                    continue
                start = ts(row['start'])
                end = ts(row['end']) if row.get('end') else None
            except Exception as exc:
                sys.exit(f'{path}:{lineno}: malformed agent log line: {exc}')
            if end is None and stale_open_before is not None and start < stale_open_before:
                label = str(row.get('label', '<unknown>')).replace('\n', r'\n').replace('\r', r'\r')
                print(f'{path}:{lineno}: warning: ignoring stale open agent row '
                      f'label={label}', file=sys.stderr)
                continue
            yield start, end

_SHIP_TS_KEYS = ('timestamp', 'at', 'ts', 'time')

def ship_record_time(rec, mtime):
    """(datetime, source) for one ship record: its own timestamp field if it has one, else the log file's mtime."""
    for key in _SHIP_TS_KEYS:
        if rec.get(key):
            return ts(rec[key]), 'timestamp'
    return dt.datetime.fromtimestamp(mtime, tz=dt.timezone.utc), 'mtime'

def load_ship_logs(patterns):
    """(records, skipped): records is a list of (dict, file_mtime) for every JSON line across every
    file matched by patterns (globs or plain paths); a malformed or branch-less line is skipped."""
    records = []
    skipped = 0
    for pattern in patterns:
        paths = sorted(glob.glob(os.path.expanduser(pattern)))
        if not paths and os.path.isfile(pattern):
            paths = [pattern]
        for path in paths:
            mtime = os.path.getmtime(path)
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                        rec['branch']
                    except Exception:
                        skipped += 1
                        continue
                    records.append((rec, mtime))
    return records, skipped

def compute_ship(patterns):
    """Ship block (E2): per-branch attempts, refusal codes and minutes to first push."""
    records, skipped = load_ship_logs(patterns)
    by_branch = {}
    for rec, mtime in records:
        by_branch.setdefault(rec['branch'], []).append((rec, mtime))
    branches = []
    for branch in sorted(by_branch):
        timed = sorted((ship_record_time(rec, mtime) + (rec,) for rec, mtime in by_branch[branch]),
                       key=lambda t: t[0])
        refused_codes = {}
        for _, _, rec in timed:
            if rec.get('status') == 'refused':
                code = rec.get('code') or 'unknown'
                refused_codes[code] = refused_codes.get(code, 0) + 1
        first_ts = timed[0][0]
        minutes = source = None
        for t, src, rec in timed:
            status = rec.get('status')
            # a guard-refused attempt never reaches `git push`, even when it already computed a
            # local commit sha to scan; only a non-refused status is evidence the sha was pushed.
            pushed = status in ('held', 'merged') or (status != 'refused' and rec.get('sha'))
            if pushed:
                minutes = round((t - first_ts).total_seconds() / 60, 1)
                source = src
                break
        branches.append({'branch': branch, 'attempts': len(timed), 'refusedCodes': refused_codes,
                          'minutesToFirstPush': minutes, 'minutesToFirstPushSource': source})
    return {'branches': branches, 'skipped': skipped}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until')
    ap.add_argument('--agent-log', action='append', default=[], dest='agent_log')
    ap.add_argument('--rework-only', action='store_true', dest='rework_only')
    ap.add_argument('--ship-logs', action='append', default=[], dest='ship_logs')
    ap.add_argument('--ship-only', action='store_true', dest='ship_only')
    ap.add_argument('roots', nargs='+')
    a = ap.parse_args()
    since = ts(a.since)

    ship_patterns = list(a.ship_logs)
    for root in a.roots:
        ship_patterns.append(os.path.join(os.path.expanduser(root), 'worktrees', '*-ship*.log'))

    if a.ship_only:
        print(json.dumps({'ship': compute_ship(ship_patterns)}))
        return

    if a.rework_only:
        until = ts(a.until) if a.until else dt.datetime.now(dt.timezone.utc)
        print(json.dumps({'rework': compute_rework(a.roots, since, until)}))
        return

    raw = []  # list of (start, end_or_None, source)
    for root in a.roots:
        for s, e in load_swarm_jobs(root):
            raw.append((s, e, 'swarm'))

    agent_logs = list(a.agent_log)
    default_log = 'coordination/agent-tool-jobs.jsonl'
    if not agent_logs and os.path.exists(default_log):
        agent_logs = [default_log]
    stale_open_before = since - dt.timedelta(hours=12)
    for path in agent_logs:
        for s, e in load_agent_log(path, stale_open_before=stale_open_before):
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
                      'gaps': gaps, 'still_running': still_running, 'agent_log_intervals': agent_log_intervals,
                      'rework': compute_rework(a.roots, since, until), 'ship': compute_ship(ship_patterns)}))

if __name__ == '__main__':
    main()
