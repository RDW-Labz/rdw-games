#!/usr/bin/env python3
"""Fetch git-lfs objects for a list of pointer files via Gitea LFS batch API."""
import sys, os, json, hashlib, urllib.request
BASE = "https://gitea.wildfiregames.com/0ad/0ad.git/info/lfs"
paths = []
for root in sys.argv[1:]:
    for dp, _, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            with open(p, "rb") as f:
                head = f.read(130)
            if head.startswith(b"version https://git-lfs"):
                oid = size = None
                for tok in head.decode().split():
                    if tok.startswith("oid sha256:"): oid = tok[11:]
                    if tok.startswith("size "): size = int(tok[5:])
                paths.append((p, oid, size))
print(len(paths), "pointer files", flush=True)
for i in range(0, len(paths), 50):
    chunk = paths[i:i+50]
    body = json.dumps({"operation": "download", "transfers": ["basic"],
                       "objects": [{"oid": o, "size": s} for _, o, s in chunk]}).encode()
    req = urllib.request.Request(BASE + "/objects/batch", data=body, headers={
        "Accept": "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json"})
    for a in range(5):
        try:
            resp = json.loads(urllib.request.urlopen(req, timeout=90).read())
            break
        except Exception as e:
            print("batch retry", e, file=sys.stderr)
    else:
        continue
    dl = {o["oid"]: o.get("actions", {}).get("href") for o in resp.get("objects", [])}
    for p, oid, size in chunk:
        href = dl.get(oid)
        if not href:
            print("NO HREF", p, file=sys.stderr); continue
        for a in range(6):
            try:
                data = urllib.request.urlopen(href, timeout=180).read()
                assert len(data) == size, (p, len(data), size)
                open(p, "wb").write(data)
                print("OK", p, size, flush=True)
                break
            except Exception as e:
                print("get retry", p, e, file=sys.stderr)
