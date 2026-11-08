# 0453 proof on the Docker prod copy (rig0431: pgvector/pgvector:pg16, template
# DB `postgres` = master migration replay incl. 0263 + 0350). Copy this folder,
# the migration, its rollback, 0446 and 0451 into the container as /w453/:
#   docker exec rig0431 mkdir -p /w453
#   docker cp scripts/prod-rig/0453-rig/. rig0431:/w453/
#   docker cp ~/Documents/bingo-migrations-pending/0453_sqft_place_bid_per_unit.sql rig0431:/w453/
#   docker cp ~/Documents/bingo-migrations-pending/0446_bid_sources.sql rig0431:/w453/
#   docker cp packages/db/migrations/0451_sqft_bid_mode_unit_qty.sql rig0431:/w453/
#   docker cp scripts/prod-rig/0453_ROLLBACK_sqft_place_bid_per_unit.sql rig0431:/w453/
#   docker cp packages/db/test/place_bid_self_raise_guard.sql packages/db/test/min_bid_increment_cents.sql \
#             packages/db/test/app_read_paths_smoke.sql scripts/prod-rig/finalize-scenario.sql rig0431:/w453/
#   docker exec rig0431 bash /w453/run.sh                 (exit code = failures)
# Then, on the host:
#   zsh scripts/prod-rig/0453-rig/postgrest.sh             (real PostgREST overload resolution)
#   docker exec rig0431 bash /w453/conc-before.sh 12       (pre-existing race, pre-0453 only)
# The migration and rollback are GENERATED from 0263 + 0350 by gen-0453.py:
#   python3 scripts/prod-rig/0453-rig/gen-0453.py . <migration out> <rollback out>
# Never touches prod. Synthetic data only (example.test).
MIG=/w453/0453_sqft_place_bid_per_unit.sql
RB=/w453/0453_ROLLBACK_sqft_place_bid_per_unit.sql
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
clone() { psql -q -U postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1; psql -q -U postgres -c "CREATE DATABASE $1 TEMPLATE $2" || exit 1; }
FD="select md5(pg_get_functiondef('public.place_bid(uuid,bigint)'::regprocedure))"
ACL="select string_agg(a.grantee::regrole || ':' || a.privilege_type, ',' order by a.grantee::regrole::text) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.place_bid(uuid,bigint)'::regprocedure"
fail=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fail=$((fail+1)); }

echo "===== 0. base: template + 0446 (bid_sources trigger) + 0451 + seed"
bash /w453/build-base.sh 2>&1 | grep '^base:'
clone s453plain postgres
P -d s453plain -c "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text"
P -d s453plain -f /w453/0446_bid_sources.sql >/dev/null && P -d s453plain -f /w453/0451_sqft_bid_mode_unit_qty.sql 2>/dev/null
PRE_FD=$(P -d s453base -c "$FD"); PRE_ACL=$(P -d s453base -c "$ACL")
echo "pre-0453 functiondef md5=$PRE_FD acl=$PRE_ACL"

echo "===== 1. apply 0453 (timed), re-apply (idempotent)"
clone s453a s453base; clone s453b s453base
s=$(date +%s%N); P -d s453b -f $MIG || { bad "apply"; exit 1; }; echo "apply ok $(( ($(date +%s%N)-s)/1000000 )) ms"
s=$(date +%s%N); P -d s453b -f $MIG || { bad "re-apply"; exit 1; }; echo "re-apply ok $(( ($(date +%s%N)-s)/1000000 )) ms"
P -d s453b -c "select 'overloads: ' || string_agg(oid::regprocedure::text || ' secdef=' || prosecdef || ' cfg=' || array_to_string(proconfig, ','), ' | ') from pg_proc where proname='place_bid'"
P -d s453b -c "select '3-arg has no defaults: ' || (pronargdefaults = 0) from pg_proc where oid='public.place_bid(uuid,bigint,integer)'::regprocedure"
A2=$(P -d s453b -c "$ACL"); A3=$(P -d s453b -c "${ACL/uuid,bigint)/uuid,bigint,integer)}")
[ "$A2" = "$PRE_ACL" ] && [ "$A3" = "$PRE_ACL" ] && ok "grants: 2-arg unchanged and 3-arg identical ($A3)" || bad "grants 2-arg=$A2 3-arg=$A3 pre=$PRE_ACL"

