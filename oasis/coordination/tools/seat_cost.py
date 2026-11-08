#!/usr/bin/env python3
"""Estimate orchestrator seat cost from Claude Code session transcript JSONL.

Usage: python3 coordination/tools/seat_cost.py <transcript.jsonl> [--since ISO] [--until ISO] [--json]
"""
import argparse
import datetime as dt
import json
import sys


PRICES = {
    "claude-opus-5-5": {
        "input": 4.00,
        "output": 20.00,
        "cache_write": 5.00,
        "cache_read": 0.20,
        "cache_write_assumed": False,
    },
    "claude-fable-5-1": {
        "input": 10.00,
        "output": 50.00,
        "cache_write": 12.50,
        "cache_read": 0.25,
        "cache_write_assumed": True,
    },
    "claude-opus-5": {
        "input": 5.00,
        "output": 25.00,
        "cache_write": 6.25,
        "cache_read": 0.50,
        "cache_write_assumed": False,
    },
    "claude-sonnet-5": {
        "input": 2.00,
        "output": 10.00,
        "cache_write": 2.50,
        "cache_read": 0.20,
        "cache_write_assumed": False,
    },
    "claude-haiku-4-5": {
        "input": 1.00,
        "output": 5.00,
        "cache_write": 1.25,
        "cache_read": 0.10,
        "cache_write_assumed": False,
    },
}


def ts(s):
    """Parse ISO 8601 timestamp."""
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_usage(path, since=None, until=None):
    """Yield {model, input, cache_write, cache_read, output} for each unique message id.

    Deduplicates by message.id (keeps last usage), skips <synthetic>, applies timestamp filter.
    """
    since_dt = ts(since) if since else None
    until_dt = ts(until) if until else None

    last_usage = {}  # message_id -> (timestamp, model, input, cache_write, cache_read, output)

    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue

            if row.get("type") != "assistant":
                continue

            msg = row.get("message")
            if not msg:
                continue

            usage = msg.get("usage")
            if not usage:
                continue

            model = msg.get("model")
            if model == "<synthetic>":
                continue

            msg_id = msg.get("id")
            if not msg_id:
                continue

            timestamp = row.get("timestamp")
            if timestamp:
                ts_dt = ts(timestamp)
                if since_dt and ts_dt < since_dt:
                    continue
                if until_dt and ts_dt > until_dt:
                    continue
            else:
                ts_dt = None

            input_tokens = usage.get("input_tokens", 0)
            cache_creation_input_tokens = usage.get("cache_creation_input_tokens", 0)
            cache_read_input_tokens = usage.get("cache_read_input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)

            last_usage[msg_id] = (ts_dt, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens)

    for msg_id, (_, model, inp, cache_write, cache_read, out) in last_usage.items():
        yield {
            "model": model,
            "input": inp,
            "cache_write": cache_write,
            "cache_read": cache_read,
            "output": out,
        }


def compute_costs(usage_list):
    """Aggregate usage by model and compute costs. Return (models_dict, total_usd, unpriced_models)."""
    models = {}
    unpriced = set()

    for usage in usage_list:
        model = usage["model"]
        if model not in models:
            models[model] = {
                "messages": 0,
                "input": 0,
                "cache_write": 0,
                "cache_read": 0,
                "output": 0,
            }

        models[model]["messages"] += 1
        models[model]["input"] += usage["input"]
        models[model]["cache_write"] += usage["cache_write"]
        models[model]["cache_read"] += usage["cache_read"]
        models[model]["output"] += usage["output"]

    total_usd = 0.0
    result = {}

    for model, agg in models.items():
        if model in PRICES:
            prices = PRICES[model]
            input_cost = (agg["input"] / 1_000_000) * prices["input"]
            cache_write_cost = (agg["cache_write"] / 1_000_000) * prices["cache_write"]
            cache_read_cost = (agg["cache_read"] / 1_000_000) * prices["cache_read"]
            output_cost = (agg["output"] / 1_000_000) * prices["output"]
            usd = input_cost + cache_write_cost + cache_read_cost + output_cost

            result[model] = {
                "messages": agg["messages"],
                "input": agg["input"],
                "cache_write": agg["cache_write"],
                "cache_read": agg["cache_read"],
                "output": agg["output"],
                "usd": round(usd, 2),
                "cache_write_assumed": prices["cache_write_assumed"],
            }
            total_usd += usd
        else:
            unpriced.add(model)
            result[model] = {
                "messages": agg["messages"],
                "input": agg["input"],
                "cache_write": agg["cache_write"],
                "cache_read": agg["cache_read"],
                "output": agg["output"],
                "usd": None,
            }

    return result, round(total_usd, 2), sorted(unpriced)


def format_text_output(models, total_usd):
    """Format results as text lines."""
    lines = []

    priced_models = {m: d for m, d in models.items() if d["usd"] is not None}
    for model in sorted(priced_models.keys()):
        data = priced_models[model]
        line = f"{model:25} {data['messages']:3} {data['input']:8} {data['cache_write']:8} {data['cache_read']:8} {data['output']:8} ${data['usd']:7.2f}"
        lines.append(line)

    unpriced_models = {m: d for m, d in models.items() if d["usd"] is None}
    for model in sorted(unpriced_models.keys()):
        data = unpriced_models[model]
        line = f"{model:25} {data['messages']:3} {data['input']:8} {data['cache_write']:8} {data['cache_read']:8} {data['output']:8} -"
        lines.append(line)

    total_messages = sum(data["messages"] for data in models.values())
    total_input = sum(data["input"] for data in models.values())
    total_cache_write = sum(data["cache_write"] for data in models.values())
    total_cache_read = sum(data["cache_read"] for data in models.values())
    total_output = sum(data["output"] for data in models.values())

    total_line = f"{'TOTAL':25} {total_messages:3} {total_input:8} {total_cache_write:8} {total_cache_read:8} {total_output:8} ${total_usd:7.2f}"
    lines.append(total_line)

    return "\n".join(lines)


def format_json_output(models, total_usd, unpriced):
    """Format results as JSON."""
    priced_models = {m: d for m, d in models.items() if d["usd"] is not None}
    return json.dumps(
        {
            "models": priced_models,
            "total_usd": total_usd,
            "unpriced": unpriced,
        }
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript", help="Path to transcript JSONL file")
    ap.add_argument("--since", help="ISO timestamp start filter")
    ap.add_argument("--until", help="ISO timestamp end filter")
    ap.add_argument("--json", action="store_true", help="Output as JSON")
    args = ap.parse_args()

    usage_list = list(load_usage(args.transcript, args.since, args.until))
    models, total_usd, unpriced = compute_costs(usage_list)

    if args.json:
        print(format_json_output(models, total_usd, unpriced))
    else:
        print(format_text_output(models, total_usd))


if __name__ == "__main__":
    main()
