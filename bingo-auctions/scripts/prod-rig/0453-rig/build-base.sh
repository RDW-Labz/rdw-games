# Builds s453base: rig0431's master replay (template `postgres`) + 0446
# (bid_sources trigger, pending) + 0451 (sq-ft columns) + the seed.
# Everything else clones it, so BEFORE and AFTER start from identical bytes.
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
for d in s453base s453a s453b s453c s453n s453x; do psql -q -U postgres -c "DROP DATABASE IF EXISTS $d" >/dev/null; done
psql -q -U postgres -c "CREATE DATABASE s453base TEMPLATE postgres" || exit 1
P -d s453base -c "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text" || exit 1
P -d s453base -f /w453/0446_bid_sources.sql >/dev/null || exit 1
P -d s453base -f /w453/0451_sqft_bid_mode_unit_qty.sql || exit 1
P -d s453base -f /w453/seed.sql || exit 1
echo "base: template md5(place_bid prosrc)=$(P -d s453base -c "select md5(prosrc) from pg_proc where oid='public.place_bid(uuid,bigint)'::regprocedure") overloads=$(P -d s453base -c "select count(*) from pg_proc where proname='place_bid'") bid_sources_trigger=$(P -d s453base -c "select count(*) from pg_trigger where tgrelid='bids'::regclass and tgname ilike '%source%'")"
