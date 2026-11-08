#!/bin/bash
# 0454 proof on the Docker prod copy (rig0431, pgvector/pgvector:pg16). Never
# touches prod. Synthetic data only (example.test). Database names: sq4*.
# Copy in (from the repo root, on the host):
#   docker exec rig0431 bash -c 'rm -rf /work/sq4-0454 && mkdir -p /work/sq4-0454/migrations /work/sq4-0454/dbtest'
#   docker cp packages/db/migrations/. rig0431:/work/sq4-0454/migrations/
#   docker cp ~/Documents/bingo-migrations-pending/0446_bid_sources.sql rig0431:/work/sq4-0454/migrations/
#   docker cp packages/db/test/. rig0431:/work/sq4-0454/dbtest/
#   docker cp scripts/prod-rig/0454-rig/. rig0431:/work/sq4-0454/
#   docker cp ~/Documents/bingo-migrations-pending/0454_sqft_guards.sql rig0431:/work/sq4-0454/   (or packages/db/migrations/ once copied)
#   docker cp scripts/prod-rig/0454_ROLLBACK_sqft_guards.sql rig0431:/work/sq4-0454/
#   docker cp scripts/prod-rig/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql rig0431:/work/sq4-0454/
#   docker exec rig0431 bash /work/sq4-0454/run.sh          (exit code = failures)
D=/work/sq4-0454
MIG=$D/0454_sqft_guards.sql
RB=$D/0454_ROLLBACK_sqft_guards.sql
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
clone() { psql -q -U postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1; psql -q -U postgres -c "CREATE DATABASE $1 TEMPLATE $2" || exit 1; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
fail=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fail=$((fail+1)); }
OBJ="select (select count(*) from pg_trigger where tgname in ('lots_sqft_guard','auctions_sqft_mode_lock') and not tgisinternal) || ' triggers, ' || (select count(*) from pg_proc where proname in ('lots_sqft_guard','auctions_sqft_mode_lock')) || ' functions'"
STD() { psql -U postgres -At -d $1 -f $D/scenario-standard.sql 2>&1 | grep -E '^(CALL|LOT|AUC|COUNT|psql|ERROR)'; }

echo "===== 0. base: stubs + replay of master's migrations (+ pending 0446) + seed"
bash $D/build-base.sh 2>&1 | grep -E '^(base:|FAIL|ABORT|SEED)'
[ "$(P -d sq4base -c "$OBJ")" = "0 triggers, 0 functions" ] && ok "base has no 0454 objects" || bad "base already has 0454 objects"

echo "===== 1. apply (timed), re-apply (idempotent)"
clone sq4_a sq4base
s=$(date +%s%N); P -d sq4_a -f $MIG && echo "apply ok $(ms $s) ms" || bad "apply"
s=$(date +%s%N); P -d sq4_a -f $MIG && echo "re-apply ok $(ms $s) ms" || bad "re-apply"
[ "$(P -d sq4_a -c "$OBJ")" = "2 triggers, 2 functions" ] && ok "2 triggers, 2 functions after apply + re-apply" || bad "objects: $(P -d sq4_a -c "$OBJ")"
P -d sq4_a -c "select pg_get_triggerdef(oid) from pg_trigger where tgname in ('lots_sqft_guard','auctions_sqft_mode_lock') order by 1"
P -d sq4_a -c "select 'secdef ' || proname || '=' || prosecdef || ' cfg=' || array_to_string(proconfig, ',') || ' acl=' || coalesce(proacl::text, 'default') from pg_proc where proname in ('lots_sqft_guard','auctions_sqft_mode_lock') order by 1"
P -d sq4_a -c "select 'rows changed by apply: lots ' || (select count(*) from lots) || ', auctions ' || (select count(*) from auctions)"
[ "$(P -d sq4_a -c "select md5(string_agg(t::text, '' order by t.id)) from lots t")" = "$(P -d sq4base -c "select md5(string_agg(t::text, '' order by t.id)) from lots t")" ] && ok "every lots row byte-identical after apply (no data change)" || bad "lots rows changed"
[ "$(P -d sq4_a -c "select md5(string_agg(t::text, '' order by t.id)) from auctions t")" = "$(P -d sq4base -c "select md5(string_agg(t::text, '' order by t.id)) from auctions t")" ] && ok "every auctions row byte-identical after apply" || bad "auctions rows changed"

