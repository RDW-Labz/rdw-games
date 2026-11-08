#!/usr/bin/env python3
"""Print what Google Play is actually serving for an app — read-only.

The Android counterpart to asc_status.py, and it exists for the same reason
that one does: the store tells you nothing unless you ask. On 2026-09-17 an
audit of every delivery path could answer "what version do users have?" for
the web, the cron Worker, the database, both OTA channels and both iOS apps —
and could not answer it for Play, because nothing here could query it. The
bidder app's Android users had been stranded on an old runtime for six weeks
and the only reason anyone knew was that a person noticed.

Output ends with one machine-greppable line per track/release:

  PLAY <track> <status> version=<name> codes=<..> fraction=<..>

`status` is Play's own release status:
  completed  — live to 100% of the track
  inProgress — STAGED ROLLOUT, only `fraction` of users have it
  draft      — uploaded and waiting for a human to promote (eas submit
               uploads with releaseStatus=draft, so this is where a submit
               lands until play_promote.py or the Console moves it)
  halted     — rollout stopped

A submit that "succeeded" and a version users can install are not the same
event, and `draft` is the gap between them.

WHY THIS CREATES AN EDIT. The Publishing API exposes track state only inside
an edit transaction, so there is no way to read a track without opening one.
The edit is opened, read, and then DELETED — never committed. An uncommitted
edit changes nothing and expires on its own; deleting it just keeps the app's
edit list clean. Nothing in this script writes to the app, and it must stay
that way: this is the tool people reach for when they are worried, and it
should never be able to make things worse.

Auth: GOOGLE_PLAY_SERVICE_ACCOUNT_KEY — raw service-account JSON, the same
secret eas-submit.yml materializes and play_promote.py reads.

Usage: play_status.py <package_name> [track ...]
       defaults to: production beta alpha internal
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
DEFAULT_TRACKS = ['production', 'beta', 'alpha', 'internal']


def http(method, url, token=None, body=None, allow_404=False):
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
        # A track with no release ever is a 404, not an error worth failing on
        # — an app with nothing on `beta` is the normal case, and a status tool
        # that dies on the normal case is useless.
        if allow_404 and e.code == 404:
            return None
        detail = e.read().decode(errors='replace')
        raise SystemExit(f'{method} {url} -> HTTP {e.code}\n{detail}')


def access_token(sa):
    """Service-account JWT -> OAuth access token. Same grant play_promote uses."""
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
    if len(sys.argv) < 2:
        raise SystemExit('usage: play_status.py <package_name> [track ...]')
    pkg = sys.argv[1]
    tracks = sys.argv[2:] or DEFAULT_TRACKS

    sa = json.loads(os.environ['GOOGLE_PLAY_SERVICE_ACCOUNT_KEY'])
    token = access_token(sa)

    edit = http('POST', f'{API}/{pkg}/edits', token, {})
    eid = edit['id']
    try:
        print(f'APP {pkg}')
        found_any = False
        for name in tracks:
            track = http('GET', f'{API}/{pkg}/edits/{eid}/tracks/{name}',
                         token, allow_404=True)
            if track is None:
                print(f'PLAY {name} (no track)')
                continue
            releases = track.get('releases', [])
            if not releases:
                print(f'PLAY {name} (no releases)')
                continue
            for r in releases:
                found_any = True
                frac = r.get('userFraction')
                # inProgress without a fraction still means a partial rollout;
                # printing "-" there would read as "everyone has it".
                frac_s = (f'{float(frac) * 100:.0f}%' if frac is not None
                          else ('partial' if r.get('status') == 'inProgress' else '100%'))
                print(
                    f'PLAY {name} {r.get("status")} '
                    f'version={r.get("name") or "-"} '
                    f'codes={",".join(str(c) for c in r.get("versionCodes") or []) or "-"} '
                    f'fraction={frac_s}'
                )
        if not found_any:
            print('PLAY (no releases on any requested track)')
    finally:
        # Always drop the edit, including on the way out of an exception, so a
        # failed run cannot leave an open transaction behind.
        try:
            http('DELETE', f'{API}/{pkg}/edits/{eid}', token, allow_404=True)
        except SystemExit:
            print(f'WARNING: could not delete edit {eid}; it will expire on its own.')


if __name__ == '__main__':
    main()
