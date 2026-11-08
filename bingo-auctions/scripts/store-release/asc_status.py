#!/usr/bin/env python3
"""Print the App Store review state for an app — read-only, no side effects.

Apple has no webhook for review decisions, so "tell me when it's approved"
means polling. This is the poll target: it lists the app's appStoreVersions
and recent reviewSubmissions and ends with one machine-greppable line per
version:

  STATUS <versionString> <appStoreState>

READY_FOR_SALE = approved and live (releaseType=AFTER_APPROVAL releases
immediately). REJECTED / METADATA_REJECTED = review failed. WAITING_FOR_REVIEW
/ IN_REVIEW = still queued.

Auth env vars (same GHA secrets store-release.yml uses):
  ASC_API_KEY, ASC_API_KEY_ID, ASC_API_KEY_ISSUER_ID

Usage: asc_status.py <asc_app_id>
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

import jwt  # PyJWT + cryptography for ES256

API = 'https://api.appstoreconnect.apple.com/v1'


def token():
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['ASC_API_KEY_ISSUER_ID'], 'iat': now,
         'exp': now + 19 * 60, 'aud': 'appstoreconnect-v1'},
        os.environ['ASC_API_KEY'],
        algorithm='ES256',
        headers={'kid': os.environ['ASC_API_KEY_ID']},
    )


def get(path):
    req = urllib.request.Request(API + path)
    req.add_header('Authorization', f'Bearer {token()}')
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'GET {path} -> HTTP {e.code}\n{e.read().decode(errors="replace")}')


def main():
    app_id = sys.argv[1]

    subs = get(f'/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=5')
    for s in subs.get('data', []):
        a = s['attributes']
        print(f'reviewSubmission {s["id"]}: {a["state"]} (submitted {a.get("submittedDate")})')

    versions = get(f'/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=10')
    for v in versions.get('data', []):
        a = v['attributes']
        print(f'STATUS {a["versionString"]} {a["appStoreState"]}')

    # TestFlight side. A tester's device only offers a build it considers NEWER
    # than the installed one, and iOS compares the VERSION STRING first — so one
    # stray build at a higher version silently pins everybody to it and every
    # later build reads as a downgrade (staff app, build 27 at 1.0 vs the 0.1.0
    # train, reported 2026-08-11). Printing version alongside build number makes
    # that visible; without it the ASC list just looks like ascending builds.
    print('--- TestFlight builds (newest first) ---')
    builds = get(f'/builds?filter[app]={app_id}&sort=-uploadedDate&limit=12'
                 '&include=preReleaseVersion,betaGroups')
    pre_by_id = {i['id']: i for i in builds.get('included', [])
                 if i.get('type') == 'preReleaseVersions'}
    grp_by_id = {i['id']: i for i in builds.get('included', [])
                 if i.get('type') == 'betaGroups'}
    for b in builds.get('data', []):
        a = b['attributes']
        rel = b.get('relationships') or {}
        pre = (rel.get('preReleaseVersion') or {}).get('data') or {}
        ver = ((pre_by_id.get(pre.get('id')) or {}).get('attributes') or {}).get('version', '?')
        grp_ids = [g['id'] for g in ((rel.get('betaGroups') or {}).get('data') or [])]
        grps = ', '.join(
            ((grp_by_id.get(g) or {}).get('attributes') or {}).get('name', g) for g in grp_ids
        ) or 'NO GROUP'
        print(f'BUILD version={ver} build={a.get("version")} '
              f'processing={a.get("processingState")} expired={a.get("expired")} '
              f'uploaded={(a.get("uploadedDate") or "")[:10]} groups=[{grps}]')


if __name__ == '__main__':
    main()