echo "===== 2. 2-arg body = live body + only the refusal block (diff of pg_get_functiondef)"
P -d s453a -c "select pg_get_functiondef('public.place_bid(uuid,bigint)'::regprocedure)" > /tmp/fd_pre.sql
P -d s453b -c "select pg_get_functiondef('public.place_bid(uuid,bigint)'::regprocedure)" > /tmp/fd_post.sql
diff /tmp/fd_pre.sql /tmp/fd_post.sql; echo "(diff above: expect one added block after the advisory lock, nothing else)"
P -d s453b -c "select pg_get_functiondef('public.place_bid(uuid,bigint,integer)'::regprocedure)" > /tmp/fd_3.sql
diff /tmp/fd_pre.sql /tmp/fd_3.sql > /tmp/fd_3.diff; echo "3-arg vs live body: $(grep -c '^>' /tmp/fd_3.diff) lines added, $(grep -c '^<' /tmp/fd_3.diff) removed/changed (full diff: /tmp/fd_3.diff)"
grep '^<' /tmp/fd_3.diff

echo "===== 3. standard lots identical: same scripted sequence BEFORE and AFTER"
PGOPTIONS="-c rig.fn=2" psql -U postgres -At -d s453a -f /w453/scenario-standard.sql 2>&1 | grep -E '^(CALL|BID|LOT|NOTE|REL|SRC|COUNT|psql)' > /tmp/std_before.txt
PGOPTIONS="-c rig.fn=2" psql -U postgres -At -d s453b -f /w453/scenario-standard.sql 2>&1 | grep -E '^(CALL|BID|LOT|NOTE|REL|SRC|COUNT|psql)' > /tmp/std_after2.txt
clone s453c s453base; P -d s453c -f $MIG
PGOPTIONS="-c rig.fn=3 -c rig.qty=" psql -U postgres -At -d s453c -f /w453/scenario-standard.sql 2>&1 | grep -E '^(CALL|BID|LOT|NOTE|REL|SRC|COUNT|psql)' > /tmp/std_after3.txt
clone s453n s453base; P -d s453n -f $MIG
PGOPTIONS="-c rig.fn=3 -c rig.qty=999" psql -U postgres -At -d s453n -f /w453/scenario-standard.sql 2>&1 | grep -E '^(CALL|BID|LOT|NOTE|REL|SRC|COUNT|psql)' > /tmp/std_after3q.txt
cat /tmp/std_before.txt
echo "lines: before=$(wc -l < /tmp/std_before.txt)"
diff /tmp/std_before.txt /tmp/std_after2.txt && ok "standard: 2-arg AFTER 0453 == BEFORE (calls, bids rows, lots, outbid notes, relations, bid_sources)" || bad "standard 2-arg differs"
diff /tmp/std_before.txt /tmp/std_after3.txt && ok "standard: 3-arg (qty NULL) AFTER == 2-arg BEFORE" || bad "standard 3-arg differs"
diff /tmp/std_before.txt /tmp/std_after3q.txt && ok "standard: 3-arg (qty 999, ignored) AFTER == 2-arg BEFORE" || bad "standard 3-arg qty differs"

echo "===== 4. per-unit cases (AFTER 0453)"
psql -U postgres -At -v ON_ERROR_STOP=1 -d s453b -f /w453/cases-per-unit.sql 2>&1 | grep -vE '^(CREATE|DO|UPDATE|INSERT|Output|Tuples)'
[ ${PIPESTATUS[0]} -eq 0 ] && ok "per-unit cases (every check above)" || bad "per-unit cases"

