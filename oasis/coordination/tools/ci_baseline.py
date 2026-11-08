"""CI baseline for coordination/swarm-metrics.md, "CI baseline (T51)" (item 1: measure first).

Usage: python3 coordination/tools/ci_baseline.py --since YYYY-MM-DD [--until YYYY-MM-DD]
       [--owner RDW-Labz] [--repos a,b,...] [--out FILE.json] [--row]

Pulls, per repo: `gh api --paginate repos/{owner}/{repo}/actions/runs?created=>=SINCE&per_page=100`,
then for each completed run `gh api repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100`.
All gh calls go through gh_json(args); collect() takes a `fetch` parameter so tests can replace it
with a fixture-backed fake instead of shelling out.

Run seconds = updated_at - run_started_at (created_at if run_started_at is missing). Job seconds =
completed_at - started_at; jobs with a null start/end time or conclusion "skipped" are excluded.
Medians/p90 use nearest-rank on the sorted values; an empty list gives None (-> JSON null).

prWallMedianS is the median, over PRs merged inside [since, until], of merged_at - created_at, from
`gh api --paginate repos/{o}/{r}/pulls?state=closed&per_page=100`.

Flake vs. work-in-progress red (decision #243): a run's head_sha counts when it is a main commit
(head_branch == "main", whether via a push event or otherwise) or equals a closed PR's final head
SHA (recorded from the same pulls listing, for merged AND closed-unmerged PRs alike). Every other
failed (or passed) run on a PR branch is work-in-progress and is reported separately. Per job:
flakeRate = counted failures / counted runs (null if 0 counted runs), wipRedRate = WIP failures /
WIP runs (null if 0 WIP runs), plus countedRuns and wipRuns; failRate is unchanged. A failure is a
conclusion of "failure" or "timed_out"; cancelled/skipped runs count toward neither rate. A repo's
quarantineCandidates lists jobs with flakeRate > 0 where a counted failure on a main commit or a
MERGED PR's final SHA shares a head_sha with a passing run of the same job (a real flake); a job
that only ever failed on earlier PR commits is never a candidate. Each repo also reports an overall
flakeRate (counted failures / counted runs across all its jobs).

If a repo's gh calls fail, its entry becomes {"error": "<first line of the exception>"} and the
other repos are still collected; the process exits 1 only if every repo errored.
"""
import argparse, datetime as dt, json, math, subprocess, sys

DEFAULT_OWNER = 'RDW-Labz'
DEFAULT_REPOS = ['agent-core', 'remote', 'skills', 'connectors', 'rag-pipeline', 'playbooks',
                  'desktop-app', 'agent-amber', 'agent-michael', 'project-swarm']

def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))

def parse_date(s):
    return dt.datetime.strptime(s, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc)

def nearest_rank(vals, p):
    """Nearest-rank percentile over ints; None for an empty list."""
    if not vals:
        return None
    s = sorted(vals)
    rank = max(1, math.ceil(p * len(s)))
    return s[min(rank, len(s)) - 1]

def median(vals):
    return nearest_rank(vals, 0.5)

def p90(vals):
    return nearest_rank(vals, 0.9)

def gh_json(args):
    """Default fetch: run `gh` and parse its JSON stdout. Tests inject a fake instead."""
    result = subprocess.run(['gh'] + args, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)

FAIL_CONCLUSIONS = {'failure', 'timed_out'}

def is_main_commit(run):
    """True if this run's head commit is on main (a push run on main, or head_branch == "main")."""
    branch = run.get('head_branch')
    return branch == 'main' or (run.get('event') == 'push' and branch == 'main')

