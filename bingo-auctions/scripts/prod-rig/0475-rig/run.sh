#!/bin/bash
# 0475 proof on the Docker prod copy (rig0431), from the host:
#   sh scripts/prod-rig/0475-rig/run.sh
# x475b = template `postgres` (master replay) + seed.  Standard flows run on a
# copy WITHOUT 0475 and a copy WITH it, then on a copy after rollback; the
# printed state must be identical. Then the 0475 cases, apply / re-apply /
# rollback / re-apply. Only x475* databases are touched.
set -e
C=${C:-rig0431}
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG=$PENDING/0475_refund_lot_status.sql
ROLLBACK=$HERE/../0475_ROLLBACK_refund_lot_status.sql
psqlc() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
mk() { docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE $2" >/dev/null 2>&1; }
F=0

echo "0475 sha256: $(shasum -a 256 "$MIG" | cut -d' ' -f1)"
mk x475b postgres
psqlc -d x475b < "$HERE/seed.sql"

echo "===== standard flows: BEFORE vs AFTER vs AFTER-rollback"
mk x475s0 x475b; mk x475s1 x475b; mk x475s2 x475b
psqlc -d x475s1 < "$MIG"; psqlc -d x475s2 < "$MIG"; psqlc -d x475s2 < "$ROLLBACK"
for d in x475s0 x475s1 x475s2; do psqlc -d "$d" -At < "$HERE/scenario-standard.sql" | grep -E '^(REL|LOT|LINE|HIST)' > "/tmp/$d.out"; done
echo "standard state lines: $(wc -l < /tmp/x475s0.out)"
if diff /tmp/x475s0.out /tmp/x475s1.out; then echo "PASS standard flows identical with 0475"; else echo "FAIL standard flows differ with 0475"; F=$((F+1)); fi
if diff /tmp/x475s0.out /tmp/x475s2.out; then echo "PASS standard flows identical after rollback"; else echo "FAIL after rollback"; F=$((F+1)); fi

echo "===== money (owner check B): with 0474 on both, WITHOUT vs WITH 0475"
P474=$PENDING/0474_refund_override.sql
mk x475m0 x475b; mk x475m1 x475b
psqlc -d x475m0 < "$P474"; psqlc -d x475m1 < "$P474"; psqlc -d x475m1 < "$MIG"
psqlc -d x475m0 -At < "$HERE/money.sql" 2>&1 | grep -E '^(MONEY|COUNT|LOT|OVR|ERROR|psql)' > /tmp/x475m0.out
psqlc -d x475m1 -At < "$HERE/money.sql" 2>&1 | grep -E '^(MONEY|COUNT|LOT|OVR|ERROR|psql)' > /tmp/x475m1.out
echo "money lines: $(grep -c '^MONEY' /tmp/x475m0.out)"; grep -E '^(OVR|ERROR|psql)' /tmp/x475m1.out || true
if diff <(grep '^MONEY' /tmp/x475m0.out) <(grep '^MONEY' /tmp/x475m1.out); then echo "PASS money identical with and without 0475 (invoices, lines, credit balances, overrides, money summary, period summary, money daily, auction performance money)"; else echo "FAIL money differs"; F=$((F+1)); fi
echo "--- lot status WITHOUT 0475:"; grep '^LOT' /tmp/x475m0.out
echo "--- lot status WITH 0475:"; grep '^LOT' /tmp/x475m1.out
grep -q '^LOT L01 refunded' /tmp/x475m1.out && echo "PASS full item refund never picked up -> refunded" || { echo "FAIL L01"; F=$((F+1)); }
grep -q '^LOT L04 won' /tmp/x475m1.out && echo "PASS partial item refund -> stays won" || { echo "FAIL L04"; F=$((F+1)); }
grep -q '^LOT L06 won' /tmp/x475m1.out && echo "PASS whole-invoice refund of a lot with another open sale -> stays won" || { echo "FAIL L06"; F=$((F+1)); }
grep -q '^LOT L12 refunded' /tmp/x475m1.out && echo "PASS 0474 override, full line -> refunded (deferred trigger sees the override row)" || { echo "FAIL L12"; F=$((F+1)); }
echo "--- counts (not money) WITHOUT / WITH:"; grep '^COUNT' /tmp/x475m0.out || true; grep '^COUNT' /tmp/x475m1.out || true
for d in x475m0 x475m1; do docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done

echo "===== apply, re-apply, cases"
mk x475 x475b
psqlc -d x475 < "$MIG" && echo "apply ok"
psqlc -d x475 < "$MIG" && echo "re-apply ok"
psqlc -d x475 -At < "$HERE/cases.sql" | tee /tmp/x475_cases.out | grep -E '^(PASS|FAIL)'
P=$(grep -c '^PASS' /tmp/x475_cases.out || true); Q=$(grep -c '^FAIL' /tmp/x475_cases.out || true)
echo "cases: $P PASS / $Q FAIL"; F=$((F+Q))

echo "===== bidder read (lots_bidder_read_published + refunded)"
psqlc -d x475 -At < "$HERE/rls.sql" | tee /tmp/x475_rls.out | grep -E '^(PASS|FAIL)'
P=$(grep -c '^PASS' /tmp/x475_rls.out || true); Q=$(grep -c '^FAIL' /tmp/x475_rls.out || true)
echo "bidder read: $P PASS / $Q FAIL"; F=$((F+Q))

pol() { docker exec "$C" psql -U postgres -d "$1" -Atc "select md5(pg_get_expr(polqual, polrelid)) from pg_policy where polrelid='public.lots'::regclass and polname='lots_bidder_read_published'"; }

psqlc -d x475 < "$ROLLBACK" && echo "rollback ok"
[ "$(pol x475)" = "b250d666540e8f077a6a5d72a1fd422f" ] && echo "PASS rollback restored the pre-0475 bidder policy" || { echo "FAIL rollback policy md5 $(pol x475)"; F=$((F+1)); }
LEFT=$(docker exec "$C" psql -U postgres -d x475 -Atc "select count(*) from pg_proc where proname in ('invoice_lots_0475_refund_to_refunded','relist_refunded_lot')")
TRG=$(docker exec "$C" psql -U postgres -d x475 -Atc "select count(*) from pg_trigger where tgname = 'invoice_lots_0475_refund_to_refunded'")
if [ "$LEFT" = "0" ] && [ "$TRG" = "0" ]; then echo "PASS rollback removed trigger + functions"; else echo "FAIL rollback left $LEFT functions, $TRG triggers"; F=$((F+1)); fi
psqlc -d x475 < "$MIG" && echo "re-apply after rollback ok"
[ "$(pol x475)" = "47a1fc5867fb1127177d0623e8ad814c" ] && echo "PASS re-apply: bidder policy has refunded" || { echo "FAIL re-apply policy md5 $(pol x475)"; F=$((F+1)); }

echo "===== preflight: a policy that differs from prod's is refused, nothing changed"
mk x475t x475b
docker exec "$C" psql -U postgres -d x475t -qc "DROP POLICY lots_bidder_read_published ON public.lots; CREATE POLICY lots_bidder_read_published ON public.lots FOR SELECT USING ((SELECT is_bidder()))"
if psqlc -d x475t < "$MIG" > /dev/null 2>/tmp/x475t.err; then echo "FAIL preflight did not refuse"; F=$((F+1)); else
  T=$(docker exec "$C" psql -U postgres -d x475t -Atc "select count(*) from pg_trigger where tgname='invoice_lots_0475_refund_to_refunded'")
  grep -q 'not the version this migration was written against' /tmp/x475t.err && [ "$T" = "0" ] \
    && echo "PASS preflight refused a changed policy; transaction 2 rolled back (no trigger)" \
    || { echo "FAIL preflight: $(grep -m1 ERROR /tmp/x475t.err) triggers=$T"; F=$((F+1)); }
fi
for d in x475 x475b x475s0 x475s1 x475s2 x475t; do docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done
echo "RESULT: $F failure(s)"
exit $F
