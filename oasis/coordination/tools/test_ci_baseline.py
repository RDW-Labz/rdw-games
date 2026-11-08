"""Tests for ci_baseline.py (T51 item 1: measure first).

collect() takes a `fetch` parameter, so these tests replace gh_json with a fake reader over
coordination/tools/fixtures/ci_baseline_gh.json (keyed by the gh args, space-joined) instead of
shelling out to `gh`. No live gh calls happen here.
"""
import datetime as dt
import json
import os
import sys
import unittest

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)
import ci_baseline  # noqa: E402

FIXTURE_PATH = os.path.join(TOOLS_DIR, 'fixtures', 'ci_baseline_gh.json')


def load_fixture():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def make_fetch(fixture):
    def fetch(args):
        key = ' '.join(args)
        if key not in fixture:
            raise RuntimeError(f'gh: repository not found\nstderr: no fixture for: {key}')
        return fixture[key]
    return fetch


SINCE = '2026-01-01'
SINCE_DT = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
UNTIL_DT = dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc)


class MedianP90Tests(unittest.TestCase):
    def test_median_odd_count_is_true_middle(self):
        self.assertEqual(ci_baseline.median([90, 120, 180, 240, 300]), 180)

    def test_median_even_count_uses_nearest_rank(self):
        self.assertEqual(ci_baseline.median([60, 70, 80, 100]), 70)

    def test_p90_nearest_rank(self):
        self.assertEqual(ci_baseline.p90([90, 120, 180, 240, 300]), 300)

    def test_empty_list_is_none(self):
        self.assertIsNone(ci_baseline.median([]))
        self.assertIsNone(ci_baseline.p90([]))


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.fetch = make_fetch(load_fixture())

    def test_run_median_and_p90(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch)
        repo = out['demo-repo']
        self.assertEqual(repo['runs'], 5)  # in_progress run 1006 excluded
        self.assertEqual(repo['runMedianS'], 180)
        self.assertEqual(repo['runP90S'], 300)

    def test_by_event_split(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch)
        by_event = out['demo-repo']['byEvent']
        self.assertEqual(by_event['push'], {'runs': 3, 'medianS': 180})
        self.assertEqual(by_event['pull_request'], {'runs': 2, 'medianS': 90})

    def test_skipped_and_null_time_jobs_excluded(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch)
        jobs = out['demo-repo']['jobs']
        # build has a null-time job (run 1003) excluded -> 4 counted, not 5
        self.assertEqual(jobs['build']['n'], 4)
        self.assertEqual(jobs['build']['medianS'], 70)
        self.assertEqual(jobs['build']['p90S'], 100)
        # test has a conclusion=="skipped" job (run 1004) excluded -> 3 counted, not 4
        self.assertEqual(jobs['test']['n'], 3)
        self.assertEqual(jobs['test']['medianS'], 100)

    def test_fail_rate(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch)
        jobs = out['demo-repo']['jobs']
        self.assertEqual(jobs['build']['failRate'], 0.0)
        self.assertEqual(jobs['test']['failRate'], round(1 / 3, 2))
        self.assertEqual(jobs['lint']['failRate'], 0.0)

    def test_pr_wall_median_only_counts_merged_in_window(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch)
        # merged before since, merged after until, and never-merged PRs are all excluded;
        # only the two merged inside [since, until] (5h and 3h wall time) count -> median = 3h = 10800s
        self.assertEqual(out['demo-repo']['prWallMedianS'], 10800)

    def test_one_repo_erroring_does_not_stop_others(self):
        out = ci_baseline.collect('demo-owner', ['demo-repo', 'broken-repo'], SINCE, SINCE_DT, UNTIL_DT,
                                   fetch=self.fetch)
        self.assertEqual(out['broken-repo'], {'error': 'gh: repository not found'})
        self.assertEqual(out['demo-repo']['runs'], 5)
        self.assertNotIn('error', out['demo-repo'])

    def test_paginated_runs_merges_multiple_pages(self):
        fixture = load_fixture()
        fixture['api --paginate --slurp repos/demo-owner/multi-repo/actions/runs?created=>=2026-01-01&per_page=100'] = [
            {
                "workflow_runs": [
                    {"id": 2001, "status": "completed", "event": "push",
                     "run_started_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:01:00Z",
                     "created_at": "2026-01-01T00:00:00Z"}
                ]
            },
            {
                "workflow_runs": [
                    {"id": 2002, "status": "completed", "event": "push",
                     "run_started_at": "2026-01-01T01:00:00Z", "updated_at": "2026-01-01T01:01:00Z",
                     "created_at": "2026-01-01T01:00:00Z"}
                ]
            }
        ]
        fixture['api --paginate --slurp repos/demo-owner/multi-repo/pulls?state=closed&per_page=100'] = [[]]
        fixture['api repos/demo-owner/multi-repo/actions/runs/2001/jobs?per_page=100'] = {"jobs": []}
        fixture['api repos/demo-owner/multi-repo/actions/runs/2002/jobs?per_page=100'] = {"jobs": []}
        fetch = make_fetch(fixture)
        out = ci_baseline.collect('demo-owner', ['multi-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=fetch)
        self.assertEqual(out['multi-repo']['runs'], 2)

    def test_paginated_calls_include_slurp_flag(self):
        fixture = load_fixture()
        called_args = []
        def tracking_fetch(args):
            called_args.append(' '.join(args))
            return fixture[' '.join(args)]
        ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=tracking_fetch)
        slurp_calls = [call for call in called_args if '--slurp' in call]
        self.assertGreater(len(slurp_calls), 0)
        for call in slurp_calls:
            self.assertIn('--paginate', call)


class RowFormatTests(unittest.TestCase):
    def test_row_format_for_full_entry(self):
        fetch = make_fetch(load_fixture())
        out = ci_baseline.collect('demo-owner', ['demo-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=fetch)
        row = ci_baseline.format_row('2026-01-01', 'demo-repo', out['demo-repo'])
        self.assertEqual(
            row,
            '| 2026-01-01 | demo-repo | 5 | 3m 0s | 5m 0s | test (1m 40s) | test (0.50, 2) | 0.17 | 180m 0s |',
        )

    def test_row_format_for_errored_repo(self):
        row = ci_baseline.format_row('2026-01-01', 'broken-repo', {'error': 'gh: boom'})
        self.assertEqual(row, '| 2026-01-01 | broken-repo | - | - | - | - | - | - | - |')


class FlakeMetricsTests(unittest.TestCase):
    """T51a (decision #243): flake vs. work-in-progress red, using the flake-repo fixture."""

    def setUp(self):
        self.fetch = make_fetch(load_fixture())
        self.jobs = ci_baseline.collect(
            'demo-owner', ['flake-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch
        )['flake-repo']['jobs']
        self.quarantine = ci_baseline.collect(
            'demo-owner', ['flake-repo'], SINCE, SINCE_DT, UNTIL_DT, fetch=self.fetch
        )['flake-repo']['quarantineCandidates']

    def test_failure_on_main_commit_counts(self):
        # mainFlake: fails on sha-main-A (push/main), then passes on the same sha on a rerun.
        job = self.jobs['mainFlake']
        self.assertEqual(job['countedRuns'], 2)
        self.assertEqual(job['flakeRate'], 0.5)

    def test_failure_on_pr_final_pushed_commit_counts(self):
        # prFinalFlake fails on sha-pr10-final, which is PR #10's final (merged) head sha.
        job = self.jobs['prFinalFlake']
        self.assertEqual(job['countedRuns'], 1)
        self.assertEqual(job['flakeRate'], 1.0)

    def test_failure_on_earlier_pr_commit_is_wip_red_only(self):
        # prWipOnly passes on main (sha-main-B) and fails on sha-pr11-A, an earlier commit of
        # PR #11 (whose final head sha is sha-pr11-B) -> WIP red only, not a flake.
        job = self.jobs['prWipOnly']
        self.assertEqual(job['flakeRate'], 0.0)
        self.assertGreater(job['wipRedRate'], 0)

    def test_job_failing_only_on_earlier_pr_commits_is_not_a_candidate(self):
        # onlyWip fails on sha-pr12-A1 and sha-pr12-A2, both earlier than PR #12's final
        # sha-pr12-B -> zero counted runs, never a quarantine candidate.
        job = self.jobs['onlyWip']
        self.assertIsNone(job['flakeRate'])
        self.assertNotIn('onlyWip', self.quarantine)

    def test_same_sha_failed_then_passed_on_main_is_a_candidate(self):
        self.assertIn('mainFlake', self.quarantine)


if __name__ == '__main__':
    unittest.main()
