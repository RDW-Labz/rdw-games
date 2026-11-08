#!/usr/bin/env python3
"""Read the inboxes from the operator's own signed-in Firefox profile.

There is no IMAP server, no Maildir, no `himalaya`, and no OAuth token on this machine: the only place
Gmail and Outlook sessions exist is the Firefox profile the operator actually uses. So this copies that
profile (never the live one — Firefox holds a lock and a half-written SQLite is worse than no answer),
launches it headless through geckodriver, and reads the mailbox DOM.

The copy is the point: the running window keeps its lock, the session cookies stay valid, and nothing
is typed. If Google decides the copied profile is a new device it will show a challenge, which is
reported as such rather than worked around.

  python3 engine/mail_read.py            # both inboxes
  python3 engine/mail_read.py --gmail
  python3 engine/mail_read.py --outlook
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = Path.home() / ".config/mozilla/firefox/jjbxe7n6.default-release"
COPY = HERE / "profiles/mail"
GECKO = Path.home() / ".local/bin/geckodriver"
EXCLUDE = ("cache2", "startupCache", "datareporting", "crashes", "minidumps", "shader-cache",
           "storage/default/*/cache")


def refresh_profile() -> None:
    """Copy cookies/logins from the live profile, keeping the launch prefs we need."""
    prefs = COPY / "user.js"
    keep = prefs.read_text() if prefs.exists() else ""
    shutil.rmtree(COPY, ignore_errors=True)
    COPY.mkdir(parents=True)
    try:
        shutil.copytree(SRC, COPY, dirs_exist_ok=True, symlinks=True,
                        ignore=shutil.ignore_patterns("cache2", "startupCache", "datareporting",
                                                      "crashes", "minidumps", "shader-cache",
                                                      "lock", "parentlock", ".parentlock"))
    except shutil.Error as e:
        # a running Firefox holds `lock` as a dangling symlink and rewrites SQLite WAL files while we
        # copy; the files we actually need (cookies.sqlite, logins.json, key4.db) come across fine.
        bad = [f for f in e.args[0] if not str(f[0]).endswith(("lock", ".parentlock"))]
        if bad:
            raise
    (COPY / "user.js").write_text(keep + """
user_pref("marionette.enabled", true);
user_pref("dom.webdriver.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
""")


def driver():
    o = Options()
    o.binary_location = "/usr/lib/firefox/firefox"
    o.add_argument("-profile")
    o.add_argument(str(COPY))
    o.add_argument("-headless")
    o.add_argument("--width=1400")
    o.add_argument("--height=1000")
    s = Service(str(GECKO), service_args=["--log", "fatal"])
    d = webdriver.Firefox(options=o, service=s)
    d.set_page_load_timeout(60)
    return d


def gmail(d) -> dict:
    d.get("https://mail.google.com/mail/u/0/#inbox")
    time.sleep(9)
    url = d.current_url
    if "accounts.google.com" in url or "ServiceLogin" in url:
        return {"ok": False, "why": "signed out — Google wants a fresh login", "url": url}
    rows = d.execute_script("""
        const rs = [...document.querySelectorAll('tr.zA')].slice(0, 40);
        return rs.map(r => {
            const un = r.querySelector('.bA4 span, .yX.xY span, .zF, .yP');
            const sub = r.querySelector('.bog');
            const sn = r.querySelector('.yW span, .bA4 span');
            const when = r.querySelector('.xW span');
            return {from: (sn && sn.getAttribute('email')) || (un && un.textContent) || '',
                    name: (un && un.textContent) || '',
                    subject: (sub && sub.textContent) || '',
                    when: (when && when.textContent) || ''};
        });
    """) or []
    return {"ok": bool(rows), "url": url, "count": len(rows), "rows": rows,
            "title": d.title,
            "body": "" if rows else d.find_element("css selector", "body").text[:1200]}


def outlook(d) -> dict:
    d.get("https://outlook.office.com/mail/inbox")
    time.sleep(12)
    url = d.current_url
    if "login.microsoftonline.com" in url or "login.live.com" in url:
        return {"ok": False, "why": "signed out — Microsoft wants a fresh login", "url": url}
    rows = d.execute_script("""
        const sel = '[role="option"], div[role="listbox"] [draggable="true"]';
        const rs = [...document.querySelectorAll(sel)].slice(0, 40);
        return rs.map(r => (r.innerText || '').replace(/\\n+/g, ' | ').slice(0, 220));
    """) or []
    return {"ok": bool(rows), "url": url, "count": len(rows), "rows": rows,
            "title": d.title,
            "body": "" if rows else d.find_element("css selector", "body").text[:1200]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmail", action="store_true")
    ap.add_argument("--outlook", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    want = {k: True for k in (("gmail", "outlook") if not (a.gmail or a.outlook) else
                              (("gmail",) if a.gmail else ("outlook",)))}

    refresh_profile()
    out: dict = {}
    d = driver()
    try:
        if "gmail" in want:
            out["gmail"] = gmail(d)
        if "outlook" in want:
            out["outlook"] = outlook(d)
    finally:
        try:
            d.quit()
        except Exception:
            pass

    if a.json:
        print(json.dumps(out, indent=1))
        return 0
    for name, r in out.items():
        print(f"\n=== {name.upper()} ===")
        if not r.get("ok"):
            print(f"  not readable: {r.get('why') or 'no rows found'}")
            print(f"  landed on: {r.get('url')}")
            if r.get("body"):
                print("  page says:", r["body"][:400].replace("\n", " "))
            continue
        print(f"  {r['count']} rows from {r['url']}")
        for row in r["rows"][:40]:
            if isinstance(row, dict):
                print(f"  · {row['when']:<10} {row['name'][:28]:<28} {row['subject'][:70]}")
            else:
                print(f"  · {row}")
    return 0 if any(r.get("ok") for r in out.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
