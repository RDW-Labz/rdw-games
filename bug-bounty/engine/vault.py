#!/usr/bin/env python3
"""Read and update the platform account vault. Secrets never leave the terminal.

    python3 engine/vault.py show bugcrowd           # username candidates, url, status, password
    python3 engine/vault.py get  bugcrowd password  # one value, for piping into a clipboard
    python3 engine/vault.py set  bugcrowd status=created username=rdwlabz
    python3 engine/vault.py list

The file lives outside the repository at ``~/.config/rdwlabz/platforms.json`` (mode 600). It holds
usernames and passwords for accounts **we** created. It does not hold the EIN, bank routing or account
numbers — those belong only in a platform's own form, typed by the owner.
"""
from __future__ import annotations

import json
import os
import stat
import sys

VAULT = os.path.expanduser("~/.config/rdwlabz/platforms.json")
FIELDS = ("url", "email", "usernames", "password", "status", "notes")


def load() -> dict:
    with open(VAULT) as f:
        return json.load(f)


def save(v: dict) -> None:
    tmp = VAULT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(v, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, VAULT)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    cmd = argv[0]
    v = load()

    if cmd == "list":
        for name, a in v["accounts"].items():
            print(f"{name:12} {a['status']:12} {a.get('username') or '-':16} {a['url']}")
        return 0

    if cmd in {"show", "get"}:
        if len(argv) < 2:
            print("usage: vault.py show <platform>", file=sys.stderr)
            return 2
        a = v["accounts"].get(argv[1])
        if a is None:
            print(f"no such account: {argv[1]} (have: {', '.join(v['accounts'])})", file=sys.stderr)
            return 2
        if cmd == "get":
            key = argv[2] if len(argv) > 2 else "password"
            if key not in a:
                print(f"no field {key!r}; fields: {', '.join(a)}", file=sys.stderr)
                return 2
            val = a[key]
            print(val if isinstance(val, str) else json.dumps(val))
            return 0
        print(f"{sys.argv[1]}: {a['url']}")
        print(f"  email    {a['email']}")
        print(f"  usernames {', '.join(a['usernames'])}")
        print(f"  status   {a['status']}")
        print(f"  password {a['password']}")
        print(f"  notes    {a['notes']}")
        return 0

    if cmd == "set":
        if len(argv) < 3:
            print("usage: vault.py set <platform> field=value [field=value ...]", file=sys.stderr)
            return 2
        name, a = argv[1], v["accounts"].get(argv[1])
        if a is None:
            print(f"no such account: {name}", file=sys.stderr)
            return 2
        for pair in argv[2:]:
            k, _, val = pair.partition("=")
            if k not in a:
                print(f"unknown field {k!r}; fields: {', '.join(a)}", file=sys.stderr)
                return 2
            a[k] = val
        save(v)
        print(f"{name} updated: " + ", ".join(f"{k}={a[k]}" for k in a if k in ("status", "username")))
        return 0

    print(f"unknown command {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
