#!/usr/bin/env python3
"""Take the swagger/openapi hits from the census and see whether any of them is actually an
opportunity rather than a docs page: find the spec, count the endpoints, and try the parameterless
GETs unauthenticated.

An exposed Swagger UI is worth nothing by itself — most programmes rate it informational. It becomes
payable the moment one of the endpoints behind it answers a parameterless GET without a token, which
is the same bug as an open API directory with extra steps. That is a mechanical distinction, so it
can be measured instead of argued about.

Read-only: GET only, no parameters, no bodies, no auth attempted, one request per endpoint, capped.
Nothing is stored beyond the count of what answered.

  python3 engine/apispec.py                       # every swagger/openapi hit in reports/census.json
  python3 engine/apispec.py --host moonpay.com
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jsscan import fetch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SPEC_HINTS = re.compile(r'''["'(]([^"'()]+\.(?:json|yaml|yml))["')]|url\s*:\s*["']([^"']+)["']''', re.I)
DOC_KINDS = {"swagger", "swagger-2", "openapi"}


def find_specs(host: str, page_path: str) -> list[str]:
    """Spec candidates: the common locations plus anything the UI page names."""
    urls = {f"https://{host}/openapi.json", f"https://{host}/v3/api-docs",
            f"https://{host}/v2/api-docs", f"https://{host}/swagger.json",
            f"https://{host}/api-docs", f"https://{host}/swagger/v1/swagger.json"}
    st, body = fetch(f"https://{host}{page_path}", timeout=10.0)
    if st == 200 and body:
        for m in SPEC_HINTS.finditer(body[:200_000]):
            u = (m.group(1) or m.group(2) or "").strip()
            if u and not u.startswith("data:"):
                urls.add(urljoin(f"https://{host}{page_path}", u))
    return sorted(urls)


def load_spec(url: str) -> dict | None:
    st, body = fetch(url, timeout=12.0)
    if st != 200 or not body or body.lstrip()[:1] not in "{[":
        return None
    try:
        spec = json.loads(body)
    except Exception:
        return None
    return spec if isinstance(spec, dict) and ("paths" in spec or "openapi" in spec or "swagger" in spec) else None


def probe_endpoint(base: str, path: str, op: dict) -> dict | None:
    """Only parameterless GETs: no path templating, no required query, no body."""
    if "{" in path or not isinstance(op, dict) or "get" not in op:
        return None
    params = op["get"].get("parameters") or []
    if any(p.get("required") and p.get("in") in ("query", "header", "path") for p in params
           if isinstance(p, dict)):
        return None
    st, body = fetch(base + path, timeout=10.0)
    if st != 200 or not body or len(body) < 40:
        return None
    head = body.lstrip()[:1]
    if head not in "{[":
        return None
    return {"path": path, "len": len(body), "sha": __import__("hashlib").sha256(
        body.encode()).hexdigest()[:12], "preview": body[:120].replace("\n", " ")}


def audit_host(hit: dict) -> dict:
    host, page = hit["host"], hit["path"]
    out = {"host": host, "programme": f"{hit['platform']}:{hit['handle']}", "spec": "", "paths": 0,
           "parameterless_get": 0, "open": []}
    for cand in find_specs(host, page):
        spec = load_spec(cand)
        if not spec:
            continue
        out["spec"] = cand
        paths = spec.get("paths") or {}
        out["paths"] = len(paths)
        jobs = [(p, op) for p, op in paths.items() if isinstance(op, dict)]
        out["parameterless_get"] = sum(1 for p, op in jobs if "{" not in p and "get" in op)
        base = cand.rsplit("/", 1)[0]
        with ThreadPoolExecutor(max_workers=8) as ex:
            res = [r for r in ex.map(lambda j: probe_endpoint(base, j[0], j[1]), jobs[:60]) if r]
        out["open"] = res
        break
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="")
    ap.add_argument("--census", default="reports/census.json")
    a = ap.parse_args()

    data = json.loads((ROOT / a.census).read_text())
    hits = [h for h in data.get("hits", []) if h["kind"] in DOC_KINDS]
    if a.host:
        hits = [h for h in hits if h["host"] == a.host]
    print(f"{len(hits)} API-doc hits to triage\n")

    for hit in hits:
        r = audit_host(hit)
        print(f"{r['host']}  [{r['programme']}]")
        if not r["spec"]:
            print("  no machine-readable spec behind the docs page — nothing to triage\n")
            continue
        print(f"  spec: {r['spec']}")
        print(f"  {r['paths']} paths · {r['parameterless_get']} parameterless GETs")
        if not r["open"]:
            print("  every tested endpoint refused or required parameters — no open surface\n")
            continue
        print(f"  {len(r['open'])} answered 200 with JSON, unauthenticated:")
        for o in r["open"][:8]:
            print(f"    {o['path']}  {o['len']}B  {o['preview'][:70]}")
        print()


if __name__ == "__main__":
    main()
