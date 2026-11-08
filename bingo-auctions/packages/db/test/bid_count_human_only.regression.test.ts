// bid_count_human_only.regression.test.ts
//
// Behavioral regression test for mig 0191 — lots.bid_count must equal the
// number of DISTINCT HUMAN bids (bids.is_auto = false), never the inflated
// (real rows + manual increment) value that the pre-0191 double-write produced.
//
// =========================================================================
// IMPORTANT — Runtime requirements
// =========================================================================
//
// This test requires a FULL Supabase stack (not a plain Postgres service)
// because place_bid() is a SECURITY DEFINER function that calls auth.uid()
// to identify the calling user. On vanilla Postgres, auth.uid() always
// returns NULL and the function rejects every bid. Fixture setup also calls
// supabase.auth.admin.createUser(), which is only available via the Supabase
// GoTrue Admin API.
//
// The suite is gated behind BID_COUNT_REGRESSION=1 to avoid false "0 tests"
// results in normal CI. The smoke test at the bottom always runs so CI never
// reports "no test found".
//
// To run the full suite:
//
//   supabase start          # from repo root (requires supabase CLI)
//   # copy URL + keys from `supabase status`
//   SUPABASE_URL=http://127.0.0.1:54321  \
//   SUPABASE_ANON_KEY=<anon-key>         \
//   SUPABASE_SERVICE_ROLE_KEY=<svc-key>  \
//   BID_COUNT_REGRESSION=1               \
//     npm run test:bid-count --workspace=@auction-platform/db
//
// =========================================================================
// What this test proves (context for future readers)
// =========================================================================
//
// The 0191 bug: lots.bid_count double-wrote. The AFTER INSERT/DELETE trigger
// sync_lot_bid_count() recomputed count(*) FROM bids (no is_auto filter) AND
// place_bid()/buy_flat_price()/buy_dutch() ALSO manually bumped bid_count in
// their UPDATE lots SET — so the stored value = real rows + manual increment.
// Live proof: lot BRN4371782 had 1 human bid yet bid_count = 2.
//
// 0191 makes the trigger the single source of truth, counting is_auto = false
// rows only, and removes the three manual increments.
//
// Assertions:
//   T1. A single opening bid on an empty lot inserts ONE human bid row →
//       bid_count = 1 (not 2). This is the exact BRN4371782 shape.
//   T2. A proxy duel where bidder B outbids leader A inserts 2 bids rows
//       (1 human for B, 1 auto for the re-asserted leader) → bid_count counts
//       only the human rows, and always equals
//       count(*) FROM bids WHERE is_auto = false.
//   T3. Invariant: after N human bids across distinct bidders, bid_count
//       equals the number of is_auto = false rows, and is strictly less than
//       the total bids row count once any proxy/auto row exists.
//
// References: mig 0101 (original sync trigger), mig 0176 (live place_bid),
//             mig 0009 (buy_dutch / buy_flat_price), mig 0191 (this fix).
// =========================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const RUN = process.env['BID_COUNT_REGRESSION'] === '1';

