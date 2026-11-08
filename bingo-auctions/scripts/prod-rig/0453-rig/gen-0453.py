#!/usr/bin/env python3
"""Build 0453 (and its rollback) from the LIVE place_bid body, so every byte of
both function bodies is provably "the live body + the listed edits".

Live body = 0263's CREATE OR REPLACE (packages/db/migrations/0263, lines
28-382) with 0350's one-statement GREATEST patch applied, exactly as 0350 did
it on prod (pg_get_functiondef + replace). prosrc md5 of that body is
7b6261a9548864b102f841546003db0d — the same md5 rig0431's master replay
reports (0350 patched the 0263 body in place there too).

Every edit below is an anchored replace that must match exactly once, or the
script stops. Usage:
  python3 gen-0453.py <repo root> <out migration> <out rollback> [<out bodies>]
"""
import hashlib
import sys

ROOT, OUT_MIG, OUT_RB = sys.argv[1], sys.argv[2], sys.argv[3]

SENTENCE = 'Bidding on this lot needs the latest BinGo app. Please update to bid.'


def once(s, old, new, what):
    n = s.count(old)
    if n != 1:
        sys.exit(f'gen-0453: anchor for {what!r} matched {n} times, expected 1')
    return s.replace(old, new)


def body_of(defn):
    a = defn.index('$function$') + len('$function$')
    b = defn.rindex('$function$')
    return defn[a:b]


md5 = lambda t: hashlib.md5(t.encode()).hexdigest()

src = open(f'{ROOT}/packages/db/migrations/0263_restore_outbid_notification.sql').read().split('\n')
live = '\n'.join(src[27:382]) + '\n'
assert live.startswith('CREATE OR REPLACE FUNCTION public.place_bid(p_lot_id uuid, p_max_amount_cents bigint)\n')
assert live.endswith('END;\n$function$;\n')
live = once(live,
            '    UPDATE bids\n    SET max_amount_cents = p_max_amount_cents\n    WHERE id = v_current_max_bid.id;',
            '    UPDATE bids\n    SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)\n    WHERE id = v_current_max_bid.id;',
            '0350 GREATEST patch')
PRE_MD5 = md5(body_of(live))
assert PRE_MD5 == '7b6261a9548864b102f841546003db0d', PRE_MD5

LOCK = '  PERFORM pg_advisory_xact_lock(hashtext(p_lot_id::text));\n'

# ── 2-arg: live body + ONE inserted block right after the advisory lock ──────
two = once(live, LOCK + '\n', LOCK + f'''
  -- 0453 (sq-ft bidding 3/11): a lot in a per_unit auction is bid ONLY through
  -- the 3-arg place_bid(p_lot_id, p_max_amount_cents, p_unit_qty), which the
  -- updated apps call with the lot's unit_qty. An app bundle that predates
  -- per-unit pricing calls this 2-arg form and would bid a TOTAL on the
  -- standard ladder (not a whole number of cents per unit), so it is refused
  -- here, first thing, with a sentence old bundles show as-is
  -- ("Bid rejected: <reason>"). Standard auctions never enter this branch.
  IF EXISTS (
    SELECT 1
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
    WHERE l.id = p_lot_id
      AND a.bid_mode = 'per_unit'
  ) THEN
    v_result := (false, '{SENTENCE}',
                 p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

''', '2-arg refusal')
POST_MD5 = md5(body_of(two))

# ── 3-arg: standard lots → the 2-arg; per_unit lots → live body + §4 rules ───
three = live
three = once(three,
             'CREATE OR REPLACE FUNCTION public.place_bid(p_lot_id uuid, p_max_amount_cents bigint)\n',
             'CREATE OR REPLACE FUNCTION public.place_bid(p_lot_id uuid, p_max_amount_cents bigint, p_unit_qty integer)\n',
             'signature')
