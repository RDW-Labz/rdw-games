#!/usr/bin/env python3
"""Refuse to ship an app whose version would regress against the store.

WHY THIS EXISTS
───────────────
The same bug shipped twice in one week, in opposite directions, because
`version` in app.config.ts is just a string nobody compares against reality:

  bidder, 2026-08-09 — config sat at 0.1.1 while the App Store had released
    1.0.0. Apple refuses a binary that is not strictly above the approved
    version (ITMS-90062/90478/90186, the "Invalid Binary" rejections), so
    every upload bounced.

  staff, 2026-08-11 — two builds went up as version "1.0" while the rest of
    the train was "0.1.0". iOS compares CFBundleShortVersionString BEFORE the
    build number, so once a phone installed build 27 (1.0), builds 28-31
    (0.1.0) all read as downgrades and TestFlight stopped offering them. A
    staff iPhone sat on build 27 for eight days while four newer builds
    shipped past it.

Both also killed OTAs on the affected devices: `runtimeVersion.policy` is
`appVersion`, so a phone on 1.0 has runtime "1.0" while every update we
publish targets the config version. Binary channel and OTA channel die
together, for the same reason.

Neither is visible in the App Store Connect UI, which lists builds by
ascending BUILD NUMBER — the version anomaly hides in a column you have to
know to read. So it gets checked here instead.

THE INVARIANT
─────────────
Let V = `version` in the app's app.config.ts.

  A. V >= max(every TestFlight prerelease version)
     Equal is normal and expected: that is the build train incrementing its
     build number within one version. BELOW is the staff bug — a higher
     version already out there pins testers to it forever.

  B. V >  max(every App-Store-approved version)
     Strictly above, because Apple rejects anything else. Equal to a version
     still in review or in PREPARE_FOR_SUBMISSION is fine and normal — that
     is the version you are currently iterating builds for.

SEVERITY DEPENDS ON WHEN YOU ASK
────────────────────────────────
A is always an error. A version below the TestFlight max is broken no matter
when you notice it, and it is broken for testers right now.

B is an error at BUILD time and a warning at PR time, via
--appstore-floor-severity. Once a release goes live, V == the released version
is the repo's normal resting state — it stays there until someone starts the
next release. Failing every PR for that whole window would train people to
ignore this check, which is how the 08-09 and 08-11 bugs survived a code
review in the first place. At build time there is no such ambiguity: you are
about to produce a binary, and Apple will reject it.

Android is deliberately not checked. Play orders releases by versionCode,
which EAS manages server-side (`appVersionSource: remote` + `autoIncrement`),
so the string-ordering trap does not exist there. The OTA runtime concern
does apply to Android, but it is downstream of the same config value this
guard already pins to the iOS store.

USAGE
─────
    version_guard.py apps/bidder-app apps/field-mobile
    version_guard.py --self-test          # pure logic, no network, no secrets

Auth env vars (the same GHA secrets asc_status.py and eas-build.yml use):
    ASC_API_KEY, ASC_API_KEY_ID, ASC_API_KEY_ISSUER_ID

With --allow-missing-credentials the script exits 0 when those are absent,
so a fork PR without secrets does not hard-fail. The build-time gate in
eas-build.yml does NOT pass that flag: there, missing credentials are a
failure, because an unchecked build is exactly what this guards against.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.appstoreconnect.apple.com/v1'

# appStoreState values that mean Apple has approved this version. Anything
# beyond this set (PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, IN_REVIEW,
# REJECTED, METADATA_REJECTED, INVALID_BINARY, DEVELOPER_REJECTED) has never
# been approved, so it does not raise the floor a new binary must clear.
APPROVED_STATES = frozenset({
    'READY_FOR_SALE',
    'REPLACED_WITH_NEW_VERSION',
    'PENDING_APPLE_RELEASE',
    'PENDING_DEVELOPER_RELEASE',
    'PROCESSING_FOR_APP_STORE',
})

# The single top-level `version:` key in an Expo app.config.ts. Anchored to a
# two-space indent so it cannot match `runtimeVersion:`, a nested key, or a
# comment (comments start with `  //`). Exactly one match is required — see
# read_config_version.
VERSION_RE = re.compile(r"^  version:\s*['\"]([^'\"]+)['\"]\s*,?\s*$", re.MULTILINE)


# ── pure logic (covered by --self-test) ─────────────────────────────────────

def parse_version(text):
    """'1.0.1' -> (1, 0, 1). Returns None if it is not a numeric version.

    Apple compares CFBundleShortVersionString component-wise as integers with
    missing components treated as zero, which is why '1.0' outranks '0.1.0'
    and why '1.0' and '1.0.0' are the same version.
    """
    if not text:
        return None
    parts = text.strip().split('.')
    if not all(p.isdigit() for p in parts):
        return None
    nums = [int(p) for p in parts]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def highest(versions):
    """(raw, parsed) of the highest parseable version, or (None, None)."""
    parsed = [(v, parse_version(v)) for v in versions]
    usable = [(v, p) for v, p in parsed if p is not None]
    if not usable:
        return None, None
    return max(usable, key=lambda pair: pair[1])


def evaluate(config_version, prerelease_versions, appstore_versions):
    """Apply invariants A and B. Returns a list of (code, message) problems.

    appstore_versions is a list of (versionString, appStoreState) pairs; only
    the approved ones raise the floor.
    """
    config_parsed = parse_version(config_version)
    if config_parsed is None:
        return [(
            'UNPARSEABLE_VERSION',
            f'version "{config_version}" is not a numeric dotted version. '
            'Apple compares it component-wise as integers; a non-numeric '
            'version has no defined ordering against the store.',
        )]

    problems = []

    top_tf, top_tf_parsed = highest(prerelease_versions)
    if top_tf_parsed is not None and config_parsed < top_tf_parsed:
        problems.append((
            'TESTFLIGHT_REGRESSION',
            f'version {config_version} is BELOW TestFlight\'s highest version '
            f'{top_tf}. iOS compares the version string before the build '
            f'number, so every build you upload at {config_version} reads as a '
            f'downgrade on any device that already installed a {top_tf} build '
            f'— TestFlight will not offer it, and OTAs miss it too '
            f'(runtimeVersion policy is appVersion). Set version above '
            f'{top_tf}. This is the staff-app build-27 bug (2026-08-11).',
        ))

    approved = [v for v, state in appstore_versions if state in APPROVED_STATES]
    top_as, top_as_parsed = highest(approved)
    if top_as_parsed is not None and config_parsed <= top_as_parsed:
        relation = 'equal to' if config_parsed == top_as_parsed else 'BELOW'
        problems.append((
            'APPSTORE_REGRESSION',
            f'version {config_version} is {relation} the approved App Store '
            f'version {top_as}. Apple rejects any binary that is not strictly '
            f'above the previously approved version (ITMS-90062). Set version '
            f'above {top_as}. This is the bidder-app 0.1.1 bug (2026-08-09).',
        ))

    return problems


def extract_version(source):
    """Pull the top-level version string out of app.config.ts source.

    Returns (version, line_number). Raises ValueError unless exactly one
    top-level `version:` key is present — zero means the regex has drifted
    away from the file format and the guard would silently pass; more than one
    means we cannot tell which one Expo resolves.
    """
    matches = list(VERSION_RE.finditer(source))
    if len(matches) != 1:
        raise ValueError(
            f'expected exactly 1 top-level `version:` key, found {len(matches)}. '
            'The guard cannot resolve which version ships; fix app.config.ts or '
            'update VERSION_RE in this script.'
        )
    match = matches[0]
    return match.group(1), source.count('\n', 0, match.start()) + 1


# ── App Store Connect ───────────────────────────────────────────────────────

def token():
    import jwt  # PyJWT + cryptography for ES256; imported late so --self-test
                # runs on a bare interpreter.
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['ASC_API_KEY_ISSUER_ID'], 'iat': now,
         'exp': now + 19 * 60, 'aud': 'appstoreconnect-v1'},
        os.environ['ASC_API_KEY'],
        algorithm='ES256',
        headers={'kid': os.environ['ASC_API_KEY_ID']},
    )


def get_all(path):
    """GET every page of an ASC collection, following links.next."""
    url = API + path
    rows = []
    while url:
        req = urllib.request.Request(url)
        req.add_header('Authorization', f'Bearer {token()}')
        try:
            with urllib.request.urlopen(req) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            raise SystemExit(
                f'GET {url} -> HTTP {exc.code}\n{exc.read().decode(errors="replace")}'
            )
        rows.extend(payload.get('data', []))
        url = (payload.get('links') or {}).get('next')
    return rows


def store_versions(asc_app_id):
    """(prerelease version strings, [(appStoreVersion, state), ...])."""
    prereleases = [
        row['attributes'].get('version')
        for row in get_all(f'/apps/{asc_app_id}/preReleaseVersions?limit=200')
    ]
    appstore = [
        (row['attributes'].get('versionString'), row['attributes'].get('appStoreState'))
        for row in get_all(
            f'/apps/{asc_app_id}/appStoreVersions?filter[platform]=IOS&limit=200'
        )
    ]
    return [v for v in prereleases if v], [pair for pair in appstore if pair[0]]


# ── repo wiring ─────────────────────────────────────────────────────────────

def read_config_version(app_dir):
    path = os.path.join(app_dir, 'app.config.ts')
    with open(path, encoding='utf-8') as handle:
        source = handle.read()
    try:
        version, line = extract_version(source)
    except ValueError as exc:
        raise SystemExit(f'::error file={path}::{exc}')
    return version, path, line


def read_asc_app_id(app_dir):
    """ascAppId from eas.json, preferring the production submit profile.

    Same source of truth asc-status.yml reads, so the guard checks the app the
    release pipeline actually ships to.
    """
    path = os.path.join(app_dir, 'eas.json')
    with open(path, encoding='utf-8') as handle:
        config = json.load(handle)
    submit = config.get('submit') or {}
    for profile in ('production', *sorted(submit)):
        asc_id = ((submit.get(profile) or {}).get('ios') or {}).get('ascAppId')
        if asc_id:
            return str(asc_id)
    raise SystemExit(f'::error file={path}::no submit.*.ios.ascAppId found')


def check_app(app_dir, appstore_floor_severity='error'):
    """Returns True when the app has no error-severity problem.

    appstore_floor_severity downgrades invariant B to a warning for the PR
    check — see SEVERITY DEPENDS ON WHEN YOU ASK in the module docstring.
    """
    version, config_path, line = read_config_version(app_dir)
    asc_app_id = read_asc_app_id(app_dir)
    prereleases, appstore = store_versions(asc_app_id)

    top_tf, _ = highest(prereleases)
    approved = [v for v, state in appstore if state in APPROVED_STATES]
    top_as, _ = highest(approved)
    print(f'{app_dir}: config={version} asc_app={asc_app_id} '
          f'testflight_max={top_tf or "-"} appstore_approved_max={top_as or "-"}')

    severity_of = {'APPSTORE_REGRESSION': appstore_floor_severity}
    problems = evaluate(version, prereleases, appstore)
    failed = False
    for code, message in problems:
        level = severity_of.get(code, 'error')
        if level == 'warning':
            message += (' Not failing the PR: between releases this is the '
                        'repo\'s normal resting state. The build gate in '
                        'eas-build.yml WILL fail until it is bumped.')
        else:
            failed = True
        print(f'::{level} file={config_path},line={line}::{code}: {message}')
    if not problems:
        print(f'  OK — {version} clears both the TestFlight train and the App Store floor.')
    return not failed


# ── self-test ───────────────────────────────────────────────────────────────

def self_test():
    """Pure-logic assertions. No network, no secrets, no ASC account."""
    assert parse_version('1.0.1') == (1, 0, 1)
    assert parse_version('1.0') == (1, 0, 0), 'missing components are zero'
    assert parse_version('') is None
    assert parse_version('1.0.0-beta') is None, 'non-numeric has no ordering'
    assert parse_version('v1.0') is None

    # The ordering that caused both incidents.
    assert parse_version('1.0') > parse_version('0.1.0'), 'the staff-app trap'
    assert parse_version('1.0') == parse_version('1.0.0'), '1.0 and 1.0.0 are one version'
    assert parse_version('0.1.1') < parse_version('1.0.0'), 'the bidder-app trap'
    assert parse_version('1.0.10') > parse_version('1.0.9'), 'numeric, not lexical'

    assert highest(['0.1.0', '1.0', '0.1.0'])[0] == '1.0'
    assert highest([])[0] is None
    assert highest(['nonsense'])[0] is None, 'unparseable store data is skipped'
    assert highest(['nonsense', '2.0'])[0] == '2.0'

    codes = lambda problems: sorted(code for code, _ in problems)

    # Staff app on 2026-08-11: config 0.1.0, a stray 1.0 build on TestFlight,
    # nothing released to the App Store yet.
    assert codes(evaluate('0.1.0', ['0.1.0', '1.0'], [])) == ['TESTFLIGHT_REGRESSION']
    # The 1.0.1 fix clears it.
    assert evaluate('1.0.1', ['0.1.0', '1.0'], []) == []

    # Bidder app on 2026-08-09: config 0.1.1 against a released 1.0.0.
    assert codes(evaluate('0.1.1', ['0.1.1'], [('1.0.0', 'READY_FOR_SALE')])) == [
        'APPSTORE_REGRESSION'
    ]
    assert evaluate('1.0.1', ['0.1.1'], [('1.0.0', 'READY_FOR_SALE')]) == []

    # Equal to the released version is still a rejection.
    assert codes(evaluate('1.0.0', [], [('1.0.0', 'READY_FOR_SALE')])) == [
        'APPSTORE_REGRESSION'
    ]
    # Equal to a version still in review is the normal iterate-builds case.
    assert evaluate('1.0.1', ['1.0.1'], [('1.0.1', 'WAITING_FOR_REVIEW')]) == []
    assert evaluate('1.0.1', ['1.0.1'], [('1.0.1', 'REJECTED')]) == []
    assert evaluate('1.0.1', ['1.0.1'], [('1.0.1', 'PREPARE_FOR_SUBMISSION')]) == []

    # Equal to the TestFlight max is the normal build-train case.
    assert evaluate('0.1.0', ['0.1.0'], []) == []
    # A fresh app with no store history has no floor to clear.
    assert evaluate('1.0.0', [], []) == []
    # Both invariants can break at once.
    assert codes(evaluate('0.5.0', ['1.0'], [('0.9.0', 'READY_FOR_SALE')])) == [
        'APPSTORE_REGRESSION', 'TESTFLIGHT_REGRESSION'
    ]
    assert codes(evaluate('1.0.0-rc1', [], [])) == ['UNPARSEABLE_VERSION']

    # Severity split. The state that actually occurred on this guard's first
    # live run: bidder config 1.0.1 against an approved 1.0.1. It must fail a
    # build and merely warn a PR — between releases, sitting at the released
    # version is where the repo normally lives.
    import io
    from contextlib import redirect_stdout

    def run_check(config, prereleases, appstore, severity):
        """check_app with the store, config file, and eas.json stubbed out.

        Stubbed rather than pointed at the real apps so the assertions stay
        pinned to the scenario and cannot drift when a real version is bumped.
        """
        saved = store_versions, read_config_version, read_asc_app_id
        globals()['store_versions'] = lambda _id: (prereleases, appstore)
        globals()['read_config_version'] = lambda d: (config, 'app.config.ts', 27)
        globals()['read_asc_app_id'] = lambda d: '0000000000'
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                ok = check_app('apps/stub', severity)
        finally:
            (globals()['store_versions'], globals()['read_config_version'],
             globals()['read_asc_app_id']) = saved
        return ok, buf.getvalue()

    tie = ('1.0.1', ['1.0.1'], [('1.0.1', 'READY_FOR_SALE')])

    ok, out = run_check(*tie, 'error')
    assert ok is False, 'at build time an approved-version tie must fail'
    assert '::error file=' in out

    ok, out = run_check(*tie, 'warning')
    assert ok is True, 'at PR time an approved-version tie must not fail'
    assert '::warning file=' in out and '::error file=' not in out
    assert 'eas-build.yml WILL fail' in out, 'a warning must say where it becomes fatal'

    # Invariant A is never downgraded — a TestFlight regression fails a PR too.
    ok, out = run_check('0.1.0', ['1.0'], [], 'warning')
    assert ok is False, 'invariant A is never downgraded to a warning'
    assert '::error file=' in out and 'TESTFLIGHT_REGRESSION' in out

    # Config extraction: the real shape, comments and runtimeVersion included.
    source = (
        "const config: ExpoConfig = {\n"
        "  name: 'BinGo Auctions',\n"
        "  // 2026-08-11: 0.1.0 -> 1.0.1. version: '9.9.9' inside a comment.\n"
        "  version: '1.0.1',\n"
        "  ios: {\n"
        "    version: 'nested-should-not-match',\n"
        "  },\n"
        "  runtimeVersion: {\n"
        "    policy: 'appVersion',\n"
        "  },\n"
        "};\n"
    )
    assert extract_version(source) == ('1.0.1', 4)
    try:
        extract_version("const config = {\n  name: 'x',\n};\n")
    except ValueError:
        pass
    else:
        raise AssertionError('a config with no version must fail loudly, not pass')

    # The regex must survive the files actually in this repo.
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    for app in ('bidder-app', 'field-mobile'):
        path = os.path.join(repo, 'apps', app, 'app.config.ts')
        if os.path.exists(path):
            with open(path, encoding='utf-8') as handle:
                version, _ = extract_version(handle.read())
            assert parse_version(version) is not None, f'{app}: {version} is unparseable'
            print(f'  {app}: version {version} parses')

    print('self-test OK')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('app_dirs', nargs='*',
                        help='app directories to check, e.g. apps/bidder-app')
    parser.add_argument('--self-test', action='store_true',
                        help='run the pure-logic assertions and exit')
    parser.add_argument('--allow-missing-credentials', action='store_true',
                        help='exit 0 instead of failing when ASC secrets are absent')
    parser.add_argument('--appstore-floor-severity', choices=('error', 'warning'),
                        default='error',
                        help='severity for invariant B (version must exceed the '
                             'approved App Store version). error at build time; '
                             'warning for the PR check, where sitting at the '
                             'released version between releases is normal.')
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    if not args.app_dirs:
        parser.error('give at least one app directory, or --self-test')

    missing = [name for name in
               ('ASC_API_KEY', 'ASC_API_KEY_ID', 'ASC_API_KEY_ISSUER_ID')
               if not os.environ.get(name)]
    if missing:
        message = f'App Store Connect credentials not set: {", ".join(missing)}'
        if args.allow_missing_credentials:
            print(f'::notice::{message} — skipping the version guard.')
            return 0
        print(f'::error::{message}')
        return 1

    # Check every app before deciding — `all()` would short-circuit and hide a
    # second broken app behind the first one.
    results = [check_app(d, args.appstore_floor_severity) for d in args.app_dirs]
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
