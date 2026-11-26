#!/usr/bin/env python3
"""Add/replace the Code Word + Cipher Square rows in games/catalog.json (bytes + sha256 from disk)."""
import hashlib
import json
import os

SITE = "/home/cluer/kaos/work/site"
CAT = os.path.join(SITE, "games", "catalog.json")


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


cat = json.load(open(CAT, encoding="utf-8"))
games = cat["games"]

ROWS = [
    ("code-word", "Code Word", "code word",
     "first-party three.js port of the Code Word guesser: six rows of five tiles, green/amber/grey "
     "feedback with duplicate-letter scoring, 1,945 five-letter answers baked in, Enter/Del keys, "
     "win and out-of-guesses sheets with the word revealed, no network beyond the three.js CDN."),
    ("codeword", "Cipher Square", "cipher square",
     "first-party three.js codeword puzzle: three 9x9 grids grown from real words, numbers repeat as "
     "letters, givens plus crossings, dead-end checker, hint, countdown loss, any complete fill of "
     "real words wins, no network beyond the three.js CDN."),
]

for slug, title, desc, notes in ROWS:
    folder = os.path.join(SITE, "games", "arcade", slug)
    entry = os.path.join(folder, "index.html")
    row = {
        "slug": slug,
        "title": title,
        "category": "arcade",
        "path": f"games/arcade/{slug}/",
        "entry": "index.html",
        "description": desc,
        "status": "licence-pending",
        "registered": False,
        "source": "arcade lane (three.js ports, /home/cluer/kaos/work/site)",
        "licence": "UNRECORDED in the tree. First-party reimplementation — clearance required before it can ship.",
        "attribution": "none recorded",
        "online": True,
        "offline": {"packaged": False, "package": None, "self_contained": True},
        "notes": notes,
        "bytes": os.path.getsize(entry),
        "sha256": sha(entry),
        "assets": [],
        "package_bytes": os.path.getsize(entry),
    }
    games = [g for g in games if not (g.get("category") == "arcade" and g.get("slug") == slug)]
    games.append(row)
    print(f"row {slug}: {row['bytes']} bytes {row['sha256'][:12]}")

cat["games"] = games
json.dump(cat, open(CAT, "w", encoding="utf-8"), indent=2, ensure_ascii=True)
open(CAT, "a", encoding="utf-8").write("\n")
print(f"catalog now {len(games)} games")
