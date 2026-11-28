#!/usr/bin/env python3
"""Keep a resumable, evidence-backed catalog audit in SQLite."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urljoin, urlsplit, urlunsplit

PORTAL = "https://game.cluerholdings.com/"
RESULTS = ("playable", "broken", "assets-needed", "blocked")


def launch_key(url):
    parts = urlsplit(urljoin(PORTAL, url))
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None:
        raise ValueError(f"Invalid launch URL: {url}")
    path = parts.path.removesuffix("/index.html").rstrip("/") or "/"
    if re.fullmatch(r"/games/arcade/[^/]+\.html", path):
        path = path.removesuffix(".html")
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, parts.query, parts.fragment))


def import_catalog(db, catalog, shelf):
    rows = {}
    items = [(tile["name"], tile["url"], None) for tile in catalog.get("tiles", [])]
    items.extend((game["title"], game["url"], f'original:{game["slug"]}')
                 for game in catalog.get("originals", []))
    items.extend((game["title"], game.get("url") or "/" + game["path"].lstrip("/"), None)
                 for game in shelf.get("games", []) if game.get("status", "live") == "live")
    if not items:
        raise ValueError("The catalog contains no playable entries")
    for title, url, original_id in items:
        key = launch_key(url)
        if key not in rows or original_id:
            rows[key] = (original_id or key, title, urljoin(PORTAL, url))
    db.execute("UPDATE games SET listed=0")
    db.executemany(
        """INSERT INTO games (id, title, url) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, listed=1,
           status=CASE WHEN games.url=excluded.url THEN games.status ELSE 'pending' END""",
        rows.values(),
    )
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--scope", required=True, choices=("staged", "production"))
    parser.add_argument("--stop", type=Path, default=Path.home() / "Projects/gamepack/logs/STOP")
    commands = parser.add_subparsers(dest="command", required=True)
    load = commands.add_parser("load")
    load.add_argument("catalog", type=Path, help="games.json captured from this scope")
    load.add_argument("--shelf", type=Path, help="games list captured from the shelf in this scope")
    next_batch = commands.add_parser("next")
    next_batch.add_argument("--limit", type=int, default=10)
    record = commands.add_parser("record")
    record.add_argument("id")
    record.add_argument("status", choices=RESULTS)
    record.add_argument("--evidence", required=True, help="Screenshot, test receipt, or blocker evidence")
    record.add_argument("--job-id", action="append", default=[])
    record.add_argument("--note", default="")
    commands.add_parser("summary")
    args = parser.parse_args()
    if args.stop.exists() and args.command in ("load", "next"):
        parser.exit(2, "Catalog audit paused by STOP. Existing results were retained.\n")
    with closing(sqlite3.connect(args.db)) as db, db:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS scope (name TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS games (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
              listed INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE TABLE IF NOT EXISTS attempts (
              game_id TEXT NOT NULL REFERENCES games(id),
              at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, url TEXT NOT NULL,
              status TEXT NOT NULL, evidence TEXT NOT NULL, jobs TEXT NOT NULL, note TEXT NOT NULL
            );
        """)
        if (row := db.execute("SELECT name FROM scope").fetchone()) and row[0] != args.scope:
            parser.error(f"{args.db} belongs to the {row[0]} catalog")
        db.execute("INSERT OR IGNORE INTO scope VALUES (?)", (args.scope,))
        if args.command == "load":
            catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
            shelf = json.loads(args.shelf.read_text(encoding="utf-8")) if args.shelf else {}
            print(f"{import_catalog(db, catalog, shelf)} distinct launch targets in {args.scope}")
        elif args.command == "record":
            row = db.execute("SELECT url FROM games WHERE id=? AND listed", (args.id,)).fetchone()
            if row is None:
                parser.error(f"Unknown current catalog ID: {args.id}")
            db.execute(
                "INSERT INTO attempts (game_id, url, status, evidence, jobs, note) VALUES (?, ?, ?, ?, ?, ?)",
                (args.id, row[0], args.status, args.evidence, json.dumps(args.job_id), args.note),
            )
            db.execute("UPDATE games SET status=? WHERE id=?", (args.status, args.id))
        elif args.command == "next":
            if args.limit < 1:
                parser.error("Expected a positive batch limit")
            for row in db.execute(
                """SELECT id, title, status, url FROM games WHERE listed AND status!='playable'
                   ORDER BY CASE status WHEN 'broken' THEN 0 WHEN 'assets-needed' THEN 1
                     WHEN 'pending' THEN 2 ELSE 3 END, title, id LIMIT ?""", (args.limit,)
            ):
                print("\t".join(row))
        else:
            for status, count in db.execute("SELECT status, count(*) FROM games WHERE listed GROUP BY status"):
                print(f"{status}\t{count}")


if __name__ == "__main__":
    main()
