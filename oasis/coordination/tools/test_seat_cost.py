#!/usr/bin/env python3
"""Tests for seat_cost.py"""
import json
import tempfile
import unittest
from pathlib import Path

import seat_cost


class TestLoadUsage(unittest.TestCase):
    """Test load_usage() deduplication and filtering."""

    def test_dedupe_by_id_keeps_last(self):
        """Same message id with different usage keeps last."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 50}}})
                + "\n"
                + json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:01Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 75}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl)))
            self.assertEqual(len(usage), 1)
            self.assertEqual(usage[0]["input"], 200)
            self.assertEqual(usage[0]["output"], 75)

    def test_skip_synthetic_model(self):
        """Messages with model '<synthetic>' are skipped."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "<synthetic>", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 50}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl)))
            self.assertEqual(len(usage), 0)

    def test_skip_non_assistant(self):
        """Non-assistant messages are skipped."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "user", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 50}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl)))
            self.assertEqual(len(usage), 0)

    def test_skip_missing_usage(self):
        """Messages without usage field are skipped."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5"}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl)))
            self.assertEqual(len(usage), 0)

    def test_timestamp_filter_since(self):
        """--since timestamp filters out earlier messages."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 50}}})
                + "\n"
                + json.dumps({"type": "assistant", "timestamp": "2026-01-01T11:00:00Z", "message": {"id": "msg_2", "model": "claude-opus-5-5", "usage": {"input_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 75}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl), since="2026-01-01T10:30:00Z"))
            self.assertEqual(len(usage), 1)
            self.assertEqual(usage[0]["input"], 200)

    def test_timestamp_filter_until(self):
        """--until timestamp filters out later messages."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 50}}})
                + "\n"
                + json.dumps({"type": "assistant", "timestamp": "2026-01-01T11:00:00Z", "message": {"id": "msg_2", "model": "claude-opus-5-5", "usage": {"input_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 75}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl), until="2026-01-01T10:30:00Z"))
            self.assertEqual(len(usage), 1)
            self.assertEqual(usage[0]["input"], 100)

    def test_cache_tokens_preserved(self):
        """Cache creation and cache read tokens are preserved."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            jsonl = Path(tmp_dir) / "test.jsonl"
            jsonl.write_text(
                json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:00Z", "message": {"id": "msg_1", "model": "claude-opus-5-5", "usage": {"input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 2000, "output_tokens": 50}}})
                + "\n"
            )
            usage = list(seat_cost.load_usage(str(jsonl)))
            self.assertEqual(len(usage), 1)
            self.assertEqual(usage[0]["input"], 10)
            self.assertEqual(usage[0]["cache_write"], 1000)
            self.assertEqual(usage[0]["cache_read"], 2000)
            self.assertEqual(usage[0]["output"], 50)


class TestComputeCosts(unittest.TestCase):
    """Test cost computation."""

    def test_single_model_cost(self):
        """Cost calculation for single model."""
        usage = [
            {"model": "claude-opus-5-5", "input": 1_000_000, "cache_write": 0, "cache_read": 0, "output": 1_000_000},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertEqual(models["claude-opus-5-5"]["input"], 1_000_000)
        self.assertEqual(models["claude-opus-5-5"]["output"], 1_000_000)
        self.assertEqual(models["claude-opus-5-5"]["usd"], 24.00)  # 4.00 + 20.00
        self.assertEqual(total, 24.00)
        self.assertEqual(unpriced, [])

    def test_cache_write_cost(self):
        """Cache write tokens are priced correctly."""
        usage = [
            {"model": "claude-opus-5-5", "input": 0, "cache_write": 1_000_000, "cache_read": 0, "output": 0},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertEqual(models["claude-opus-5-5"]["usd"], 5.00)
        self.assertEqual(total, 5.00)

    def test_cache_read_cost(self):
        """Cache read tokens are priced correctly."""
        usage = [
            {"model": "claude-opus-5-5", "input": 0, "cache_write": 0, "cache_read": 1_000_000, "output": 0},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertEqual(models["claude-opus-5-5"]["usd"], 0.20)
        self.assertEqual(total, 0.20)

    def test_two_models_separate_pricing(self):
        """Two models each use their own price table."""
        usage = [
            {"model": "claude-opus-5-5", "input": 1_000_000, "cache_write": 0, "cache_read": 0, "output": 0},
            {"model": "claude-haiku-4-5", "input": 1_000_000, "cache_write": 0, "cache_read": 0, "output": 0},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertEqual(models["claude-opus-5-5"]["usd"], 4.00)
        self.assertEqual(models["claude-haiku-4-5"]["usd"], 1.00)
        self.assertEqual(total, 5.00)

    def test_unknown_model_unpriced(self):
        """Unknown models are listed as unpriced with None usd."""
        usage = [
            {"model": "claude-unknown", "input": 100, "cache_write": 0, "cache_read": 0, "output": 50},
            {"model": "claude-opus-5-5", "input": 100, "cache_write": 0, "cache_read": 0, "output": 50},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertIsNone(models["claude-unknown"]["usd"])
        self.assertIsNotNone(models["claude-opus-5-5"]["usd"])
        self.assertIn("claude-unknown", unpriced)
        self.assertEqual(total, 0.0)  # Only opus-5-5 counts toward total, rounds to 0.00

    def test_message_count(self):
        """Message count is aggregated by model."""
        usage = [
            {"model": "claude-opus-5-5", "input": 100, "cache_write": 0, "cache_read": 0, "output": 50},
            {"model": "claude-opus-5-5", "input": 200, "cache_write": 0, "cache_read": 0, "output": 75},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertEqual(models["claude-opus-5-5"]["messages"], 2)


class TestFormatTextOutput(unittest.TestCase):
    """Test text output formatting."""

    def test_text_output_single_model(self):
        """Text output format for single model."""
        models = {
            "claude-opus-5-5": {
                "messages": 1,
                "input": 100,
                "cache_write": 0,
                "cache_read": 0,
                "output": 50,
                "usd": 0.12,
                "cache_write_assumed": False,
            }
        }
        output = seat_cost.format_text_output(models, 0.12)
        lines = output.split("\n")
        self.assertIn("claude-opus-5-5", lines[0])
        self.assertIn("1", lines[0])  # messages
        self.assertIn("100", lines[0])  # input
        self.assertIn("50", lines[0])  # output
        self.assertIn("$", lines[0])
        self.assertIn("TOTAL", lines[1])

    def test_text_output_unpriced(self):
        """Text output includes unpriced models without cost."""
        models = {
            "claude-unknown": {
                "messages": 1,
                "input": 100,
                "cache_write": 0,
                "cache_read": 0,
                "output": 50,
                "usd": None,
            }
        }
        output = seat_cost.format_text_output(models, 0.0)
        self.assertIn("claude-unknown", output)
        self.assertIn("-", output)  # No price marker


class TestFormatJsonOutput(unittest.TestCase):
    """Test JSON output formatting."""

    def test_json_output_structure(self):
        """JSON output has correct structure."""
        models = {
            "claude-opus-5-5": {
                "messages": 1,
                "input": 100,
                "cache_write": 0,
                "cache_read": 0,
                "output": 50,
                "usd": 0.12,
                "cache_write_assumed": False,
            }
        }
        output = seat_cost.format_json_output(models, 0.12, [])
        data = json.loads(output)
        self.assertIn("models", data)
        self.assertIn("total_usd", data)
        self.assertIn("unpriced", data)
        self.assertEqual(data["total_usd"], 0.12)
        self.assertEqual(data["models"]["claude-opus-5-5"]["usd"], 0.12)

    def test_json_output_unpriced_excluded(self):
        """JSON output excludes unpriced models from models dict."""
        models = {
            "claude-opus-5-5": {
                "messages": 1,
                "input": 100,
                "cache_write": 0,
                "cache_read": 0,
                "output": 50,
                "usd": 0.12,
                "cache_write_assumed": False,
            },
            "claude-unknown": {
                "messages": 1,
                "input": 100,
                "cache_write": 0,
                "cache_read": 0,
                "output": 50,
                "usd": None,
            },
        }
        output = seat_cost.format_json_output(models, 0.12, ["claude-unknown"])
        data = json.loads(output)
        self.assertIn("claude-opus-5-5", data["models"])
        self.assertNotIn("claude-unknown", data["models"])
        self.assertIn("claude-unknown", data["unpriced"])


class TestFixture(unittest.TestCase):
    """Test with actual fixture file."""

    def test_fixture_load(self):
        """Load and parse the sample fixture."""
        fixture = Path("fixtures/seat_usage_sample.jsonl")
        if not fixture.exists():
            self.skipTest("Fixture not found")

        usage = list(seat_cost.load_usage(str(fixture)))
        self.assertGreater(len(usage), 0)
        self.assertTrue(all(u["model"] == "claude-opus-5-5" for u in usage))
        self.assertTrue(all(u["input"] > 0 or u["cache_write"] > 0 for u in usage))

    def test_fixture_costs(self):
        """Compute costs from fixture."""
        fixture = Path("fixtures/seat_usage_sample.jsonl")
        if not fixture.exists():
            self.skipTest("Fixture not found")

        usage = list(seat_cost.load_usage(str(fixture)))
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertGreater(len(models), 0)
        self.assertGreaterEqual(total, 0)
        self.assertIn("claude-opus-5-5", models)


class TestCacheWriteAssumed(unittest.TestCase):
    """Test cache_write_assumed flag."""

    def test_claude_fable_cache_write_assumed(self):
        """claude-fable-5-1 has cache_write_assumed=True."""
        usage = [
            {"model": "claude-fable-5-1", "input": 100, "cache_write": 100, "cache_read": 0, "output": 50},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertTrue(models["claude-fable-5-1"]["cache_write_assumed"])

    def test_claude_opus_cache_write_not_assumed(self):
        """claude-opus-5-5 has cache_write_assumed=False."""
        usage = [
            {"model": "claude-opus-5-5", "input": 100, "cache_write": 100, "cache_read": 0, "output": 50},
        ]
        models, total, unpriced = seat_cost.compute_costs(usage)
        self.assertFalse(models["claude-opus-5-5"]["cache_write_assumed"])


if __name__ == "__main__":
    unittest.main()