three = once(three, '''  v_self_raise BOOLEAN := false;
BEGIN
''', '''  v_self_raise BOOLEAN := false;
  -- 0453 additions (per_unit only):
  v_bid_mode TEXT;  -- auctions.bid_mode of the lot's auction
  v_q        BIGINT; -- lots.unit_qty: every stored amount is a multiple of it
BEGIN
  -- =========================================================================
  -- 0453: STANDARD LOTS RUN THE 2-ARG ENGINE, UNCHANGED.
  -- Anything that is not a per_unit auction (standard, no auction, no lot)
  -- returns exactly what place_bid(p_lot_id, p_max_amount_cents) returns —
  -- same code, same locks, same rows. p_unit_qty is ignored for them. Only
  -- per_unit lots run the body below, which is the 2-arg body plus the
  -- per-unit rules marked 0453.
  -- =========================================================================
  SELECT a.bid_mode INTO v_bid_mode
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
   WHERE l.id = p_lot_id;

  IF v_bid_mode IS DISTINCT FROM 'per_unit' THEN
    RETURN public.place_bid(p_lot_id, p_max_amount_cents);
  END IF;

''', '3-arg declare + standard delegation')
three = once(three, '''  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

''', '''  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

  -- 0453: re-read under the lock. If the auction stopped being per_unit
  -- between the read above and the lock, it is a standard lot now: hand it to
  -- the 2-arg engine (advisory xact locks are re-entrant; nothing has been
  -- written yet).
  IF v_auction.bid_mode IS DISTINCT FROM 'per_unit' THEN
    RETURN public.place_bid(p_lot_id, p_max_amount_cents);
  END IF;

''', '3-arg recheck under lock')
three = once(three, '''  -- 3. Validate amount
  -- 0194: increment now reads from the effective schedule
  -- COALESCE(auction override, operator default). NULL → legacy ladder.
  v_min_increment := min_bid_increment_cents(
    v_lot.current_bid_cents,
    COALESCE(v_auction.bid_increment_schedule, v_op_schedule)
  );
''', '''  -- 3. Validate amount
  -- =========================================================================
  -- 0453: PER-UNIT RULES (spec §4). Stored amounts stay TOTALS in cents; every
  -- total on a per_unit lot is a whole multiple of q = lots.unit_qty, so
  -- per-unit = total / q is always a whole number of cents.
  --   1. q > 0 and q = p_unit_qty (the client priced the lot we hold)
  --   2. the max is a whole multiple of q
  --   3. the lot's starting bid is a whole multiple of q
  --   4. the auction carries its OWN per-unit ladder; the operator default is
  --      a whole-item ladder ($1 = $247 a raise on 247 sq ft) and is never used
  --   5. increment = per-unit step at (current / q), times q
  -- Then the unchanged start / increment checks and proxy duel below. Proxy
  -- terms: starting bid, maxes and v_min_increment are all multiples of q,
  -- so LEAST/GREATEST of their sums are too.
  -- =========================================================================
  v_q := v_lot.unit_qty;
  IF v_q IS NULL OR v_q <= 0 OR p_unit_qty IS NULL OR p_unit_qty <> v_q THEN
    v_result := (false, 'unit_qty_mismatch', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  IF p_max_amount_cents % v_q <> 0 THEN
    v_result := (false, 'not_whole_cents_per_unit', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  IF v_lot.starting_bid_cents IS NULL OR v_lot.starting_bid_cents % v_q <> 0 THEN
    v_result := (false, 'lot_start_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- A tier must apply at the current per-unit price, or min_bid_increment_cents
  -- would fall back to the whole-item legacy ladder.
  IF jsonb_typeof(v_auction.bid_increment_schedule) IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_to_recordset(
              CASE WHEN jsonb_typeof(v_auction.bid_increment_schedule) = 'array'
                   THEN v_auction.bid_increment_schedule ELSE '[]'::jsonb END
            ) AS t(min_cents BIGINT, step_cents BIGINT)
       WHERE t.min_cents <= COALESCE(v_lot.current_bid_cents / v_q, 0)
         AND t.step_cents IS NOT NULL
     ) THEN
    v_result := (false, 'per_unit_schedule_missing', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- Defensive: the lot's price must already be a multiple (it always is when
  -- every bid came through this function; it is not if the auction was
  -- switched to per_unit after standard bids — PR 4's lock prevents that).
  IF v_lot.current_bid_cents % v_q <> 0 THEN
    v_result := (false, 'lot_amounts_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  v_min_increment := min_bid_increment_cents(
    v_lot.current_bid_cents / v_q,
    v_auction.bid_increment_schedule
  ) * v_q;

  IF v_min_increment IS NULL OR v_min_increment <= 0 THEN
    v_result := (false, 'per_unit_schedule_missing', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;
''', '3-arg per-unit validation')
three = once(three, '''  ORDER BY b.placed_at DESC
  LIMIT 1;

''', '''  ORDER BY b.placed_at DESC
  LIMIT 1;

  -- 0453: defensive, as above — the leader's max must be a multiple of q.
  IF v_current_max_bid.max_amount_cents % v_q <> 0 THEN
    v_result := (false, 'lot_amounts_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

''', '3-arg leader max multiple')
# The operator schedule is never used on the per-unit path; leave its SELECT in
# place (byte-identical to the 2-arg) — it is a read, harmless.

