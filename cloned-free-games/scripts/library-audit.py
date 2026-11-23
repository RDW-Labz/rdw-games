#!/usr/bin/env python3
"""Audit every catalog card for Michael's click-and-play rule.

Rule (2026-11-14): nothing belongs on the game library that a visitor cannot
click and play in the browser. No downloads, no installs, no APKs, no leaving
the browser to fetch a binary.

This script reads the rendered catalog (scripts/make-catalog-site.py output,
i.e. what the tiles actually say) and the on-disk state of everything that is
supposed to run locally, then classifies every card:

  live       -> passes: the tile launches a browser game
  quarantine -> fails: store page / release download / apk / nothing

The classification trusts the *target URL*, not the renderer's label: a card
labelled "Play" that points at f-droid.org is a store page, not a game.

Outputs (all under $SRC/.queue, i.e. gitignored working state):
  library-audit.json   machine-readable, consumed by scripts/make-library.py
                        and by the conversion cron
  library-audit.csv    one row per card for the report
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

STORE_HOSTS = {
    "f-droid.org", "play.google.com", "apps.apple.com", "itunes.apple.com",
    "aptoide.com", "en.aptoide.com", "galaxy.store", "amazon.com", "apkpure.com",
    "apps.obtainium.imranr.dev", "izzysoft.de",
}
_EMBED_VERIFIED = None
DOWNLOAD_MARKERS = ("/releases", "/releases/latest", "/download", ".apk", ".zip", ".tar.gz", "sourceforge.net/projects/")


def embedded_ok(url):
    """True only for URLs an actual in-browser embed probe has proven playable.

    Never infer this: the verified list is written by scripts/embed-probe.py, which
    loads the page in headless chromium and checks that the frame renders and stays
    alive. An empty/missing list means no external tile ships.
    """
    global _EMBED_VERIFIED
    if _EMBED_VERIFIED is None:
        p = os.path.join(os.environ.get("LIB_SRC", os.path.expanduser("~/cloned-free-games")),
                         ".queue", "embed-verified.json")
        try:
            _EMBED_VERIFIED = set(json.load(open(p, encoding="utf-8")).get("verified", []))
        except Exception:
            _EMBED_VERIFIED = set()
    return url in _EMBED_VERIFIED


def load_block(src):
    """Slug -> reason from scripts/playable-block.txt (the repo's human gate list).

    The block list is the durable record of "this build is not a game / does not play":
    captured 404s, harvested wrong pages, marketing pages, dashboards. Honouring it here
    keeps a curated rejection from being re-published by an automated pass.
    """
    out = {}
    p = os.path.join(src, "scripts", "playable-block.txt")
    try:
        for line in open(p, encoding="utf-8"):
            line = line.split("#", 1)
            slug = line[0].strip()
            if slug:
                out[slug.lower()] = line[1].strip() if len(line) > 1 else "blocked"
    except OSError:
        pass
    return out


def classify(entry, src, site_repo, arcade_files, frame_ok=None, blocked=None):
    """Return (verdict, launch, failure_mode, detail)."""
    name = entry.get("name") or entry.get("slug") or "?"
    play = (entry.get("play") or "").strip()
    kind = entry.get("play_kind") or ""
    playable = entry.get("playable") or None

    # 0. Human block list wins over everything: a rejected build never becomes a tile.
    slug = (entry.get("slug") or "").strip()
    if blocked and slug.lower() in blocked:
        return ("quarantine", play or entry.get("url") or "", "blocked-content",
                f"{slug} is on the block list — {blocked[slug.lower()]}")

    # 1. First-party three.js port, shipped from the site repo's HEAD.
    if playable and playable.get("url"):
        url = playable["url"]
        tier = playable.get("tier") or ""
        if url.startswith("/games/arcade/"):
            fn = url.rsplit("/", 1)[-1]
            if fn in arcade_files:
                return ("live", url, "", f"first-party three.js port ({tier})")
            return ("quarantine", url, "broken-port", f"{url} not in site repo HEAD")
        if url.startswith("/play/"):
            slug = url.strip("/").split("/")[1]
            idx = os.path.join(src, ".site-play", slug, "index.html")
            if os.path.isfile(idx):
                return ("live", url, "", f"vendored browser build ({tier})")
            return ("quarantine", url, "missing-mirror", f".site-play/{slug}/index.html absent")

    # 2. Third-party URL: judge it by where it actually points.
    if play:
        host = ""
        m = re.match(r"https?://([^/]+)", play)
        if m:
            host = m.group(1).lower()
        bare = host[4:] if host.startswith("www.") else host
        if any(bare == h or bare.endswith("." + h) for h in STORE_HOSTS):
            mode = "apk-install" if bare == "f-droid.org" or "apk" in bare else "store-install"
            return ("quarantine", play, mode, f"store page on {bare} — visitor must install an app")
        if any(mk in play for mk in DOWNLOAD_MARKERS):
            return ("quarantine", play, "download", "release/download link — visitor must fetch a binary")
        if host:
            # A third-party website. Clicking a tile navigates off our page and, for the
            # overwhelming majority of these rows, lands on a project homepage / engine /
            # tool rather than a running game (VCMI, 0 A.D., Freeciv, Nakama, Bottles...).
            # The rule is "click -> the game loads and plays in the page", so a link-out is
            # a quarantine entry, not a tile. An embed that survives X-Frame-Options is the
            # one case we can still show in-page; it is recorded so the face can use it.
            # .queue/embed-verified.json is the ONLY gate here, and scripts/embed-probe.py
            # is its ONLY writer: it loads the page in headless Chromium inside a sandboxed
            # iframe and requires a live game surface (canvas/WebGL). external-frame.json
            # (2026-11-14 one-off) was a headers-only framability probe; it is kept as
            # evidence but it cannot promote a tile on its own — "framable" is not "plays".
            if embedded_ok(play):
                return ("live", play, "", f"embeds and runs in-page ({bare})")
            frame = (frame_ok or {}).get(play)
            if frame == "FRAMABLE":
                return ("quarantine", play, "links-out",
                        f"framable per external-frame.json but never play-probed — "
                        f"run scripts/embed-probe.py ({kind or 'url'})")
            return ("quarantine", play, "links-out",
                    f"opens {bare} in the tab instead of playing in the page ({kind or 'url'})")
        if play.startswith("/"):
            return ("quarantine", play, "no-link", "relative target with no file behind it")

    # 3. Nothing clickable at all.
    if entry.get("url"):
        return ("quarantine", entry["url"], "no-link", "no launch target — only a source repo")
    return ("quarantine", "", "no-link", "no launch target")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.expanduser("~/cloned-free-games"))
    ap.add_argument("--games-json", default=None,
                    help="rendered games.json (default: render into a temp dir)")
    ap.add_argument("--site-repo", default=os.path.expanduser("~/kaos/work/site"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    out_dir = args.out or os.path.join(src, ".queue")
    os.makedirs(out_dir, exist_ok=True)

    gj = args.games_json
    if not gj:
        import subprocess
        import tempfile
        tmp = tempfile.mkdtemp(prefix="libaudit-")
        subprocess.run([sys.executable, os.path.join(src, "scripts", "make-catalog-site.py"),
                        "--src", src, "--out", tmp], check=True, capture_output=True)
        gj = os.path.join(tmp, "games.json")
    data = json.load(open(gj, encoding="utf-8"))

    arcade_files = set()
    blocked = load_block(src)
    arcade_dir = os.path.join(args.site_repo, "games", "arcade")
    if os.path.isdir(arcade_dir):
        arcade_files = {f for f in os.listdir(arcade_dir) if f.endswith(".html")}

    frame_ok = {}
    try:
        for row in json.load(open(os.path.join(src, ".queue", "external-frame.json"), encoding="utf-8")):
            frame_ok[row["url"]] = row.get("framable")
    except Exception:
        frame_ok = {}

    live, quarantine = [], []
    for e in data["entries"]:
        verdict, launch, mode, detail = classify(e, src, args.site_repo, arcade_files, frame_ok, blocked)
        rec = {
            "name": e.get("name") or e.get("slug"),
            "slug": e.get("slug"),
            "score": e.get("score"),
            "type": (e.get("type") or "")[:160],
            "icon": e.get("icon"),
            "url": e.get("url"),
            "launch": launch,
            "detail": detail,
            "judged": bool(e.get("judged")),
            "source": e.get("source"),
        }
        if launch.startswith("/games/arcade/"):
            rec["tier"] = "first-party"
        elif launch.startswith("/play/"):
            rec["tier"] = "mirror"
        elif verdict == "live":
            rec["tier"] = "external"
        if verdict == "live":
            live.append(rec)
        else:
            rec["failure_mode"] = mode
            quarantine.append(rec)

    live.sort(key=lambda r: ({"first-party": 0, "mirror": 1, "external": 2}[r["tier"]],
                             -(r["score"] or 0), (r["name"] or "").lower()))
    quarantine.sort(key=lambda r: (-(r["score"] or 0), (r["name"] or "").lower()))

    audit = {
        "generated": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "rule": "click and play in the browser; no downloads, no installs, no APKs",
        "total": len(data["entries"]),
        "live": len(live),
        "quarantine": len(quarantine),
        "by_tier": dict(Counter(r["tier"] for r in live)),
        "by_failure": dict(Counter(r["failure_mode"] for r in quarantine)),
        "entries_live": live,
        "entries_quarantine": quarantine,
    }
    jpath = os.path.join(out_dir, "library-audit.json")
    json.dump(audit, open(jpath, "w", encoding="utf-8"), indent=1, ensure_ascii=False)

    csv_path = os.path.join(src, ".queue", "library-audit.csv")
    import csv
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["game", "slug", "verdict", "plays_in_browser", "failure_mode", "launch", "score", "detail"])
        for r in live:
            w.writerow([r["name"], r["slug"], "live", "yes", "", r["launch"], r["score"], r["detail"]])
        for r in quarantine:
            w.writerow([r["name"], r["slug"], "quarantine", "no", r["failure_mode"], r["launch"], r["score"], r["detail"]])

    print(f"TOTAL {audit['total']}  LIVE {audit['live']}  QUARANTINE {audit['quarantine']}")
    print("live by tier:  ", json.dumps(audit["by_tier"]))
    print("fails by mode: ", json.dumps(audit["by_failure"]))
    print(f"wrote {jpath}")
    print(f"wrote {csv_path}")


if __name__ == "__main__":
    main()
