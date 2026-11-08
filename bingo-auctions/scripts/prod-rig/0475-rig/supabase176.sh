#!/bin/bash
# 0475 on Supabase's own Postgres 17.6 image, as NON-superuser postgres (prod's
# migration role). Minimal prod-shaped schema (the columns 0475 touches), the
# pre-0475 bidder policy built by the 0475 rollback file. Proves: apply,
# re-apply, rollback, re-apply; policy deparse md5 = prod's on 17.6; bidder
# reads; lock_timeout cancels cleanly while a reader holds lots.
#   bash scripts/prod-rig/0475-rig/supabase176.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
MIG=$PENDING/0475_refund_lot_status.sql
RB=$HERE/../0475_ROLLBACK_refund_lot_status.sql
IMG=public.ecr.aws/supabase/postgres:17.6.1.171
C=rig0475s
F=0
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --rm --name $C -e POSTGRES_PASSWORD=x $IMG >/dev/null
until docker exec $C pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; do sleep 1; done
sleep 8
q()  { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
qf() { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$1"; }
ok() { if [ "$1" = "$2" ]; then echo "PASS $3"; else echo "FAIL $3 (got '$1', want '$2')"; F=$((F+1)); fi; }
pol() { q -c "select md5(pg_get_expr(polqual, polrelid)) from pg_policy where polrelid='public.lots'::regclass and polname='lots_bidder_read_published'"; }
trg() { q -c "select count(*) from pg_trigger where tgname='invoice_lots_0475_refund_to_refunded'"; }

echo "sha256 $(shasum -a 256 "$MIG" | cut -d' ' -f1)"
ok "$(q -c "select rolsuper from pg_roles where rolname=current_user")" "f" "running as non-superuser postgres"

q <<'SQL'
CREATE TYPE public.lot_status AS ENUM ('pending_intake','in_inventory','scheduled','live','won','unsold','relisted','canceled');
CREATE TABLE public.operators (id uuid PRIMARY KEY, is_demo boolean NOT NULL DEFAULT false);
CREATE TABLE public.bidders (id uuid PRIMARY KEY, is_reviewer boolean NOT NULL DEFAULT false);
CREATE TABLE public.lots (id uuid PRIMARY KEY, operator_id uuid, status public.lot_status, title text, lot_code text,
  early_access_until timestamptz, deleted_at timestamptz, winner_bidder_id uuid, updated_at timestamptz, relist_origin text);
CREATE TABLE public.invoices (id uuid PRIMARY KEY, status text, subtotal_cents int, buyer_premium_cents int, tax_cents int);
CREATE TABLE public.invoice_lots (invoice_id uuid, lot_id uuid, winning_bid_cents int, refunded_at timestamptz,
  picked_up_at timestamptz, forfeited_at timestamptz, PRIMARY KEY (invoice_id, lot_id));
CREATE FUNCTION public.is_bidder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM bidders WHERE id = auth.uid()); $$;
CREATE FUNCTION public.is_subscriber(p_operator_id uuid DEFAULT NULL::uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $$ SELECT false $$;
ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.lots TO authenticated;
INSERT INTO public.operators VALUES ('00000000-0000-0000-0000-0000000000a1', false);
INSERT INTO public.bidders VALUES ('00000000-0000-0000-0000-0000000000e1', false);
INSERT INTO public.lots (id, operator_id, status, title, lot_code) VALUES
 ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000a1', 'won', 'L01', 'L01'),
 ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000a1', 'in_inventory', 'L02', 'L02');
SQL
qf "$RB" >/dev/null
ok "$(pol)" "b250d666540e8f077a6a5d72a1fd422f" "pre-0475 policy on 17.6 deparses to prod's md5"

echo "== lock: a reader holds lots; 0475 must cancel cleanly"
docker exec -d -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -c "begin; select count(*) from public.lots; select pg_sleep(12); commit;"
sleep 2
T0=$(date +%s); OUT=$(qf "$MIG" 2>&1); T=$(( $(date +%s) - T0 ))
echo "$OUT" | grep -q 'lock timeout' && echo "PASS lock_timeout fired after ${T}s" || { echo "FAIL no lock timeout: $(echo "$OUT" | grep -m1 ERROR)"; F=$((F+1)); }
ok "$(trg)" "0" "...transaction 2 rolled back (no trigger)"
ok "$(pol)" "b250d666540e8f077a6a5d72a1fd422f" "...policy unchanged"
ok "$(q -c "select count(*) from pg_enum where enumtypid='public.lot_status'::regtype and enumlabel='refunded'")" "1" "...enum value from transaction 1 stays (harmless, as documented)"
sleep 11

echo "== apply, re-apply"
qf "$MIG" >/dev/null && echo "PASS apply" || { echo "FAIL apply"; F=$((F+1)); }
qf "$MIG" >/dev/null && echo "PASS re-apply" || { echo "FAIL re-apply"; F=$((F+1)); }
ok "$(pol)" "47a1fc5867fb1127177d0623e8ad814c" "policy md5 = rig's 0475 md5 (47a1fc58)"
ok "$(trg)" "1" "trigger present"

q -c "UPDATE public.lots SET status = 'refunded' WHERE lot_code = 'L01'"
B="select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false); set role authenticated;"
ok "$(q -c "$B select count(*) from public.lots where lot_code = 'L01'" | tail -1)" "1" "bidder reads a refunded lot"
ok "$(q -c "$B select count(*) from public.lots where lot_code = 'L02'" | tail -1)" "0" "in_inventory still hidden"
N="select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', false); set role authenticated;"
ok "$(q -c "$N select count(*) from public.lots where lot_code = 'L01'" | tail -1)" "0" "non-bidder cannot read it"

echo "== rollback, re-apply"
qf "$RB" >/dev/null && echo "PASS rollback" || { echo "FAIL rollback"; F=$((F+1)); }
ok "$(pol)" "b250d666540e8f077a6a5d72a1fd422f" "rollback restores prod's policy"
ok "$(trg)" "0" "rollback removes trigger"
ok "$(q -c "$B select count(*) from public.lots where lot_code = 'L01'" | tail -1)" "0" "after rollback a refunded lot is hidden again (pre-0475 behaviour)"
qf "$MIG" >/dev/null && echo "PASS re-apply after rollback" || { echo "FAIL re-apply after rollback"; F=$((F+1)); }
ok "$(pol)" "47a1fc5867fb1127177d0623e8ad814c" "re-apply: policy has refunded"

docker rm -f $C >/dev/null
echo "RESULT: $F failure(s)"
exit $F
