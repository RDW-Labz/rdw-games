# 0451 proof on the Docker prod copy (rig0431). Copy the migration, its
# rollback and these files into the container as /w11/, then:
#   docker exec rig0431 bash /w11/run.sh
P() { psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

psql -q -U postgres -c "DROP DATABASE IF EXISTS s0451" -c "CREATE DATABASE s0451 TEMPLATE postgres" || exit 1
P -q -d s0451 -c "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text" >/dev/null
P -q -d s0451 -f /w11/seed.sql || exit 1

echo "===== BEFORE 0451 (prod today)"
psql -U postgres -At -d s0451 -f /w11/cases-before.sql 2>&1 | grep -v "^$"

echo "===== simulate Supabase cluster-level default grants (not part of the migration; rig0431's rig-stubs.sh only creates the roles, not the default privileges Supabase sets at project bootstrap)"
P -q -d s0451 -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON lots, auctions, bidders, operators, operator_users, warehouses TO anon, authenticated;"

echo "===== bulk-load ~40k lots for timing (synthetic, not seeded through app code)"
P -q -d s0451 -c "SET session_replication_role = replica;
INSERT INTO lots (operator_id, warehouse_id, title, lot_code, status, starting_bid_cents)
SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       'Bulk lot ' || g, 'BULK-' || g, 'unsold', 100
  FROM generate_series(1, 40000) g;"
P -d s0451 -c "SELECT 'lots before migration: ' || count(*) FROM lots"

echo "===== APPLY 0451"
s=$(date +%s%N); P -q -d s0451 -f /w11/0451_sqft_bid_mode_unit_qty.sql || exit 1
echo "apply ok $(ms $s)ms"

echo "===== RE-APPLY 0451 (idempotency)"
s=$(date +%s%N); P -q -d s0451 -f /w11/0451_sqft_bid_mode_unit_qty.sql || exit 1
echo "re-apply ok $(ms $s)ms"

echo "===== AFTER 0451"
psql -U postgres -At -d s0451 -f /w11/cases-after.sql 2>&1 | grep -v "^$"

echo "===== ROLLBACK"
s=$(date +%s%N); P -q -d s0451 -f /w11/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql && echo "rollback ok $(ms $s)ms"
P -d s0451 -c "SELECT 'cols after rollback (should be 0): ' || count(*) FROM information_schema.columns WHERE (table_name='auctions' AND column_name IN ('bid_mode','unit_start_cents')) OR (table_name='lots' AND column_name IN ('unit_qty','unit_label'))"
P -d s0451 -c "SELECT 'lots count after rollback (unchanged): ' || count(*) FROM lots"
P -d s0451 -c "SELECT 'auctions count after rollback (unchanged): ' || count(*) FROM auctions"
