#!/usr/bin/env python3
"""Inject baked puzzles + the shipped word list into the Code-Word page.

The page carries a `/*>>>PUZZLES>>>*/` and `/*>>>DICT>>>*/` marker inside its CORE block; this
script replaces the payload after each marker, so re-running it is safe and the CORE test always
reads exactly what is in the file.
"""
import json
import re
import sys

PAGE = "/home/cluer/kaos/work/site/games/arcade/codeword/index.html"
PUZZLES = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cw14.json"
WORDS = sys.argv[2] if len(sys.argv) > 2 else "/home/cluer/cloned-free-games/.queue/codeword-words.txt"

data = json.load(open(PUZZLES, encoding="utf-8"))
puzzles = data["puzzles"]
words = [w.strip() for w in open(WORDS, encoding="utf-8") if w.strip()]

for p in puzzles:
    p.pop("attempt", None)

html = open(PAGE, encoding="utf-8").read()

def put(text, marker, payload):
    pat = re.compile(r"(/\*>>>" + marker + r">>>\*/)" + r"\[.*?\];", re.S)
    if not pat.search(text):
        raise SystemExit(f"marker {marker} not found")
    return pat.sub(lambda m: m.group(1) + payload + ";", text, count=1)

html = put(html, "PUZZLES", json.dumps(puzzles, separators=(",", ":")))
html = put(html, "DICT", json.dumps(words, separators=(",", ":")))

open(PAGE, "w", encoding="utf-8").write(html)
print(f"injected {len(puzzles)} puzzles, {len(words)} words, page now {len(html)} bytes")
