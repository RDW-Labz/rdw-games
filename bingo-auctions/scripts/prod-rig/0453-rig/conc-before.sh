# Pre-existing race, BEFORE 0453 only: N rounds of 16 concurrent 2-arg bidders
# on the pre-0453 body (no 0453 anywhere in these databases). A round with
# REPLAY differing>0 / PRICE_DROPS>0 shows the live engine already departs from
# serial behaviour under contention. Needs s453base (run.sh section 0 or
# build-base.sh). usage: docker exec rig0431 bash /w453/conc-before.sh [rounds]
MIG=/nonexistent
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
clone() { psql -q -U postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1; psql -q -U postgres -c "CREATE DATABASE $1 TEMPLATE $2" || exit 1; }
fail=0; bad() { echo "FAIL $*"; fail=$((fail+1)); }
. /w453/conc-lib.sh
[ "$(P -d s453base -c "select count(*) from pg_proc where proname = 'place_bid'")" = 1 ] || { echo "s453base is not pre-0453"; exit 1; }
for r in $(seq 1 ${1:-10}); do conc "BEFORE r$r (2-arg, standard S7)" pre conc-std2.pgb; done
