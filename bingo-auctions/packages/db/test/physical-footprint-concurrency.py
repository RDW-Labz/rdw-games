#!/usr/bin/env python3
"""Repeatable two-session tests ONLY for the disposable footprint fixture.

Requires explicit loopback host, port, database and user; no production target
or environment-derived connection defaults. Load physical-footprint-schema.sql
and migration0369 first. Creates then removes one randomly identified test lot.
No third-party Python packages required.
"""
import argparse
import os
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True, choices=['127.0.0.1', '::1'])
parser.add_argument('--port', required=True, type=int)
parser.add_argument('--database', required=True)
parser.add_argument('--user', required=True)
parser.add_argument('--psql', default='psql')
args = parser.parse_args()
if not 1 <= args.port <= 65535:
    parser.error('port must be 1..65535')
PSQL = [args.psql, '-X', '-h', args.host, '-p', str(args.port), '-U', args.user,
        '-d', args.database, '-v', 'ON_ERROR_STOP=1', '-At']
ENV = {**os.environ, 'PGCONNECT_TIMEOUT': '5'}
lot_id = str(uuid.uuid4())
holders = []

def run(sql):
    return subprocess.run(PSQL + ['-f', '-'], input=sql, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          env=ENV, timeout=40)

def holder(sql):
    # Separate stdin statements, not one -c multi-statement query: the latter
    # reports READY only after the whole query, including sleep/release, ends.
    p = subprocess.Popen(PSQL + ['-f', '-'], text=True, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV)
    holders.append(p)
    p.stdin.write(sql.replace(';', ';\n'))
    p.stdin.flush()
    p.stdin.close()
    p.stdin = None
    while True:
        line = p.stdout.readline()
        if not line:
            raise RuntimeError('holder failed before readiness')
        if line.strip() == 'READY':
            return p

def finish(p):
    output, _ = p.communicate(timeout=10)
    if p.returncode != 0:
        raise RuntimeError('holder failed: ' + output)

def require_ok(result):
    print(result.stdout, end='')
    if result.returncode != 0:
        raise RuntimeError('fixture assertion failed')

check = run('SELECT fixture FROM public.physical_footprint_fixture_marker;')
if check.returncode != 0 or check.stdout.strip() != 't':
    raise RuntimeError('refusing concurrency tests without the isolated fixture marker')

WRITER_TEST = r"""\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='200ms';
DO $$
DECLARE q text; blocked integer := 0;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    $q$INSERT INTO public.lots(id,operator_id) VALUES('{lot_id}','00000000-0000-0000-0000-000000000001')$q$,
    $q$INSERT INTO public.bin_assignments(lot_id,bin_id) VALUES('{lot_id}','00000000-0000-0000-0000-000000000099')$q$,
    $q$INSERT INTO public.lot_location_events(lot_id,bin_id) VALUES('{lot_id}',NULL)$q$,
    $q$INSERT INTO public.lot_sticker_pool(claimed_by_lot_id) VALUES('{lot_id}')$q$
  ] LOOP
    BEGIN EXECUTE q;
    EXCEPTION WHEN lock_not_available THEN blocked := blocked + 1;
    END;
  END LOOP;
  IF blocked <> 4 THEN RAISE EXCEPTION 'concurrent footprint writers escaped locks: blocked %/4',blocked; END IF;
END $$;
ROLLBACK;
\echo 'all four concurrent footprint writers blocked'
"""

POST_LOCK_TEST = r"""\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$ DECLARE refused boolean := false; BEGIN
  BEGIN PERFORM public.assert_no_physical_footprint(ARRAY['{lot_id}']::uuid[]);
  EXCEPTION WHEN raise_exception THEN
    IF position('physical evidence exists' IN SQLERRM)=0 THEN RAISE; END IF;
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'missed footprint committed while waiting for lock'; END IF;
END $$;
ROLLBACK;
\echo 'post-lock fresh snapshot observed preceding writer'
"""

ISOLATION_TEST = r"""\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ DECLARE refused boolean := false; BEGIN
  BEGIN PERFORM public.assert_no_physical_footprint(ARRAY[]::uuid[]);
  EXCEPTION WHEN raise_exception THEN
    IF position('requires READ COMMITTED' IN SQLERRM)=0 THEN RAISE; END IF;
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'stale snapshot isolation was accepted'; END IF;
END $$;
ROLLBACK;
\echo 'repeatable-read snapshot refused'
"""

try:
    # Guard first: INSERT writers to every evidence table must block.
    p = holder("BEGIN; SET LOCAL statement_timeout='30s'; SELECT public.assert_no_physical_footprint(ARRAY[]::uuid[]); SELECT 'READY'; SELECT pg_sleep(3); ROLLBACK;")
    require_ok(run(WRITER_TEST.replace("{lot_id}", lot_id)))
    finish(p)
    # Writer first: fresh post-lock snapshot must see its committed sticker.
    p = holder(f"BEGIN; SET LOCAL statement_timeout='30s'; INSERT INTO public.lots(id,operator_id,sticker_code) VALUES('{lot_id}','00000000-0000-0000-0000-000000000001','concurrency-fixture'); SELECT 'READY'; SELECT pg_sleep(2); COMMIT;")
    require_ok(run(POST_LOCK_TEST.replace("{lot_id}", lot_id)))
    finish(p)
    # Longer-held writer lock must produce an error within the guard bound.
    p = holder("BEGIN; SET LOCAL statement_timeout='30s'; LOCK TABLE public.lots IN ROW EXCLUSIVE MODE; SELECT 'READY'; SELECT pg_sleep(7); ROLLBACK;")
    started = time.monotonic()
    result = run("BEGIN; SET LOCAL statement_timeout='30s'; SELECT public.assert_no_physical_footprint(ARRAY[]::uuid[]); ROLLBACK;")
    elapsed = time.monotonic() - started
    print(result.stdout, "lock timeout seconds", round(elapsed, 2))
    if result.returncode == 0 or "lock timeout" not in result.stdout or not 4.5 < elapsed < 7:
        raise RuntimeError("guard did not fail within its lock timeout")
    finish(p)
    require_ok(run(ISOLATION_TEST))
    print("two-session writer blocking, fresh snapshot, bounded timeout, isolation refusal: PASS")
finally:
    for p in holders:
        if p.poll() is None:
            p.terminate()
            p.communicate(timeout=10)
    cleanup = run(f"DELETE FROM public.lots WHERE id='{lot_id}';")
    if cleanup.returncode != 0:
        raise RuntimeError("failed to remove this run's isolated fixture lot")
