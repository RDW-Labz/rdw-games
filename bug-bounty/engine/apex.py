#!/usr/bin/env python3
"""Registered-domain extraction that cannot lie about ccTLDs.

Every script here used to take the last two labels as "the domain". For `.com.bo`, `.com.co`,
`.co.uk` and the rest of the second-level registries that is wrong: `www.cbn.com.bo` became a domain
called `com.bo`, which then inherited the tier and policy of any programme that happened to list an
unrelated `*.com.bo` asset. That produced a "Programme scope gate: passed" note for a host nobody had
in scope — the worst possible failure, because the gate is the thing standing between a normal
submission and an out-of-scope report.

libpsl is on this host (it is a curl dependency), so the real Public Suffix List decides:

  python3 engine/apex.py www.cbn.com.bo ebill.edifact.com.co www.audiotour.karwei.nl
  python3 engine/apex.py --audit          # domains-table rows that are themselves public suffixes

`registered()` falls back to last-two-labels only if libpsl cannot be loaded, and says so, because
silently returning a wrong apex is how this bug survived in the first place.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"

_lib = None
_ctx = None
_PSL_FILE = ROOT / "engine" / "data" / "public_suffix_list.dat"
_source = "last-two-labels (no libpsl)"
for _name in ("libpsl.so.5", "libpsl.so", ctypes.util.find_library("psl")):
    if not _name:
        continue
    try:
        _lib = ctypes.CDLL(_name)
        break
    except OSError:
        continue

if _lib is not None:
    _lib.psl_builtin.restype = ctypes.c_void_p
    _lib.psl_builtin.argtypes = []
    _lib.psl_registrable_domain.restype = ctypes.c_char_p
    _lib.psl_registrable_domain.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    _lib.psl_is_public_suffix.restype = ctypes.c_int
    _lib.psl_is_public_suffix.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    # The builtin list is frozen into the distro's libpsl package and lags the real registry. It did not
    # know `bet.br` was a public suffix, so `blog.luva.bet.br` came back as `bet.br` — which then matched
    # Superbet's `superbet.bet.br` asset and put a host nobody has in scope into a payable-looking queue.
    # Prefer the downloaded list; a stale registry is a scope gate that lies.
    _ctx, _source = None, "libpsl builtin (stale)"
    if _PSL_FILE.exists():
        try:
            _lib.psl_load_file.restype = ctypes.c_void_p
            _lib.psl_load_file.argtypes = [ctypes.c_char_p]
            _ctx = _lib.psl_load_file(str(_PSL_FILE).encode())
            if _ctx:
                _source = f"libpsl file {_PSL_FILE.name}"
        except AttributeError:
            _ctx = None
    if _ctx is None:
        _ctx = _lib.psl_builtin()


def registered(host: str) -> str:
    """`a.b.example.co.uk` -> `example.co.uk`. Never guesses beyond the Public Suffix List."""
    h = (host or "").strip().strip(".").lower()
    if not h:
        return ""
    if _ctx is not None:
        got = _lib.psl_registrable_domain(_ctx, h.encode())
        if got:
            return got.decode()
        return h          # host is itself a suffix or unparsable; refuse to invent a parent
    parts = h.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else h


def is_public_suffix(s: str) -> bool:
    """True when `s` is a registry (com, co.uk, com.bo) rather than somebody's domain."""
    h = (s or "").strip().strip(".").lower()
    if not h:
        return False
    if _ctx is not None:
        return bool(_lib.psl_is_public_suffix(_ctx, h.encode()))
    return h.count(".") <= 1


def audit() -> int:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = c.execute("SELECT domain, org, tier FROM domains").fetchall()
    bad = [(d, org, tier) for d, org, tier in rows if is_public_suffix(d)]
    print(f"{len(rows)} domain rows, {len(bad)} are public suffixes (bogus apexes)")
    for d, org, tier in bad:
        hosts = c.execute("SELECT count(*) FROM hosts WHERE domain=?", (d,)).fetchone()[0]
        print(f"  {d:22} hosts={hosts:<5} tier={tier or '-':<10} org={org or '-'}")
    return 0


def main() -> None:
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return
    if args[0] == "--audit":
        raise SystemExit(audit())
    if _ctx is None:
        print("WARNING: libpsl unavailable — falling back to last-two-labels", file=sys.stderr)
    for h in args:
        suffix = "  [PUBLIC SUFFIX]" if is_public_suffix(h) else ""
        print(f"{h:45} -> {registered(h)}{suffix}")


if __name__ == "__main__":
    main()