const url = process.env['SUPABASE_URL'];
const anonKey = process.env['SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

const TEST_PASSWORD = 'bidcount-password-123';

type Fixture = {
  operatorId: string;
  lotId: string;
  bidderUserIds: string[];
  bidderEmails: string[];
};

type PlaceBidRpcResult = {
  ok: boolean;
  reason: string;
  current_bid_cents: number | null;
  current_leader_id: string | null;
  was_extended: boolean;
};

// ---------------------------------------------------------------------------
// Fixture — one operator/warehouse/auction/lot + N bidders with a payment
// method on file (place_bid's 0104 §A gate rejects bidders without one).
// ---------------------------------------------------------------------------

async function buildFixture(admin: SupabaseClient, numBidders: number): Promise<Fixture> {
  const operatorId = randomUUID();
  const warehouseId = randomUUID();
  const auctionId = randomUUID();
  const lotId = randomUUID();
  const slug = `bidcount-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  await admin.from('operators').insert({
    id: operatorId,
    slug,
    business_name: 'Bid Count Test Operator',
    contact_email: `bidcount-${Date.now()}@example.com`,
    status: 'active',
  });

  await admin.from('warehouses').insert({
    id: warehouseId,
    operator_id: operatorId,
    name: 'Bid Count Test Warehouse',
    address_line1: '1 Test St',
    city: 'Cincinnati',
    state: 'OH',
    postal_code: '45202',
    floor_plan_width_px: 2000,
    floor_plan_height_px: 1500,
  });

  // Long close window + soft_close_minutes = 0 so bids never extend/close mid-test.
  const endsAt = new Date(Date.now() + 3600 * 1000);

  await admin.from('auctions').insert({
    id: auctionId,
    operator_id: operatorId,
    warehouse_id: warehouseId,
    title: 'Bid Count Test Auction',
    status: 'live',
    format: 'standard',
    starts_at: new Date().toISOString(),
    ends_at: endsAt.toISOString(),
    pickup_starts_at: new Date(endsAt.getTime() + 86_400_000).toISOString(),
    pickup_ends_at: new Date(endsAt.getTime() + 4 * 86_400_000).toISOString(),
    soft_close_minutes: 0,
    buyer_premium_bps: 1500,
  });

  await admin.from('lots').insert({
    id: lotId,
    operator_id: operatorId,
    auction_id: auctionId,
    warehouse_id: warehouseId,
    lot_number: 1,
    title: 'Bid Count Test Lot',
    condition: 'good',
    starting_bid_cents: 100,
    close_at: endsAt.toISOString(),
    status: 'live',
  });

  const bidderUserIds: string[] = [];
  const bidderEmails: string[] = [];
  for (let i = 0; i < numBidders; i++) {
    const email = `${slug}-${i}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (error ?? !data.user) throw new Error(`createUser failed: ${error?.message}`);
    bidderUserIds.push(data.user.id);
    bidderEmails.push(email);
    // default_payment_method_id must be non-null or place_bid returns
    // 'no_payment_method' (0104 §A). A sentinel string is sufficient — the
    // RPC only checks IS NULL, it does not dereference the value.
    await admin.from('bidders').insert({
      id: data.user.id,
      email,
      display_name: `Bidder ${i}`,
      default_payment_method_id: `pm_test_${i}`,
    });
  }

  return { operatorId, lotId, bidderUserIds, bidderEmails };
}