echo "===== 5. existing repo tests against BEFORE and AFTER"
clone s453fa s453plain; clone s453fb s453plain; P -d s453fb -f $MIG
for d in s453fa s453fb; do
  P -d $d -f /w453/place_bid_self_raise_guard.sql >/tmp/srg_$d.txt 2>&1 && ok "$d place_bid_self_raise_guard.sql (CI test, mig 0350)" || { bad "$d self-raise guard"; cat /tmp/srg_$d.txt; }
  P -d $d -f /w453/min_bid_increment_cents.sql >/dev/null 2>&1 && ok "$d min_bid_increment_cents.sql" || bad "$d min_bid_increment_cents"
  P -d $d -f /w453/app_read_paths_smoke.sql >/tmp/smoke_$d.txt 2>&1 && ok "$d app_read_paths_smoke.sql (place_bid present by name)" || { bad "$d app_read_paths_smoke"; tail -3 /tmp/smoke_$d.txt; }
done
psql -U postgres -At -d s453fa -f /w453/finalize-scenario.sql > /tmp/fin_a.txt 2>&1
psql -U postgres -At -d s453fb -f /w453/finalize-scenario.sql > /tmp/fin_b.txt 2>&1
cat /tmp/fin_a.txt
diff /tmp/fin_a.txt /tmp/fin_b.txt && ok "finalize-scenario.sql (close with/without bids, soft close, invoice build) identical BEFORE/AFTER" || bad "finalize-scenario differs"

echo "===== 6. concurrency: 16 clients x 40 bids on one lot, BEFORE and AFTER, then a serial replay of each run"
# Gate: invariants (no double leader; leader holds the highest max; the lot's
# current row is the leader at the price; bid_count = human rows; per-unit
# amounts all multiples). REPLAY/PRICE_DROPS are reported, not gated: they
# measure a PRE-EXISTING race in the live step 4 (see dump-conc-state.sql),
# shown by the BEFORE rounds (2-arg on the pre-0453 body).
. /w453/conc-lib.sh   # conc <label> pre|post <pgbench files...>
ROUNDS=${CONC_ROUNDS:-3}
for r in $(seq 1 $ROUNDS); do conc "BEFORE r$r (2-arg, standard S7)" pre conc-std2.pgb; done
for r in $(seq 1 $ROUNDS); do conc "AFTER  r$r (2-arg, standard S7)" post conc-std2.pgb; done
for r in $(seq 1 $ROUNDS); do conc "AFTER  r$r (3-arg per-unit U8, then mixed 2/3-arg standard S7)" post conc-pu.pgb conc-std.pgb; done
ok "concurrency invariants held in every round above (failures, if any, are listed as FAIL)"

P -d s453b -f /w453/conc-fns.sql
echo "===== 7. lock: a second bid waits for the first to commit (both overloads)"
for spec in "208 173 3 173000" "107 NULL 2 100000" "107 NULL 3 200000"; do
  set -- $spec
  P -d s453b -c "BEGIN; SELECT rig_bid('00000000-0000-0000-0000-000000000$1', 1, $4 * 2, $2, $3); SELECT pg_sleep(2); COMMIT;" >/dev/null &
  sleep 0.3
  s=$(date +%s%N); P -d s453b -c "SELECT rig_bid('00000000-0000-0000-0000-000000000$1', 2, $4 * 3, $2, $3)" >/dev/null
  w=$(( ($(date +%s%N)-s)/1000000 )); wait
  [ $w -ge 1500 ] && ok "lot ...$1 ${3}-arg: second session waited ${w} ms for the first" || bad "lot ...$1 ${3}-arg: no wait (${w} ms)"
