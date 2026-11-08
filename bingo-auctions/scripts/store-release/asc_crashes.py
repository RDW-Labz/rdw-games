#!/usr/bin/env python3
"""Download TestFlight crash submissions for one app (read-only, GET only).

Lists the app's TestFlight crash feedback (betaFeedbackCrashSubmissions) newer
than N days and fetches each one's crash log. Writes:

  <out>/crashes.json  submission metadata (build, device, OS, time, comment)
  <out>/crash-<id>.txt  the crash log text, one file per submission

Tester identity fields (email, names) are dropped before writing: the output
is uploaded as a workflow artifact.

Auth env vars (same GHA secrets as asc_status.py):
  ASC_API_KEY, ASC_API_KEY_ID, ASC_API_KEY_ISSUER_ID

Usage: asc_crashes.py <asc_app_id> <days> <out_dir>
"""

import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt  # PyJWT + cryptography for ES256

API = 'https://api.appstoreconnect.apple.com'
PII_KEYS = {'email', 'testerEmail', 'firstName', 'lastName', 'testerName'}


def token():
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['ASC_API_KEY_ISSUER_ID'], 'iat': now,
         'exp': now + 19 * 60, 'aud': 'appstoreconnect-v1'},
        os.environ['ASC_API_KEY'],
        algorithm='ES256',
        headers={'kid': os.environ['ASC_API_KEY_ID']},
    )


def get(url):
    if url.startswith('/'):
        url = API + url
    req = urllib.request.Request(url, method='GET')
    req.add_header('Authorization', f'Bearer {token()}')
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'GET {url} -> HTTP {e.code}\n{e.read().decode(errors="replace")}')


def parse_time(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None


def main():
    app_id, days, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    os.makedirs(out, exist_ok=True)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)

    rows = []
    url = f'/v1/apps/{app_id}/betaFeedbackCrashSubmissions?sort=-createdDate&limit=50'
    while url:
        page = get(url)
        stop = False
        for s in page.get('data', []):
            a = {k: v for k, v in s.get('attributes', {}).items() if k not in PII_KEYS}
            created = parse_time(a.get('createdDate'))
            if created and created < cutoff:
                stop = True
                break
            rows.append({'id': s['id'], **a})
        url = None if stop else page.get('links', {}).get('next')

    for r in rows:
        log = get(f'/v1/betaFeedbackCrashSubmissions/{r["id"]}/crashLog')
        text = (log.get('data') or {}).get('attributes', {}).get('logText') or ''
        with open(os.path.join(out, f'crash-{r["id"]}.txt'), 'w') as f:
            f.write(text)
        r['crashLogFile'] = f'crash-{r["id"]}.txt'
        r['crashLogBytes'] = len(text)

    with open(os.path.join(out, 'crashes.json'), 'w') as f:
        json.dump(rows, f, indent=2)

    print(f'{len(rows)} TestFlight crash submission(s) in the last {days} day(s)')
    for r in rows:
        print(f'CRASH {r.get("createdDate")} build={r.get("buildBundleId") or r.get("appBuild") or "?"} '
              f'device={r.get("deviceModel") or "?"} os={r.get("osVersion") or "?"} '
              f'log={r["crashLogBytes"]}B id={r["id"]}')


if __name__ == '__main__':
    main()
