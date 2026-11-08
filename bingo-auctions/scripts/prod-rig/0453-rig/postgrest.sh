#!/bin/zsh
# Run on the HOST (needs docker run). Proves PostgREST resolves the overloads
# by argument NAMES: a 2-key body ({p_lot_id, p_max_amount_cents}, what every
# app bundle in the field sends) reaches the 2-arg; adding p_unit_qty reaches
# the 3-arg. Uses the Supabase PostgREST images already on this Mac, sharing
# rig0431's network namespace. Synthetic data; never touches prod.
set -u
SECRET=rig0453-jwt-secret-at-least-32-characters
jwt() { python3 - "$SECRET" "$1" <<'PY'
import base64, hashlib, hmac, json, sys
b = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(',', ':')).encode()).rstrip(b'=')
h, p = b({'alg': 'HS256', 'typ': 'JWT'}), b({'role': 'authenticated', 'sub': sys.argv[2], 'exp': 4102444800})
s = base64.urlsafe_b64encode(hmac.new(sys.argv[1].encode(), h + b'.' + p, hashlib.sha256).digest()).rstrip(b'=')
print((h + b'.' + p + b'.' + s).decode())
PY
}
B1=$(jwt 00000000-0000-0000-0000-0000000000e1)
B2=$(jwt 00000000-0000-0000-0000-0000000000e2)
S2=00000000-0000-0000-0000-000000000102; U1=00000000-0000-0000-0000-000000000201; S7=00000000-0000-0000-0000-000000000107
for IMG in public.ecr.aws/supabase/postgrest:v14.18 public.ecr.aws/supabase/postgrest:v16.2; do
  docker rm -f pgrst0453 >/dev/null 2>&1
  docker exec rig0431 psql -q -U postgres -c "DROP DATABASE IF EXISTS s453r" -c "CREATE DATABASE s453r TEMPLATE s453base" || exit 1
  docker exec rig0431 psql -q -U postgres -v ON_ERROR_STOP=1 -d s453r -f /w453/0453_sqft_place_bid_per_unit.sql || exit 1
  docker exec rig0431 psql -q -U postgres -v ON_ERROR_STOP=1 -d s453r -f /w453/postgrest-setup.sql || exit 1
  docker run -d --name pgrst0453 --network container:rig0431 \
    -e PGRST_DB_URI=postgres://postgres@127.0.0.1:5432/s453r -e PGRST_DB_SCHEMAS=public \
    -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=$SECRET -e PGRST_SERVER_PORT=3453 $IMG >/dev/null || exit 1
  sleep 4
  echo "== $IMG"
  R() { echo "$1 -> $(docker exec rig0431 bash /w453/http.sh 3453 /rpc/place_bid "$2" "$3")"; }
  R "b1 2-key, standard S2 (2-arg)        " $B1 "{\"p_lot_id\":\"$S2\",\"p_max_amount_cents\":600}"
  R "b1 2-key, per_unit U1 (2-arg refuses)" $B1 "{\"p_lot_id\":\"$U1\",\"p_max_amount_cents\":1235}"
  R "b1 3-key, per_unit U1 q=247 (3-arg)  " $B1 "{\"p_lot_id\":\"$U1\",\"p_max_amount_cents\":1235,\"p_unit_qty\":247}"
  R "b2 3-key, per_unit U1 q=246          " $B2 "{\"p_lot_id\":\"$U1\",\"p_max_amount_cents\":3705,\"p_unit_qty\":246}"
  R "b2 3-key, standard S7 q=null (3-arg) " $B2 "{\"p_lot_id\":\"$S7\",\"p_max_amount_cents\":500,\"p_unit_qty\":null}"
  R "anon 2-key, standard S2              " - "{\"p_lot_id\":\"$S2\",\"p_max_amount_cents\":900}"
  R "anon 3-key, per_unit U1              " - "{\"p_lot_id\":\"$U1\",\"p_max_amount_cents\":3705,\"p_unit_qty\":247}"
done
docker rm -f pgrst0453 >/dev/null 2>&1