echo "===== 2. standard lots identical: same scripted flows BEFORE, AFTER, and AFTER rollback"
clone sq4_s0 sq4base; clone sq4_s1 sq4base; clone sq4_s2 sq4base
P -d sq4_s1 -f $MIG; P -d sq4_s2 -f $MIG; P -d sq4_s2 -f $RB
STD sq4_s0 > /tmp/sq4_std_before.txt; STD sq4_s1 > /tmp/sq4_std_after.txt; STD sq4_s2 > /tmp/sq4_std_rb.txt
cat /tmp/sq4_std_before.txt
echo "lines: before=$(wc -l < /tmp/sq4_std_before.txt) (CALL = each flow's result; LOT/AUC = every row's final state)"
diff /tmp/sq4_std_before.txt /tmp/sq4_std_after.txt && ok "standard: AFTER 0454 == BEFORE (new lot, assign admin/manager, refused assigns, edits, take out, desk relist, relist to inventory, 3-arg relot, refused relists, auto-relist, duplicate, 2-/3-arg bids, auction edits)" || bad "standard flows differ"
diff /tmp/sq4_std_before.txt /tmp/sq4_std_rb.txt && ok "standard: AFTER rollback == BEFORE" || bad "standard after rollback differs"

echo "===== 3. every guard case (AFTER 0454, full seed with per_unit rows)"
clone sq4_g sq4base; P -d sq4_g -f $MIG
psql -U postgres -At -d sq4_g -f $D/cases-guards.sql 2>&1 | grep -E '^(PASS|FAIL|---|ERROR)|^psql:.*(ERROR|FATAL)' | tee /tmp/sq4_cases.txt
n=$(grep -c '^PASS' /tmp/sq4_cases.txt); f=$(grep -cE '^(FAIL|ERROR|psql:)' /tmp/sq4_cases.txt)
[ $f -eq 0 ] && ok "guard cases: $n PASS, 0 FAIL" || { bad "guard cases: $f failing line(s)"; }

echo "===== 4. repo SQL tests (packages/db/test, CI order, one DB) BEFORE and AFTER"
CI_TESTS="resolve_category_ids_batch lineage_assign_guard scan_resolver_collision find_import_row_by_scan_fast phantom_relist_child duplicate_relist_twin collected_item_never_resold collected_item_invariant_monitor import_rows_source_key_dedupe onconflict_targets_resolvable carrier_barcode_sticker relist_location_drift lot_worker_attribution lots_carry_load load_summary revoke_anon_load_functions worker_reports_unshelved refund_claims money_daily_revenue place_bid_self_raise_guard relocate_follows_live_lot invoice_lots_forfeited_at clear_sticker_code duplicate_lot lot_location_history pickup_session_open_indexes relist_refunded_child_guard relist_label_reclaim lot_display_code scan_resolves_current_member operator_reports_period_summary refunds_by_refund_date lot_category_id_follows_edit app_versions missing_item_checks cron_functions_smoke app_read_paths_smoke"
for side in before after; do
  clone sq4_t_$side sq4bare
  [ $side = after ] && P -d sq4_t_$side -f $MIG
  : > /tmp/sq4_t_$side.txt
  for t in $CI_TESTS; do
    if psql -q -U postgres -v ON_ERROR_STOP=1 -d sq4_t_$side -f $D/dbtest/$t.sql >/tmp/sq4_t_out 2>&1; then echo "$t pass" >> /tmp/sq4_t_$side.txt
    else echo "$t FAIL: $(grep -m1 ERROR /tmp/sq4_t_out)" >> /tmp/sq4_t_$side.txt; fi
  done
  echo "$side: $(grep -c ' pass$' /tmp/sq4_t_$side.txt) pass, $(grep -c ' FAIL' /tmp/sq4_t_$side.txt) fail"
done
grep FAIL /tmp/sq4_t_before.txt | sed 's/^/  before: /'
diff /tmp/sq4_t_before.txt /tmp/sq4_t_after.txt && ok "repo SQL tests: same result per test BEFORE and AFTER" || bad "repo SQL tests differ"
[ "$(grep -c ' FAIL' /tmp/sq4_t_after.txt)" = 0 ] && ok "repo SQL tests: all pass AFTER" || echo "NOTE: failures above also fail BEFORE (rig/stub related), not 0454"

echo "===== 5. timing, standard lots only: 500-lot assign, 2000-lot start edit, 300 relists, 2000-lot insert (ms; 5 rounds, medians; Docker on a Mac is noisy)"
: > /tmp/sq4_timing.txt
for r in 1 2 3 4 5; do
  clone sq4_ta sq4base; clone sq4_tb sq4base; P -d sq4_tb -f $MIG
  a=$(psql -U postgres -At -d sq4_ta -f $D/timing.sql 2>&1 | tail -1); b=$(psql -U postgres -At -d sq4_tb -f $D/timing.sql 2>&1 | tail -1)
  echo "round $r  BEFORE assign/update/relist/insert = $a   AFTER = $b"; echo "$a $b" >> /tmp/sq4_timing.txt
