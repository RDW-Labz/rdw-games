#!/usr/bin/env python3
"""Recursive anonymous SVN export via WebDAV PROPFIND + GET (no svn binary)."""
import sys, os, re, urllib.request, time, concurrent.futures as cf
BASE = "https://svn.wildfiregames.com"
def propfind(path):
    url = BASE + path
    req = urllib.request.Request(url, method="PROPFIND",
        data='<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'.encode(),
        headers={"Depth": "1", "Content-Type": "text/xml"})
    for a in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            print(f"PROPFIND retry {a} {url}: {e}", file=sys.stderr); time.sleep(2*(a+1))
    raise RuntimeError("propfind failed " + url)
def list_tree(path):
    xml = propfind(path); files = []
    for m in re.finditer(r"<D:response[^>]*>(.*?)</D:response>", xml, re.S):
        body = m.group(1)
        href = re.search(r"<D:href>(.*?)</D:href>", body).group(1)
        if href.rstrip("/") == path.rstrip("/"): continue
        if "<D:collection/>" in body: files.extend(list_tree(href))
        else: files.append(href)
    return files
def get(href, out, src):
    rel = href[len(src):].lstrip("/")
    if not rel: return
    dest = os.path.join(out, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0: return
    req = urllib.request.Request(BASE + href)
    for a in range(8):
        try:
            with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
                f.write(r.read())
            return
        except Exception as e:
            time.sleep(1+a)
    raise RuntimeError("GET failed " + href)
if __name__ == "__main__":
    src, out = sys.argv[1].rstrip("/") + "/", sys.argv[2]
    files = list_tree(src)
    print(f"{len(files)} files under {src}", flush=True)
    with cf.ThreadPoolExecutor(6) as ex:
        fs = [ex.submit(get, h, out, src) for h in files]
        for fu in cf.as_completed(fs): fu.result()
    print("EXPORT_DONE", flush=True)
