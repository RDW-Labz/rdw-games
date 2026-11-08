"""Tests for session_metrics.py (lesson #112 + Braden 2026-09-26): still-running jobs/runs
must count until --until instead of being dropped, and --agent-log / the default
coordination/agent-tool-jobs.jsonl must make Agent-tool workers visible.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'session_metrics.py')


def write_state(root, run_id, jobs):
    run_dir = os.path.join(root, '.swarm', 'runs', run_id)
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, 'state.json'), 'w') as f:
        json.dump({'jobs': jobs}, f)


def write_run_state(root, run_id, data):
    run_dir = os.path.join(root, '.swarm', 'runs', run_id)
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, 'state.json'), 'w') as f:
        json.dump(data, f)


def run_tool(args, cwd=None, use_default_agent_log=False):
    with tempfile.NamedTemporaryFile() as empty_log:
        if '--agent-log' not in args and not use_default_agent_log:
            args = ['--agent-log', empty_log.name] + args
        return subprocess.run(
            [sys.executable, SCRIPT] + args,
            capture_output=True, text=True, cwd=cwd,
        )


class SessionMetricsTests(unittest.TestCase):
    def test_still_running_job_fills_otherwise_idle_gap(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:10:00Z'},  # no finishedAt: still running
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:20:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['still_running'], 1)
            self.assertEqual(out['idle_min'], 10.0)
            self.assertEqual(out['gaps'], [['00:00Z', '00:10Z', 10.0]])

    def test_refused_job_with_no_finish_is_not_still_running(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:10:00Z', 'status': 'refused'},
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:20:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 0)
            self.assertEqual(out['still_running'], 0)
            self.assertEqual(out['idle_min'], 20.0)
            self.assertEqual(out['parallel_avg'], 0)

    def test_blocked_job_with_no_finish_is_not_still_running(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:10:00Z', 'status': 'blocked'},
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:20:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 0)
            self.assertEqual(out['still_running'], 0)
            self.assertEqual(out['idle_min'], 20.0)

    def test_blocked_job_with_finish_is_also_excluded(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:00:00Z', 'finishedAt': '2026-01-01T00:05:00Z',
                 'status': 'blocked'},
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 0)
            self.assertEqual(out['idle_min'], 10.0)

    def test_normal_running_job_still_counts_as_still_running(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:10:00Z'},  # no status yet: genuinely still running
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:20:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['still_running'], 1)
            self.assertEqual(out['idle_min'], 10.0)
            self.assertEqual(out['parallel_avg'], 1.0)

    def test_job_finished_before_since_contributes_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            write_state(root, 'run1', [
                {'startedAt': '2025-12-31T23:00:00Z', 'finishedAt': '2025-12-31T23:30:00Z'},
            ])
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 0)
            self.assertEqual(out['still_running'], 0)
            self.assertEqual(out['idle_min'], 10.0)

    def test_agent_log_end_null_counts_until_until(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as logdir:
            log_path = os.path.join(logdir, 'agent.jsonl')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'label': 'w1', 'start': '2026-01-01T00:05:00Z', 'end': None}) + '\n')
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:15:00Z',
                '--agent-log', log_path,
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['still_running'], 1)
            self.assertEqual(out['agent_log_intervals'], 1)
            self.assertEqual(out['idle_min'], 5.0)

    def test_agent_log_overlap_with_swarm_job_gives_parallel_2(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as logdir:
            write_state(root, 'run1', [
                {'startedAt': '2026-01-01T00:00:00Z', 'finishedAt': '2026-01-01T00:10:00Z'},
            ])
            log_path = os.path.join(logdir, 'agent.jsonl')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'label': 'w1', 'start': '2026-01-01T00:00:00Z',
                                     'end': '2026-01-01T00:10:00Z'}) + '\n')
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                '--agent-log', log_path,
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 2)
            self.assertEqual(out['agent_log_intervals'], 1)
            self.assertEqual(out['idle_min'], 0.0)
            self.assertEqual(out['parallel_avg'], 2.0)

    def test_agent_log_event_row_is_skipped_with_line_number_warning(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as logdir:
            log_path = os.path.join(logdir, 'agent.jsonl')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'label': 'w1', 'start': '2026-01-01T00:05:00Z',
                                     'end': '2026-01-01T00:10:00Z'}) + '\n')
                f.write(json.dumps({'event': 'completion-observed',
                                     'end': '2026-01-01T00:15:00Z'}) + '\n')
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:15:00Z',
                '--agent-log', log_path,
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['agent_log_intervals'], 1)
            self.assertEqual(out['still_running'], 0)
            self.assertEqual(out['idle_min'], 10.0)
            self.assertEqual(out['parallel_avg'], 1.0)
            self.assertEqual(result.stderr.splitlines(), [
                f'{log_path}:2: warning: skipping agent log event row',
            ])

    def test_malformed_agent_log_line_fails_with_line_number(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as logdir:
            log_path = os.path.join(logdir, 'agent.jsonl')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'label': 'ok', 'start': '2026-01-01T00:00:00Z', 'end': None}) + '\n')
                f.write('{not valid json}\n')
                f.write('\n')  # blank line must be skipped, not counted as the error
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                '--agent-log', log_path,
                root,
            ])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(':2:', result.stderr)

    def test_default_agent_log_picked_up_from_cwd(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as workdir:
            os.makedirs(os.path.join(workdir, 'coordination'))
            default_log = os.path.join(workdir, 'coordination', 'agent-tool-jobs.jsonl')
            with open(default_log, 'w') as f:
                f.write(json.dumps({'label': 'w1', 'start': '2026-01-01T00:05:00Z', 'end': None}) + '\n')
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:15:00Z',
                root,
            ], cwd=workdir, use_default_agent_log=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['agent_log_intervals'], 1)
            self.assertEqual(out['still_running'], 1)
            self.assertEqual(out['idle_min'], 5.0)

    def test_stale_open_agent_log_row_is_ignored_with_warning(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as logdir:
            log_path = os.path.join(logdir, 'agent.jsonl')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'label': 'stale-worker', 'start': '2025-12-31T23:59:00Z',
                                    'end': None}) + '\n')
                f.write(json.dumps({'label': 'fresh-worker', 'start': '2026-01-01T12:05:00Z',
                                    'end': None}) + '\n')
            result = run_tool([
                '--since', '2026-01-01T12:00:00Z',
                '--until', '2026-01-01T12:15:00Z',
                '--agent-log', log_path,
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['still_running'], 1)
            self.assertEqual(out['agent_log_intervals'], 1)
            self.assertEqual(out['idle_min'], 5.0)
            self.assertEqual(len(result.stderr.splitlines()), 1)
            self.assertIn('stale-worker', result.stderr)

    def test_rework_only_counts_green_red_lint_red_tests_skipped_and_window(self):
        with tempfile.TemporaryDirectory() as root:
            write_run_state(root, 'green', {
                'integratedAt': '2026-01-01T00:05:00Z',
                'checksPassed': True,
                'checks': [{'name': 'pytest', 'status': 'passed'}],
            })
            write_run_state(root, 'red-lint', {
                'integratedAt': '2026-01-01T00:06:00Z',
                'checksPassed': False,
                'checks': [{'name': 'ruff', 'status': 'failed', 'tail': 'E501 line too long'}],
                'jobs': [{'costUsd': 0.0}],
            })
            write_run_state(root, 'red-tests', {
                'integratedAt': '2026-01-01T00:07:00Z',
                'checksPassed': False,
                'checks': [{'name': 'pytest', 'status': 'failed', 'tail': 'AssertionError: boom'}],
                'jobs': [{'costUsd': 1.5}, {'costUsd': 0.25}],
            })
            write_run_state(root, 'skipped', {
                'integratedAt': '2026-01-01T00:08:00Z',
                'checksSkipped': True,
            })
            write_run_state(root, 'outside-window', {
                'integratedAt': '2026-01-02T00:00:00Z',
                'checksPassed': False,
                'checks': [{'name': 'pytest', 'status': 'failed', 'tail': 'boom'}],
            })
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T01:00:00Z',
                '--rework-only',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(set(out.keys()), {'rework'})
            rework = out['rework']
            self.assertEqual(rework['integrated'], 3)
            self.assertEqual(rework['integrated_no_checks'], 1)
            self.assertEqual(rework['red'], 2)
            self.assertEqual(rework['red_rate'], round(2 / 3, 2))
            self.assertEqual(rework['red_by_check'], {'ruff': 1, 'pytest': 1})
            self.assertEqual(rework['red_kind'],
                              {'tests': 1, 'lint': 1, 'types': 0, 'timeout': 0, 'env': 0})
            self.assertEqual(rework['red_cost_usd'], 1.75)

    def test_rework_red_rate_is_null_when_nothing_integrated(self):
        with tempfile.TemporaryDirectory() as root:
            write_run_state(root, 'skipped-only', {
                'integratedAt': '2026-01-01T00:05:00Z',
                'checksSkipped': True,
            })
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T01:00:00Z',
                '--rework-only',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            rework = json.loads(result.stdout)['rework']
            self.assertEqual(rework['integrated'], 0)
            self.assertEqual(rework['integrated_no_checks'], 1)
            self.assertIsNone(rework['red_rate'])

    def test_rework_env_beats_timeout_and_mixed_check_names_fall_back_to_tests(self):
        with tempfile.TemporaryDirectory() as root:
            write_run_state(root, 'red-env', {
                'integratedAt': '2026-01-01T00:05:00Z',
                'checksPassed': False,
                'checks': [
                    {'name': 'pytest', 'status': 'failed', 'tail': 'ModuleNotFoundError: no foo'},
                    {'name': 'mypy', 'status': 'failed', 'tail': 'connection timed out'},
                ],
            })
            write_run_state(root, 'red-mixed', {
                'integratedAt': '2026-01-01T00:06:00Z',
                'checksPassed': False,
                'checks': [
                    {'name': 'ruff', 'status': 'failed', 'tail': 'E501'},
                    {'name': 'pytest', 'status': 'failed', 'tail': 'AssertionError'},
                ],
            })
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T01:00:00Z',
                '--rework-only',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            rework = json.loads(result.stdout)['rework']
            self.assertEqual(rework['red'], 2)
            self.assertEqual(rework['red_kind'],
                              {'tests': 1, 'lint': 0, 'types': 0, 'timeout': 0, 'env': 1})

    def test_rework_key_present_in_default_output_alongside_existing_fields(self):
        with tempfile.TemporaryDirectory() as root:
            write_run_state(root, 'run1', {
                'jobs': [{'startedAt': '2026-01-01T00:00:00Z', 'finishedAt': '2026-01-01T00:05:00Z'}],
                'integratedAt': '2026-01-01T00:05:00Z',
                'checksPassed': False,
                'checks': [{'name': 'ruff', 'status': 'failed', 'tail': 'lint error'}],
            })
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out['jobs'], 1)
            self.assertEqual(out['rework']['integrated'], 1)
            self.assertEqual(out['rework']['red'], 1)
            self.assertEqual(out['rework']['red_kind']['lint'], 1)


if __name__ == '__main__':
    unittest.main()
