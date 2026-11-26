#!/usr/bin/env python3
"""Append the code-word and codeword entries to arcade/arcade.json (library repo manifest)."""
import json

PATH = "/home/cluer/cloned-free-games/arcade/arcade.json"
data = json.load(open(PATH, encoding="utf-8"))
games = data["games"]

ENTRIES = [
    {
        "slug": "code-word",
        "name": "Code Word",
        "match": ["peace-ray/code-word", "com.peaceray.codeword", "Code Word", "code-word"],
        "entry": "/games/arcade/code-word.html",
        "blurb": (
            "Guess the secret five-letter word in six tries. Every guess is scored in place: green "
            "means the letter is in the right spot, amber means it is in the word somewhere else, and "
            "the keyboard keeps the best colour each letter has earned so the ruled-out ones fade out. "
            "1,945 answers are baked into the page, so it works with no network at all; a correct word "
            "opens a win sheet, six misses reveal the answer."
        ),
        "tier": "first-party",
    },
    {
        "slug": "codeword",
        "name": "Cipher Square",
        "match": ["Cipher Square", "cipher-square", "codeword puzzle", "code word puzzle"],
        "entry": "/games/arcade/codeword.html",
        "blurb": (
            "A codeword: a 9x9 crossword where every square carries a number instead of a clue, and one "
            "number is always the same letter. Three grids are grown from real words, three letters are "
            "revealed to start you off, and typing a letter another number already owns swaps the two - "
            "so the mapping is the puzzle. Check marks squares that can no longer be right, Hint reveals "
            "one number, and any complete fill of real words wins."
        ),
        "tier": "first-party",
    },
]

have = {g.get("slug") for g in games}
for e in ENTRIES:
    games = [g for g in games if g.get("slug") != e["slug"]]
    games.append(e)
    print(("replaced " if e["slug"] in have else "added ") + e["slug"])

data["games"] = games
json.dump(data, open(PATH, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
open(PATH, "a", encoding="utf-8").write("\n")
print(f"arcade.json now {len(games)} ports")
