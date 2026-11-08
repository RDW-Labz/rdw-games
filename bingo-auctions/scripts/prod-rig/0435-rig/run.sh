P() { psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
one() { # db label e_ok e_deny e_new
  psql -U postgres -At -d $1 -v e_ok=$3 -v e_deny=$4 -v e_new=$5 -f /w/cases.sql 2>&1 | grep -E "PASS|FAIL|state|ERROR" | sed "s/^/[$2] /"
}
psql -q -U postgres -c "DROP DATABASE IF EXISTS s0435" -c "CREATE DATABASE s0435 TEMPLATE postgres" || exit 1
P -q -d s0435 -f /w/prodgrants.sql && P -q -d s0435 -f /w/0434_bidder_postal_code.sql >/dev/null && P -q -d s0435 -f /w/seed.sql || { echo SETUP FAILED; exit 1; }
echo "== BEFORE 0435 (prod today: holes open, so 'deny' cases should FAIL)"; one s0435 before ok 42501 42883
P -q -d s0435 -f /w/seed_reset.sql
s=$(date +%s%N); P -d s0435 -f /w/0435_bidders_column_grants.sql >/dev/null && echo "== APPLIED 0435 in $(( ($(date +%s%N)-s)/1000000 )) ms"
one s0435 after ok 42501 ok
P -q -d s0435 -f /w/seed_reset.sql
P -d s0435 -f /w/0435_ROLLBACK_bidders_column_grants.sql >/dev/null && echo "== ROLLED BACK (holes reopen: deny cases FAIL again, as before)"
one s0435 rollback ok 42501 ok