done
P -d s453b -c "select 'after lock test: ' || string_agg(lot_code || ' lead=' || right(winner_bidder_id::text,2) || ' cur=' || current_bid_cents, ' | ' order by lot_code) from lots where lot_code in ('S7','U8')"

echo "===== 8. timing: 1 client x 2000 bids per run, BEFORE vs AFTER (5 rounds, medians; Docker on a Mac is noisy)"
: > /tmp/timing.txt
for r in 1 2 3 4 5; do
  clone s453ta s453base; clone s453tb s453base; P -d s453tb -f $MIG
  a=$(pgbench -n -U postgres -c 1 -t 2000 -f /w453/timing-std.pgb s453ta 2>&1 | grep 'latency average' | awk '{print $4}')
  b=$(pgbench -n -U postgres -c 1 -t 2000 -f /w453/timing-std.pgb s453tb 2>&1 | grep 'latency average' | awk '{print $4}')
  clone s453tc s453base; P -d s453tc -f $MIG
  c=$(pgbench -n -U postgres -c 1 -t 2000 -f /w453/timing-std3.pgb s453tc 2>&1 | grep 'latency average' | awk '{print $4}')
  d=$(pgbench -n -U postgres -c 1 -t 2000 -f /w453/timing-pu.pgb s453tc 2>&1 | grep 'latency average' | awk '{print $4}')
  echo "round $r ms/txn: BEFORE 2-arg=$a  AFTER 2-arg=$b  AFTER 3-arg standard=$c  AFTER 3-arg per-unit=$d"
  echo "$a $b $c $d" >> /tmp/timing.txt
done
med() { cut -d' ' -f$1 /tmp/timing.txt | sort -n | sed -n 3p; }
echo "MEDIAN ms/txn: BEFORE 2-arg=$(med 1)  AFTER 2-arg=$(med 2)  AFTER 3-arg standard=$(med 3)  AFTER 3-arg per-unit=$(med 4)"

echo "===== 9. preflight refuses: no 0451 / unknown live body"
clone s453g1 postgres
P -d s453g1 -f $MIG 2>&1 | grep -o '0453: [^—]*' | head -1
[ "$(P -d s453g1 -c "select count(*) from pg_proc where proname='place_bid'")" = 1 ] && [ "$(P -d s453g1 -c "$FD")" = "$PRE_FD" ] && ok "no 0451: refused, place_bid untouched" || bad "no-0451 guard"
clone s453g2 s453base
P -d s453g2 -c "$(P -d s453g2 -c "select replace(pg_get_functiondef('public.place_bid(uuid,bigint)'::regprocedure), '-- 1. Auth check', '-- 1. Auth check (drifted)')")"
P -d s453g2 -f $MIG 2>&1 | grep -o '0453: [^(]*' | head -1
[ "$(P -d s453g2 -c "select count(*) from pg_proc where proname='place_bid'")" = 1 ] && ok "drifted live body: refused, nothing changed" || bad "drift guard"

echo "===== 10. rollback restores the exact old body; re-apply after rollback"
s=$(date +%s%N); P -d s453b -f $RB || bad "rollback"; echo "rollback ok $(( ($(date +%s%N)-s)/1000000 )) ms"
[ "$(P -d s453b -c "$FD")" = "$PRE_FD" ] && ok "pg_get_functiondef after rollback == before apply ($PRE_FD)" || bad "rollback body"
[ "$(P -d s453b -c "select count(*) from pg_proc where proname='place_bid'")" = 1 ] && ok "3-arg dropped" || bad "3-arg still there"
[ "$(P -d s453b -c "$ACL")" = "$PRE_ACL" ] && ok "grants after rollback == before" || bad "grants after rollback"
P -d s453b -f $RB >/dev/null && ok "rollback re-run is idempotent" || bad "rollback re-run"
P -d s453b -f $MIG && P -d s453b -f $MIG && ok "apply after rollback, twice" || bad "re-apply after rollback"

echo "===== RESULT: $fail failure(s)"
exit $fail
