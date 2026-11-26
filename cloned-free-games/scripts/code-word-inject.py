#!/usr/bin/env python3
"""Inject the five-letter word list into the Code Word page (CORE marker /*>>>WORDS>>>*/)."""
import json
import re
import sys

PAGE = "/home/cluer/kaos/work/site/games/arcade/code-word/index.html"
WORDS = sys.argv[1] if len(sys.argv) > 1 else "/home/cluer/cloned-free-games/.queue/codeword-words.txt"

words = sorted({w.strip().lower() for w in open(WORDS, encoding="utf-8") if w.strip() and len(w.strip()) == 5})
html = open(PAGE, encoding="utf-8").read()
pat = re.compile(r"(/\*>>>WORDS>>>\*/)\[.*?\];", re.S)
if not pat.search(html):
    raise SystemExit("WORDS marker not found")
html = pat.sub(lambda m: m.group(1) + json.dumps(words, separators=(",", ":")) + ";", html, count=1)
open(PAGE, "w", encoding="utf-8").write(html)
print(f"injected {len(words)} five-letter words, page now {len(html)} bytes")