async function teardown(admin: SupabaseClient, f: Fixture): Promise<void> {
  await admin.from('operators').delete().eq('id', f.operatorId);
  for (const uid of f.bidderUserIds) {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
}

async function makeBidderClient(email: string): Promise<SupabaseClient> {
  const c = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  return c;
}

// Count helpers via the service-role admin client (bypasses RLS).
async function getBidCount(admin: SupabaseClient, lotId: string): Promise<number> {
  const { data, error } = await admin
    .from('lots')
    .select('bid_count')
    .eq('id', lotId)
    .single();
  if (error) throw new Error(`select bid_count failed: ${error.message}`);
  return (data as { bid_count: number }).bid_count;
}

async function countBidRows(
  admin: SupabaseClient,
  lotId: string,
  opts?: { isAuto?: boolean },
): Promise<number> {
  let q = admin.from('bids').select('id', { count: 'exact', head: true }).eq('lot_id', lotId);
  if (opts?.isAuto !== undefined) q = q.eq('is_auto', opts.isAuto);
  const { count, error } = await q;
  if (error) throw new Error(`count bids failed: ${error.message}`);
  return count ?? 0;
}

// ===========================================================================
// Suite — gated on BID_COUNT_REGRESSION=1
// ===========================================================================

describe.skipIf(!RUN)(
  'lots.bid_count = human bids only [BID_COUNT_REGRESSION=1 to enable]',
  () => {
    let admin: SupabaseClient;

    beforeAll(() => {
      if (!url || !anonKey || !serviceKey) {
        throw new Error(
          'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set',
        );
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    });

    // -----------------------------------------------------------------------
    // T1. Single opening bid → bid_count = 1 (the BRN4371782 shape).
    // One human bid row, zero auto rows. Pre-0191 this read 2.
    // -----------------------------------------------------------------------
    it('single opening bid → bid_count = 1, not 2', async () => {
      const f = await buildFixture(admin, 1);
      try {
        const c = await makeBidderClient(f.bidderEmails[0]!);

        const { data } = await c.rpc('place_bid', {
          p_lot_id: f.lotId,
          p_max_amount_cents: 500,
        });
        const result = data as PlaceBidRpcResult | null;
        expect(result?.ok).toBe(true);

        const humanRows = await countBidRows(admin, f.lotId, { isAuto: false });
        const autoRows = await countBidRows(admin, f.lotId, { isAuto: true });
        const bidCount = await getBidCount(admin, f.lotId);

        expect(humanRows).toBe(1);
        expect(autoRows).toBe(0);
        // The regression: must be 1 (human bids), NOT 2 (the old +1 manual drift).
        expect(bidCount).toBe(1);
      } finally {
        await teardown(admin, f);
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // T2. Proxy duel: B outbids leader A. place_bid inserts B's human bid plus
    // one auto (is_auto = true) row re-asserting the leader. bid_count must
    // count only the human rows and equal count(is_auto = false).
    // -----------------------------------------------------------------------
    it('proxy duel → bid_count counts human rows only', async () => {
      const f = await buildFixture(admin, 2);
      try {
        const a = await makeBidderClient(f.bidderEmails[0]!);
        const b = await makeBidderClient(f.bidderEmails[1]!);

        // A opens at 1000 (becomes leader).
        const ra = await a.rpc('place_bid', { p_lot_id: f.lotId, p_max_amount_cents: 1000 });
        expect((ra.data as PlaceBidRpcResult | null)?.ok).toBe(true);

        // B bids 2000 — outbids A. This triggers the auto-bid row for A.
        const rb = await b.rpc('place_bid', { p_lot_id: f.lotId, p_max_amount_cents: 2000 });
        expect((rb.data as PlaceBidRpcResult | null)?.ok).toBe(true);

        const humanRows = await countBidRows(admin, f.lotId, { isAuto: false });
        const autoRows = await countBidRows(admin, f.lotId, { isAuto: true });
        const totalRows = await countBidRows(admin, f.lotId);
        const bidCount = await getBidCount(admin, f.lotId);

        // Two humans bid once each → 2 human rows. At least one auto row from
        // the duel. bid_count must equal the human-row count, and be strictly
        // less than the total once an auto row exists.
        expect(humanRows).toBe(2);
        expect(autoRows).toBeGreaterThanOrEqual(1);
        expect(bidCount).toBe(humanRows);
        expect(bidCount).toBeLessThan(totalRows);
      } finally {
        await teardown(admin, f);
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // T3. General invariant: bid_count == count(*) FROM bids WHERE is_auto =
    // false, regardless of how many proxy rows the duels produced.
    // -----------------------------------------------------------------------
    it('invariant: bid_count == human-bid row count after several bids', async () => {
      const f = await buildFixture(admin, 3);
      try {
        const clients = await Promise.all(f.bidderEmails.map(makeBidderClient));

        // Sequential escalating bids so each one is accepted as a new top.
        for (let i = 0; i < clients.length; i++) {
          const r = await clients[i]!.rpc('place_bid', {
            p_lot_id: f.lotId,
            p_max_amount_cents: 1000 + i * 1000,
          });
          expect((r.data as PlaceBidRpcResult | null)?.ok).toBe(true);
        }

        const humanRows = await countBidRows(admin, f.lotId, { isAuto: false });
        const bidCount = await getBidCount(admin, f.lotId);

        expect(humanRows).toBe(3);
        expect(bidCount).toBe(humanRows);
      } finally {
        await teardown(admin, f);
      }
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// Smoke test — always runs, even when the suite is skipped, so CI never
// reports "0 tests" for this file.
// ---------------------------------------------------------------------------
it('bid_count regression test module loads (smoke)', () => {
  expect(typeof RUN).toBe('boolean');
  expect(RUN).toBe(process.env['BID_COUNT_REGRESSION'] === '1');
});
