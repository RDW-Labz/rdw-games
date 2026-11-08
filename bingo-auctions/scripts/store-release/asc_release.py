#!/usr/bin/env python3
"""Submit the newest processed build for App Store review, auto-release on approval.

eas submit only UPLOADS the binary — it lands in App Store Connect / TestFlight
and someone must still attach it to an App Store version and submit that
version for review. This script is that step, callable from CI:

  1. Wait for the newest build of the given version string to finish PROCESSING.
  2. Find an editable App Store version (PREPARE_FOR_SUBMISSION / rejected
     states) or create one for the version string.
  3. Attach the build, set releaseType=AFTER_APPROVAL, fill "What's New".
  4. Submit via the reviewSubmissions API (the appStoreVersionSubmissions
     endpoint is deprecated).

Apple review still gates the actual release — AFTER_APPROVAL means it goes
live the moment they approve, with no further human step.

Auth env vars (same GHA secrets eas-build.yml uses):
  ASC_API_KEY           raw .p8 PEM text
  ASC_API_KEY_ID        key id
  ASC_API_KEY_ISSUER_ID issuer id

Usage: asc_release.py <asc_app_id> <version_string> <whats_new text>

Exit codes: 0 submitted (or already in review — idempotent), 1 real failure.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

import jwt  # PyJWT + cryptography for ES256

API = 'https://api.appstoreconnect.apple.com/v1'

EDITABLE_STATES = {
    'PREPARE_FOR_SUBMISSION', 'METADATA_REJECTED', 'REJECTED',
    'DEVELOPER_REJECTED', 'INVALID_BINARY',
}
IN_REVIEW_STATES = {'WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'}


def token():
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['ASC_API_KEY_ISSUER_ID'], 'iat': now,
         'exp': now + 19 * 60, 'aud': 'appstoreconnect-v1'},
        os.environ['ASC_API_KEY'],
        algorithm='ES256',
        headers={'kid': os.environ['ASC_API_KEY_ID']},
    )


def http(method, path, body=None, ok=()):
    """ok: HTTP status codes to swallow (returns None instead of exiting)."""
    url = path if path.startswith('http') else API + path
    req = urllib.request.Request(url, method=method)
    req.add_header('Authorization', f'Bearer {token()}')
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
        if e.code in ok:
            print(f'{method} {url} -> HTTP {e.code} (tolerated)\n{detail}')
            return None
        raise SystemExit(f'{method} {url} -> HTTP {e.code}\n{detail}')


def newest_processed_build(app_id, version):
    """Wait for the newest build of `version` to leave PROCESSING; return its id."""
    deadline = time.time() + 45 * 60
    while True:
        r = http('GET', f'/builds?filter[app]={app_id}'
                        f'&filter[preReleaseVersion.version]={version}'
                        f'&sort=-uploadedDate&limit=5')
        builds = r.get('data', [])
        if builds:
            b = builds[0]
            state = b['attributes']['processingState']
            print(f'build {b["attributes"]["version"]} ({b["id"]}): {state}')
            if state == 'VALID':
                return b['id']
            if state in ('FAILED', 'INVALID'):
                raise SystemExit(f'Newest build is {state} — cannot release it.')
        else:
            print(f'No builds for version {version} yet — waiting on upload/processing…')
        if time.time() > deadline:
            raise SystemExit('Timed out waiting for a processed (VALID) build.')
        time.sleep(60)


def editable_version(app_id, version):
    r = http('GET', f'/apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=10')
    for v in r.get('data', []):
        a = v['attributes']
        print(f'appStoreVersion {a["versionString"]}: {a["appStoreState"]}')
        if a['appStoreState'] in IN_REVIEW_STATES:
            raise SystemExit(
                f'Version {a["versionString"]} is already {a["appStoreState"]} — '
                'not stacking a second submission. Resolve that one first.')
        if a['appStoreState'] in EDITABLE_STATES:
            if a['versionString'] != version:
                # Editable shell exists under an older string — reuse it, but
                # move it to the version we are shipping.
                http('PATCH', f'/appStoreVersions/{v["id"]}', {
                    'data': {'type': 'appStoreVersions', 'id': v['id'],
                             'attributes': {'versionString': version}}})
            return v['id']
    created = http('POST', '/appStoreVersions', {
        'data': {
            'type': 'appStoreVersions',
            'attributes': {'platform': 'IOS', 'versionString': version},
            'relationships': {'app': {'data': {'type': 'apps', 'id': app_id}}},
        }})
    return created['data']['id']


def main():
    app_id, version, whats_new = sys.argv[1], sys.argv[2], sys.argv[3]

    build_id = newest_processed_build(app_id, version)
    version_id = editable_version(app_id, version)

    http('PATCH', f'/appStoreVersions/{version_id}', {
        'data': {'type': 'appStoreVersions', 'id': version_id,
                 'attributes': {'releaseType': 'AFTER_APPROVAL'}}})
    http('PATCH', f'/appStoreVersions/{version_id}/relationships/build', {
        'data': {'type': 'builds', 'id': build_id}})

    # "What's New" is required on UPDATES but does not exist on an app's FIRST
    # release — ASC answers 409 STATE_ERROR "Attribute 'whatsNew' cannot be
    # edited at this time" (seen on the staff app 2026-08-09, whose 1.0 was
    # REJECTED and never released). Tolerate that and submit without it.
    locs = http('GET', f'/appStoreVersions/{version_id}/appStoreVersionLocalizations')
    for loc in locs.get('data', []):
        http('PATCH', f'/appStoreVersionLocalizations/{loc["id"]}', {
            'data': {'type': 'appStoreVersionLocalizations', 'id': loc['id'],
                     'attributes': {'whatsNew': whats_new}}}, ok=(409,))

    # An app whose last review was REJECTED keeps its version attached to the
    # ORIGINAL reviewSubmission (state UNRESOLVED_ISSUES) — Apple's flow is
    # resubmit-that-submission, and a fresh POST dies with
    # STATE_ERROR.ITEM_PART_OF_ANOTHER_SUBMISSION (staff app, 2026-08-09).
    # And an aborted earlier run can leave an EMPTY open submission lying
    # around; submitting that one is refused with 'must have an
    # appStoreVersions included'. So: pick the open submission that actually
    # CONTAINS our version; fall back to an empty open one; create only when
    # neither exists. Cancel leftover empties we didn't use.
    sub_id = None
    empty_subs = []
    item_versions = set()  # of the submission we settle on (see break below)
    subs = http('GET', f'/apps/{app_id}/reviewSubmissions?filter[platform]=IOS&limit=10')
    for sitem in (subs or {}).get('data', []):
        st = sitem['attributes']['state']
        if st in ('WAITING_FOR_REVIEW', 'IN_REVIEW'):
            raise SystemExit(
                f'A review submission is already {st} — not stacking another.')
        if st not in ('READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'):
            print(f'reviewSubmission {sitem["id"]}: {st} (ignored)')
            continue
        items = http('GET', f'/reviewSubmissions/{sitem["id"]}/items'
                            '?include=appStoreVersion&limit=50')
        item_versions.clear()
        rejected_item_ids = []
        for it in (items or {}).get('data', []):
            rel = ((it.get('relationships') or {})
                   .get('appStoreVersion', {}) or {}).get('data') or {}
            item_state = (it.get('attributes') or {}).get('state')
            print(f'  item {it["id"]}: state={item_state} version={rel.get("id")}')
            if rel.get('id'):
                item_versions.add(rel['id'])
                # Apple's rejection-recovery flow: a REJECTED item must be
                # REMOVED from the submission and re-added after changes —
                # resubmitting over it answers only 'not ready to be
                # submitted yet' forever (bidder 1.0.1, 2026-08-09).
                if item_state == 'REJECTED' and rel.get('id') == version_id:
                    rejected_item_ids.append(it['id'])
        for inc in (items or {}).get('included', []):
            if inc.get('type') == 'appStoreVersions':
                item_versions.add(inc['id'])
        print(f'reviewSubmission {sitem["id"]}: {st}, versions={sorted(item_versions)}')
        if version_id in item_versions:
            if rejected_item_ids:
                # A submitted-then-rejected container is immutable: DELETE of
                # its item answers 409 'Item was already submitted'. The
                # programmatic recovery is to CANCEL the whole rejected
                # submission, which frees the version for a fresh one.
                print(f'canceling rejected submission {sitem["id"]} to free the version')
                http('PATCH', f'/reviewSubmissions/{sitem["id"]}', {
                    'data': {'type': 'reviewSubmissions', 'id': sitem['id'],
                             'attributes': {'canceled': True}}})
                item_versions.clear()
                continue  # fall through to create a fresh submission
            sub_id = sitem['id']
            break
        if not item_versions:
            empty_subs.append(sitem['id'])
    already_attached = sub_id is not None and version_id in item_versions
    if sub_id is None and empty_subs:
        sub_id = empty_subs.pop(0)
    if sub_id is None:
        sub = http('POST', '/reviewSubmissions', {
            'data': {'type': 'reviewSubmissions',
                     'attributes': {'platform': 'IOS'},
                     'relationships': {'app': {'data': {'type': 'apps', 'id': app_id}}}}})
        sub_id = sub['data']['id']
    if not already_attached:
        # Canceling a rejected submission frees its version ASYNCHRONOUSLY —
        # adding the item to the new submission one second later still answers
        # ITEM_PART_OF_ANOTHER_SUBMISSION naming the canceled one (attempt #4,
        # 2026-08-09). Wait out the propagation.
        for attempt in range(1, 11):
            try:
                http('POST', '/reviewSubmissionItems', {
                    'data': {'type': 'reviewSubmissionItems',
                             'relationships': {
                                 'reviewSubmission': {'data': {'type': 'reviewSubmissions', 'id': sub_id}},
                                 'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': version_id}},
                             }}})
                break
            except SystemExit as e:
                if 'ITEM_PART_OF_ANOTHER_SUBMISSION' in str(e) and attempt < 10:
                    print(f'version still attached to the canceled submission '
                          f'(attempt {attempt}/10) — waiting 30s for cancellation to propagate…')
                    time.sleep(30)
                    continue
                raise
    # Best-effort: cancel stray empty submissions so they can't confuse the
    # next run (or a human in the ASC UI).
    for stray in empty_subs:
        http('PATCH', f'/reviewSubmissions/{stray}', {
            'data': {'type': 'reviewSubmissions', 'id': stray,
                     'attributes': {'canceled': True}}}, ok=(409,))
    # ASC answers 'Version is not ready to be submitted yet, please try again
    # later' for a short window after a build is attached (post-processing
    # linkage; seen 2026-08-09 one second after attaching bidder build 21).
    # Take it literally: retry with a pause, up to ~15 minutes, and only fail
    # on a different error or on exhaustion.
    for attempt in range(1, 16):
        try:
            http('PATCH', f'/reviewSubmissions/{sub_id}', {
                'data': {'type': 'reviewSubmissions', 'id': sub_id,
                         'attributes': {'submitted': True}}})
            break
        except SystemExit as e:
            if 'not ready to be submitted yet' in str(e) and attempt < 15:
                print(f'ASC says not-ready (attempt {attempt}/15) — waiting 60s…')
                time.sleep(60)
                continue
            raise
    print(f'Submitted version {version} (build {build_id}) for review; '
          'releaseType=AFTER_APPROVAL — goes live automatically when Apple approves.')


if __name__ == '__main__':
    main()
