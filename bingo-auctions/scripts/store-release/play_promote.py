#!/usr/bin/env python3
"""Promote the newest DRAFT release on a Play track to live (status=completed).

eas submit runs with releaseStatus=draft (eas.json), so every Android submit
lands in Play Console as a draft the owner must promote by hand. This script
is that promotion, callable from CI: find the draft on the track, flip it to
completed (100% rollout), commit the edit.

Auth: GOOGLE_PLAY_SERVICE_ACCOUNT_KEY env var — the raw JSON of the service
account key (same secret eas-build.yml materializes for eas submit).

Usage: play_promote.py <package_name> [track]

Exit codes: 0 promoted (or nothing to do — idempotent), 1 real failure.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

import jwt  # PyJWT

TOKEN_URL = 'https://oauth2.googleapis.com/token'
API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'


def http(method, url, token=None, body=None):
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        raise SystemExit(f'{method} {url} -> HTTP {e.code}\n{detail}')


def access_token(sa):
    now = int(time.time())
    assertion = jwt.encode(
        {
            'iss': sa['client_email'],
            'scope': 'https://www.googleapis.com/auth/androidpublisher',
            'aud': TOKEN_URL,
            'iat': now,
            'exp': now + 600,
        },
        sa['private_key'],
        algorithm='RS256',
    )
    data = urllib.parse.urlencode({
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion': assertion,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, method='POST')
    with urllib.request.urlopen(req) as r:
        return json.load(r)['access_token']


def main():
    pkg = sys.argv[1]
    track_name = sys.argv[2] if len(sys.argv) > 2 else 'production'
    sa = json.loads(os.environ['GOOGLE_PLAY_SERVICE_ACCOUNT_KEY'])
    token = access_token(sa)

    edit = http('POST', f'{API}/{pkg}/edits', token, {})
    eid = edit['id']
    track = http('GET', f'{API}/{pkg}/edits/{eid}/tracks/{track_name}', token)
    releases = track.get('releases', [])
    print(f'{pkg} {track_name}: '
          + json.dumps([{k: r.get(k) for k in ("name", "status", "versionCodes")}
                        for r in releases]))

    drafts = [r for r in releases if r.get('status') == 'draft']
    if not drafts:
        print('No draft release on the track — nothing to promote (already live?).')
        return

    # Promoting the draft to completed makes it THE live release; Play retires
    # the previous completed release on the same track automatically.
    draft = drafts[0]
    draft['status'] = 'completed'
    draft.pop('userFraction', None)  # completed = full rollout; fraction invalid
    new_releases = [draft] + [r for r in releases if r.get('status') != 'draft'
                              and r.get('status') != 'completed']
    http('PUT', f'{API}/{pkg}/edits/{eid}/tracks/{track_name}', token,
         {'track': track_name, 'releases': new_releases})
    committed = http('POST', f'{API}/{pkg}/edits/{eid}:commit', token, None)
    print(f'Promoted {draft.get("name")} (versionCodes={draft.get("versionCodes")}) '
          f'to live on {track_name}. Edit {committed.get("id")} committed.')


if __name__ == '__main__':
    main()
