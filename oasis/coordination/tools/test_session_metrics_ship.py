"""Tests for the ship block (E2, measurement first): swarm ship log files -> per-branch
attempts, refusal codes and minutes to first push. Fake log files, fake branch names.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'session_metrics.py')


def write_ship_log(path, record, mtime=None):
    with open(path, 'w') as f:
        f.write(json.dumps(record) + '\n')
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def run_tool(args, cwd=None):
    with tempfile.NamedTemporaryFile() as empty_log:
        if '--agent-log' not in args:
            args = ['--agent-log', empty_log.name] + args
        return subprocess.run(
            [sys.executable, SCRIPT] + args,
            capture_output=True, text=True, cwd=cwd,
        )


class ShipBlockTests(unittest.TestCase):
    def test_refusals_then_held_counts_attempts_and_minutes_from_mtimes(self):
        with tempfile.TemporaryDirectory() as logdir, tempfile.TemporaryDirectory() as root:
            base = 1_800_000_000
            write_ship_log(os.path.join(logdir, 's1.log'),
                            {'branch': 'fake-batch-z', 'status': 'refused', 'reason': 'x',
                             'code': 'private-name-in-diff', 'timing': {}}, mtime=base)
            write_ship_log(os.path.join(logdir, 's2.log'),
                            {'branch': 'fake-batch-z', 'status': 'refused', 'reason': 'y',
                             'code': 'private-term-in-commit', 'timing': {}}, mtime=base + 300)
            write_ship_log(os.path.join(logdir, 's3.log'),
                            {'branch': 'fake-batch-z', 'status': 'refused', 'reason': 'x again',
                             'code': 'private-name-in-diff', 'timing': {}}, mtime=base + 600)
            write_ship_log(os.path.join(logdir, 's4.log'),
                            {'branch': 'fake-batch-z', 'status': 'held', 'reason': None,
                             'code': None, 'timing': {}}, mtime=base + 900)
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--ship-only',
                '--ship-logs', os.path.join(logdir, '*.log'),
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(set(out.keys()), {'ship'})
            branches = out['ship']['branches']
            self.assertEqual(len(branches), 1)
            b = branches[0]
            self.assertEqual(b['branch'], 'fake-batch-z')
            self.assertEqual(b['attempts'], 4)
            self.assertEqual(b['refusedCodes'], {'private-name-in-diff': 2, 'private-term-in-commit': 1})
            self.assertEqual(b['minutesToFirstPush'], 15.0)
            self.assertEqual(b['minutesToFirstPushSource'], 'mtime')
            self.assertEqual(out['ship']['skipped'], 0)

    def test_merged_first_attempt_is_zero_minutes(self):
        with tempfile.TemporaryDirectory() as logdir, tempfile.TemporaryDirectory() as root:
            write_ship_log(os.path.join(logdir, 's1.log'),
                            {'branch': 'fake-batch-y', 'status': 'merged', 'reason': None,
                             'code': None, 'timing': {}}, mtime=1_800_000_000)
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--ship-only',
                '--ship-logs', os.path.join(logdir, '*.log'),
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            b = json.loads(result.stdout)['ship']['branches'][0]
            self.assertEqual(b['branch'], 'fake-batch-y')
            self.assertEqual(b['attempts'], 1)
            self.assertEqual(b['refusedCodes'], {})
            self.assertEqual(b['minutesToFirstPush'], 0.0)

    def test_garbled_and_branchless_lines_are_skipped_with_a_count(self):
        with tempfile.TemporaryDirectory() as logdir, tempfile.TemporaryDirectory() as root:
            log_path = os.path.join(logdir, 'multi.log')
            with open(log_path, 'w') as f:
                f.write(json.dumps({'branch': 'fake-batch-x', 'status': 'refused',
                                     'code': 'private-name-in-diff', 'timing': {}}) + '\n')
                f.write('{not valid json}\n')
                f.write(json.dumps({'status': 'refused', 'code': 'no-branch-field'}) + '\n')
                f.write('\n')  # blank line: skipped silently, not counted
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--ship-only',
                '--ship-logs', log_path,
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)['ship']
            self.assertEqual(out['skipped'], 2)
            self.assertEqual(len(out['branches']), 1)
            self.assertEqual(out['branches'][0]['attempts'], 1)

    def test_ship_block_present_in_default_output_and_existing_fields_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--until', '2026-01-01T00:10:00Z',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertIn('ship', out)
            self.assertEqual(out['ship'], {'branches': [], 'skipped': 0})
            self.assertIn('rework', out)
            self.assertEqual(out['jobs'], 0)

    def test_worktrees_ship_logs_under_a_root_are_read_automatically(self):
        with tempfile.TemporaryDirectory() as root:
            wt_dir = os.path.join(root, 'worktrees')
            os.makedirs(wt_dir)
            write_ship_log(os.path.join(wt_dir, 'swarm-fake-ship.log'),
                            {'branch': 'fake-batch-auto', 'status': 'merged', 'code': None,
                             'timing': {}}, mtime=1_800_000_000)
            result = run_tool([
                '--since', '2026-01-01T00:00:00Z',
                '--ship-only',
                root,
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            branches = json.loads(result.stdout)['ship']['branches']
            self.assertEqual([b['branch'] for b in branches], ['fake-batch-auto'])


if __name__ == '__main__':
    unittest.main()