HEADER = open(f'{ROOT}/scripts/prod-rig/0453-rig/header-0453.sql').read()
RB_HEADER = open(f'{ROOT}/scripts/prod-rig/0453-rig/header-0453-rollback.sql').read()

mig = HEADER.replace('@PRE_MD5@', PRE_MD5).replace('@POST_MD5@', POST_MD5) + f'''SET lock_timeout = '3s';

BEGIN;

-- ── 0. Preflight: fail loudly, change nothing ───────────────────────────────
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'auctions' AND column_name = 'bid_mode')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lots' AND column_name = 'unit_qty') THEN
    RAISE EXCEPTION '0453: auctions.bid_mode / lots.unit_qty missing — apply 0451 first';
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure;
  IF v_md5 NOT IN ('{PRE_MD5}', '{POST_MD5}') THEN
    RAISE EXCEPTION '0453: live place_bid(uuid,bigint) body is not the 0263+0350 body this migration was built from (md5 %) — refusing to overwrite unseen code', v_md5;
  END IF;
END
$pre$;

-- ── 1. 2-arg place_bid: live body + per_unit refusal at the top ─────────────
{two}
GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;

-- ── 2. 3-arg place_bid: standard → 2-arg; per_unit → spec §4 ────────────────
{three}
GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.place_bid(UUID, BIGINT, INTEGER) IS
  '0453: per-unit (sq ft) bidding. Standard lots: identical to '
  'place_bid(uuid,bigint) (it calls it). per_unit lots: p_unit_qty must equal '
  'lots.unit_qty; max, starting bid and increments are whole multiples of it; '
  'the auction''s own bid_increment_schedule is per unit. Amounts are totals.';

-- ── 3. Postflight: the result is what was proven on the rig ─────────────────
DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure) <> '{POST_MD5}' THEN
    RAISE EXCEPTION '0453: 2-arg body after apply is not the proven body';
  END IF;
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'place_bid' AND pronamespace = 'public'::regnamespace) <> 2 THEN
    RAISE EXCEPTION '0453: expected exactly two place_bid overloads';
  END IF;
  -- Same EXECUTE grants on both overloads (the 3-arg gets whatever the 2-arg
  -- has: CREATE FUNCTION's defaults plus the explicit GRANT above).
  IF EXISTS (
    (SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint)'::regprocedure
     EXCEPT
     SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint,integer)'::regprocedure)
    UNION ALL
    (SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint,integer)'::regprocedure
     EXCEPT
     SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint)'::regprocedure)
  ) THEN
    RAISE EXCEPTION '0453: 3-arg place_bid grants differ from the 2-arg';
  END IF;
END
$post$;

COMMIT;
'''

rb = RB_HEADER.replace('@PRE_MD5@', PRE_MD5) + f'''SET lock_timeout = '3s';

BEGIN;

DROP FUNCTION IF EXISTS public.place_bid(uuid, bigint, integer);

{live}
GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;

DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure) <> '{PRE_MD5}' THEN
    RAISE EXCEPTION '0453 rollback: 2-arg body is not the pre-0453 (0263+0350) body';
  END IF;
END
$post$;

COMMIT;
'''

open(OUT_MIG, 'w').write(mig)
open(OUT_RB, 'w').write(rb)
if len(sys.argv) > 4:
    open(sys.argv[4], 'w').write(live + '\n=====2ARG=====\n' + two + '\n=====3ARG=====\n' + three)
print('pre_md5', PRE_MD5, 'post_md5', POST_MD5)
