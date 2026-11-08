#!/usr/bin/env python3
"""Desk-judge ONE cloned-but-unjudged game and append its row to CATALOG.md.

Deterministic cron-friendly half of the judging job: the fact pack comes from
next-unjudged.py, the judgement from the local lane (flint :8081) asked for strict JSON,
and the row is written by this script. No agent harness and no build — this runs in
seconds, so a scheduler restart cannot eat the work mid-flight.

Rows written here are explicitly DESK AUDITS: the score is italic and marked `_desk_`,
and the Status column says no build was run. A desk row is a triage score, never a
verification — the differentiator claim (built + run + measured) still needs a real build
pass, and nothing here may pretend otherwise.

  scripts/judge-one.py            # judge the next candidate
  scripts/judge-one.py --dry-run  # show the row without touching CATALOG.md
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "CATALOG.md")
FACTS_SCRIPT = os.path.join(ROOT, "scripts", "next-unjudged.py")
LANE = os.environ.get("JUDGE_LANE", "http://127.0.0.1:8081/v1/chat/completions")
MODEL = os.environ.get("JUDGE_MODEL", "flint")

SYSTEM = """You are scoring open-source games for a phone-first catalog. You get a fact pack \
produced by scanning a real clone: engine markers, file/content counts, license, README head.

Score with EXACTLY this rubric, nothing else:
  buildability from source, 0-2
  runs on the phone target, 0-3
  depth/replay ("badd ass" factor), 0-3
  polish/optimization, 0-2
Sum is the score, 0-10. Never use a 0-100 scale.

Rules:
- Judge only from the fact pack. No reputation, no guessing at features the pack does not show.
- Content counts are your main evidence for depth: maps/levels, units, items, campaigns.
- Mobile: an android/ dir, AndroidManifest or gradle project is real evidence; "C++ game" is not.
- buildability: 1+ documented build files with a plausible toolchain = at least 1; \
build files plus a documented build command in the README = 2.
- polish/optimization: 0 unless the pack shows shipped assets and a release/binary story.

Reply with ONE json object and nothing else:
{"genre":"short genre label","type":"one-line description","build":0,"mobile":0,"depth":0,"polish":0,
 "platforms":"comma separated, only what the pack supports","note":"one sentence of concrete evidence",
 "reason":"max 25 words on the score"}
"""


def fact_pack() -> tuple[str, str] | None:
    out = subprocess.run([sys.executable, FACTS_SCRIPT, "--facts"], capture_output=True, text=True)
    text = out.stdout.strip()
    if not text or text.startswith("UNJUDGED: none"):
        return None
    name = text.splitlines()[0].split(":", 1)[1].strip()
    return name, text


def parse_pack(pack: str) -> dict:
    d = {}
    for line in pack.splitlines():
        if ":" in line and not line.startswith("---"):
            k, v = line.split(":", 1)
            d[k.strip().lower()] = v.strip()
    return d


def ask_model(pack: str, budget: int = 3000) -> dict:
    body = {
        "model": MODEL,
        "temperature": 0.2,
        # reasoning eats this budget before any content is emitted, so leave real room
        "max_tokens": budget,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Fact pack:\n\n" + pack},
        ],
    }
    req = urllib.request.Request(
        LANE, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        payload = json.load(r)
    content = payload["choices"][0]["message"]["content"] or ""
    if not content.strip() and budget < 5000:
        return ask_model(pack, budget=5000)
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        raise ValueError(f"model did not return json: {content[:200]}")
    return json.loads(m.group(0))


def num(d: dict, key: str, hi: int) -> float:
    v = d.get(key, 0)
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = 0.0
    return max(0.0, min(float(hi), v))


def last_numbered_row(lines: list[str]) -> int:
    idx = -1
    for i, ln in enumerate(lines):
        if re.match(r"^\|\s*\d+\s*\|", ln):
            idx = i
    return idx


def main() -> int:
    got = fact_pack()
    if not got:
        print("nothing to judge")
        return 0
    name, pack = got
    facts = parse_pack(pack)

    try:
        verdict = ask_model(pack)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError) as e:
        print(f"judge failed for {name}: {e}")
        subprocess.run([sys.executable, FACTS_SCRIPT, "--skip", name], check=False)
        return 0

    build = num(verdict, "build", 2)
    mobile = num(verdict, "mobile", 3)
    depth = num(verdict, "depth", 3)
    polish = num(verdict, "polish", 2)
    score = round(build + mobile + depth + polish, 1)

    genre = str(verdict.get("genre", "game")).strip()[:48] or "game"
    typ = str(verdict.get("type", "")).strip()[:90]
    platforms = str(verdict.get("platforms", "")).strip()[:80] or "unknown"
    note = str(verdict.get("note", "")).strip()[:180]
    reason = str(verdict.get("reason", "")).strip()[:120]

    scored = f"desk {build:.0f}/2 build, {mobile:.0f}/3 mobile, {depth:.0f}/3 depth, {polish:.0f}/2 polish"
    status = (
        f"**Desk audit — no build run** ({scored}). "
        f"{note} Pack: {facts.get('size', '?')}, engine {facts.get('engine markers', '?')}, "
        f"{facts.get('content', '?')}, license {facts.get('license', '?')}. "
        f"Score reflects source inspection only: {reason}"
    )

    text = open(CATALOG, encoding="utf-8").read()
    lines = text.splitlines()
    idx = last_numbered_row(lines)
    if idx < 0:
        print("CATALOG.md has no scored table to append to")
        return 1
    num_match = re.match(r"^\|\s*(\d+)\s*\|", lines[idx])
    if not num_match:
        print("last table row has no number column")
        return 1
    n = int(num_match.group(1)) + 1
    row = f"| {n} | **{name}** | {genre}{' — ' + typ if typ else ''} | _{score:.1f}_ | {platforms} | {status} |"

    if "--dry-run" in sys.argv:
        print(row)
        return 0

    lines.insert(idx + 1, row)
    open(CATALOG, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    subprocess.run(["git", "-C", ROOT, "add", "CATALOG.md"], check=False)
    subprocess.run(["git", "-C", ROOT, "commit", "-q", "-m", f"catalog: desk-judge {name}"], check=False)
    print(row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