def collect(owner, repos, since, since_dt, until_dt, fetch=gh_json):
    """repo -> baseline stats dict (or {"error": ...}) for the [since_dt, until_dt] window."""
    out = {}
    for repo in repos:
        try:
            runs_resp = fetch(['api', '--paginate', '--slurp',
                                f'repos/{owner}/{repo}/actions/runs?created=>={since}&per_page=100'])
            all_runs = []
            for page in runs_resp:
                all_runs.extend(page.get('workflow_runs', []))

            pulls_resp = fetch(['api', '--paginate', '--slurp', f'repos/{owner}/{repo}/pulls?state=closed&per_page=100'])
            all_pulls = []
            for page in pulls_resp:
                all_pulls.extend(page)
            merged_final_shas = {pr['head']['sha'] for pr in all_pulls
                                  if pr.get('merged_at') and pr.get('head', {}).get('sha')}
            all_final_shas = {pr['head']['sha'] for pr in all_pulls if pr.get('head', {}).get('sha')}

            run_seconds = []
            event_seconds = {}
            job_data = {}
            for run in all_runs:
                if run.get('status') != 'completed':
                    continue
                start = run.get('run_started_at') or run['created_at']
                sec = int((ts(run['updated_at']) - ts(start)).total_seconds())
                run_seconds.append(sec)
                event_seconds.setdefault(run.get('event', 'unknown'), []).append(sec)

                head_sha = run.get('head_sha')
                main_commit = is_main_commit(run)
                counted = main_commit or (head_sha is not None and head_sha in all_final_shas)
                on_main_or_merged_final = main_commit or (head_sha is not None and head_sha in merged_final_shas)

                jobs_resp = fetch(['api', f"repos/{owner}/{repo}/actions/runs/{run['id']}/jobs?per_page=100"])
                for job in jobs_resp.get('jobs', []):
                    if job.get('conclusion') == 'skipped':
                        continue
                    started, completed = job.get('started_at'), job.get('completed_at')
                    if not started or not completed:
                        continue
                    jsec = int((ts(completed) - ts(started)).total_seconds())
                    job_data.setdefault(job.get('name', 'unknown'), []).append({
                        'sec': jsec, 'conclusion': job.get('conclusion'), 'headSha': head_sha,
                        'counted': counted, 'onMainOrMergedFinal': on_main_or_merged_final,
                    })

            by_event = {event: {'runs': len(secs), 'medianS': median(secs)}
                        for event, secs in event_seconds.items()}

            jobs_out = {}
            quarantine = []
            repo_counted_runs = 0
            repo_counted_fails = 0
            for name, items in job_data.items():
                secs = [it['sec'] for it in items]
                n = len(items)
                fails = sum(1 for it in items if it['conclusion'] == 'failure')

                rateable = [it for it in items if it['conclusion'] != 'cancelled']
                counted_items = [it for it in rateable if it['counted']]
                wip_items = [it for it in rateable if not it['counted']]
                counted_runs = len(counted_items)
                wip_runs = len(wip_items)
                counted_fails = sum(1 for it in counted_items if it['conclusion'] in FAIL_CONCLUSIONS)
                wip_fails = sum(1 for it in wip_items if it['conclusion'] in FAIL_CONCLUSIONS)
                flake_rate = round(counted_fails / counted_runs, 2) if counted_runs else None
                wip_red_rate = round(wip_fails / wip_runs, 2) if wip_runs else None

                repo_counted_runs += counted_runs
                repo_counted_fails += counted_fails

                jobs_out[name] = {'n': n, 'medianS': median(secs), 'p90S': p90(secs),
                                   'failRate': round(fails / n, 2) if n else None,
                                   'flakeRate': flake_rate, 'wipRedRate': wip_red_rate,
                                   'countedRuns': counted_runs, 'wipRuns': wip_runs}

                if flake_rate is not None and flake_rate > 0:
                    failed_on_main_or_merged = {it['headSha'] for it in counted_items
                                                 if it['onMainOrMergedFinal'] and it['conclusion'] in FAIL_CONCLUSIONS}
                    passed_shas = {it['headSha'] for it in items if it['conclusion'] == 'success'}
                    if failed_on_main_or_merged & passed_shas:
                        quarantine.append(name)

            repo_flake_rate = round(repo_counted_fails / repo_counted_runs, 2) if repo_counted_runs else None

            pr_wall = []
            for pr in all_pulls:
                merged_at = pr.get('merged_at')
                if not merged_at:
                    continue
                merged = ts(merged_at)
                if since_dt <= merged <= until_dt:
                    pr_wall.append(int((merged - ts(pr['created_at'])).total_seconds()))

            out[repo] = {
                'runs': len(run_seconds),
                'runMedianS': median(run_seconds),
                'runP90S': p90(run_seconds),
                'byEvent': by_event,
                'jobs': jobs_out,
                'prWallMedianS': median(pr_wall),
                'flakeRate': repo_flake_rate,
                'quarantineCandidates': sorted(quarantine),
            }
        except Exception as exc:
            out[repo] = {'error': str(exc).splitlines()[0] if str(exc) else repr(exc)}
    return out

def format_duration(seconds):
    if seconds is None:
        return '-'
    m, s = divmod(int(seconds), 60)
    return f'{m}m {s}s'

def slowest_job(jobs):
    if not jobs:
        return '-'
    name, stats = max(jobs.items(), key=lambda kv: (kv[1]['medianS'] is not None, kv[1]['medianS'] or -1))
    return f"{name} ({format_duration(stats['medianS'])})"

def format_rate(rate):
    return '—' if rate is None else f'{rate:.2f}'

def flakiest_job(jobs):
    candidates = [(name, stats) for name, stats in jobs.items() if stats.get('countedRuns')]
    if not candidates:
        return '—'
    name, stats = max(candidates, key=lambda kv: kv[1]['flakeRate'] or 0)
    return f"{name} ({format_rate(stats['flakeRate'])}, {stats['countedRuns']})"

def format_row(week, repo, entry):
    """One markdown table row for the "CI baseline (T51)" table in swarm-metrics.md."""
    if 'error' in entry:
        return f'| {week} | {repo} | - | - | - | - | - | - | - |'
    return (f"| {week} | {repo} | {entry['runs']} | {format_duration(entry['runMedianS'])} | "
            f"{format_duration(entry['runP90S'])} | {slowest_job(entry['jobs'])} | "
            f"{flakiest_job(entry['jobs'])} | {format_rate(entry.get('flakeRate'))} | "
            f"{format_duration(entry['prWallMedianS'])} |")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until')
    ap.add_argument('--owner', default=DEFAULT_OWNER)
    ap.add_argument('--repos')
    ap.add_argument('--out')
    ap.add_argument('--row', action='store_true')
    a = ap.parse_args()

    repos = a.repos.split(',') if a.repos else DEFAULT_REPOS
    since_dt = parse_date(a.since)
    until_dt = parse_date(a.until) if a.until else dt.datetime.now(dt.timezone.utc)

    repos_out = collect(a.owner, repos, a.since, since_dt, until_dt)
    result = {
        'since': a.since,
        'until': a.until or until_dt.strftime('%Y-%m-%d'),
        'generated': dt.datetime.now(dt.timezone.utc).isoformat(),
        'repos': repos_out,
    }

    if a.out:
        with open(a.out, 'w') as f:
            json.dump(result, f, indent=2)
    elif not a.row:
        print(json.dumps(result, indent=2))

    if a.row:
        for repo in repos:
            print(format_row(a.since, repo, repos_out.get(repo, {'error': 'missing'})))

    if repos and all('error' in repos_out.get(r, {}) for r in repos):
        sys.exit(1)

if __name__ == '__main__':
    main()