done
med() { cut -d' ' -f$1 /tmp/sq4_timing.txt | sort -n | sed -n 3p; }
echo "MEDIAN ms  BEFORE: assign=$(med 1) update=$(med 2) relist=$(med 3) insert=$(med 4)   AFTER: assign=$(med 5) update=$(med 6) relist=$(med 7) insert=$(med 8)"

echo "===== 6. lock: apply behind an open lot write fails fast at lock_timeout (3s), changes nothing"
clone sq4_l sq4base
P -d sq4_l -c "BEGIN; UPDATE lots SET title = title WHERE lot_code = 'SL1'; SELECT pg_sleep(6); COMMIT;" >/dev/null &
sleep 0.5
s=$(date +%s%N); out=$(P -d sq4_l -f $MIG 2>&1); w=$(ms $s); wait
echo "$out" | grep -o 'canceling statement due to lock timeout' | head -1
[ "$(P -d sq4_l -c "$OBJ")" = "0 triggers, 0 functions" ] && [ $w -lt 5000 ] && ok "blocked apply gave up after ${w} ms, nothing created (rerun when clear)" || bad "lock_timeout behaviour (${w} ms, $(P -d sq4_l -c "$OBJ"))"
P -d sq4_l -c "BEGIN; SELECT count(*) FROM lots; SELECT pg_sleep(3); COMMIT;" >/dev/null &
sleep 0.5
s=$(date +%s%N); P -d sq4_l -f $MIG >/dev/null 2>&1; w=$(ms $s); wait
[ "$(P -d sq4_l -c "$OBJ")" = "2 triggers, 2 functions" ] && ok "apply alongside an open read: went through in ${w} ms (SHARE ROW EXCLUSIVE does not wait for reads)" || bad "apply alongside a read"
P -d sq4_l -c "BEGIN; LOCK TABLE lots IN SHARE ROW EXCLUSIVE MODE; SELECT pg_sleep(2); COMMIT;" >/dev/null &
sleep 0.5
s=$(date +%s%N); P -d sq4_l -c "SELECT count(*) FROM lots" >/dev/null; r=$(ms $s)
s=$(date +%s%N); P -d sq4_l -c "UPDATE lots SET title = title WHERE lot_code = 'SD1'" >/dev/null; u=$(ms $s); wait
echo "while a SHARE ROW EXCLUSIVE (the trigger lock) is held: a read took ${r} ms, a lot write waited ${u} ms"

echo "===== 7. preflight refuses without 0451"
clone sq4_p sq4base
P -d sq4_p -f $D/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql >/dev/null 2>&1
P -d sq4_p -f $MIG 2>&1 | grep -o '0454: needs 0451[^.]*' | head -1
[ "$(P -d sq4_p -c "$OBJ")" = "0 triggers, 0 functions" ] && ok "no 0451: refused, nothing created" || bad "no-0451 guard"

echo "===== 8. read-only prod preflight runs (rig: seeded copy, then the standard-only shape)"
P -d sq4base -f $D/preflight-prod.sql
clone sq4_pf sq4base
P -d sq4_pf -c "SET session_replication_role = replica; DELETE FROM bids WHERE lot_id IN (SELECT id FROM lots WHERE unit_qty IS NOT NULL); DELETE FROM lots WHERE unit_qty IS NOT NULL; DELETE FROM auctions WHERE bid_mode = 'per_unit';"
P -d sq4_pf -f $D/preflight-prod.sql

echo "===== 9. rollback; re-run; apply after rollback; guard cases again"
s=$(date +%s%N); P -d sq4_a -f $RB && echo "rollback ok $(ms $s) ms" || bad "rollback"
[ "$(P -d sq4_a -c "$OBJ")" = "0 triggers, 0 functions" ] && ok "rollback removed both triggers and functions" || bad "rollback left: $(P -d sq4_a -c "$OBJ")"
P -d sq4_a -f $RB && ok "rollback re-run is idempotent" || bad "rollback re-run"
P -d sq4_a -f $MIG && P -d sq4_a -f $MIG && [ "$(P -d sq4_a -c "$OBJ")" = "2 triggers, 2 functions" ] && ok "apply after rollback, twice" || bad "re-apply after rollback"
clone sq4_g2 sq4base; P -d sq4_g2 -f $MIG; P -d sq4_g2 -f $RB; P -d sq4_g2 -f $MIG
f=$(psql -U postgres -At -d sq4_g2 -f $D/cases-guards.sql 2>&1 | grep -cE '^(FAIL|ERROR)|^psql:.*(ERROR|FATAL)')
[ $f -eq 0 ] && ok "guard cases after apply -> rollback -> apply: 0 FAIL" || bad "guard cases after re-apply: $f"

echo "===== RESULT: $fail failure(s)"
exit $fail
