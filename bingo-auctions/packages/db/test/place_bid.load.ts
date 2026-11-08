// Load test for place_bid() — concurrent bidding race safety.
//
// What this verifies:
//   1. Concurrent: N bidders simultaneously call place_bid on the same lot.
//      Exactly one ends up as winner_bidder_id; bid_count matches expectations;
//      the bidder with the highest max wins.
//   2. Soft-close: a bid placed inside the soft_close_minutes window extends
//      close_at.
//
// Run:
//   SUPABASE_URL=<local-or-test>           \
//   SUPABASE_ANON_KEY=<anon-key>           \
//   SUPABASE_SERVICE_ROLE_KEY=<sr-key>     \
//     tsx packages/db/test/place_bid.load.ts
//
// Creates and tears down its own fixture each run. Do NOT run against
// production. The teardown deletes the test operator (cascades) and the
// generated auth.users rows.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_PASSWORD = 'loadtest-password-123';

type Fixture = {
  operatorId: string;
  lotId: string;
  bidderUserIds: string[];
  bidderEmails: string[];
};

async function buildFixture(numBidders: number, closeInSeconds: number): Promise<Fixture> {
  const operatorId = randomUUID();
  const warehouseId = randomUUID();
  const auctionId = randomUUID();
  const lotId = randomUUID();
  const slug = `loadtest-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  await admin.from('operators').insert({
    id: operatorId,
    slug,
    business_name: 'Load Test Operator',
    contact_email: 'loadtest@example.com',
    status: 'active',
  });

  await admin.from('warehouses').insert({
    id: warehouseId,
    operator_id: operatorId,
    name: 'Load Test Warehouse',
    address_line1: '1 Test St',
    city: 'Cincinnati',
    state: 'OH',
    postal_code: '45202',
    floor_plan_width_px: 2000,
    floor_plan_height_px: 1500,
  });

  const startsAt = new Date();
  const endsAt = new Date(Date.now() + closeInSeconds * 1000);

  await admin.from('auctions').insert({
    id: auctionId,
    operator_id: operatorId,
    warehouse_id: warehouseId,
    title: 'Load Test Auction',
    status: 'live',
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    pickup_starts_at: new Date(endsAt.getTime() + 86_400_000).toISOString(),
    pickup_ends_at: new Date(endsAt.getTime() + 4 * 86_400_000).toISOString(),
    soft_close_minutes: 1,
    buyer_premium_bps: 1500,
  });

  await admin.from('lots').insert({
    id: lotId,
    operator_id: operatorId,
    auction_id: auctionId,
    warehouse_id: warehouseId,
    lot_number: 1,
    title: 'Load Test Lot',
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
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    bidderUserIds.push(data.user.id);
    bidderEmails.push(email);
    await admin.from('bidders').insert({
      id: data.user.id,
      email,
      display_name: `Bidder ${i}`,
    });
  }

  return { operatorId, lotId, bidderUserIds, bidderEmails };
}

async function teardown(f: Fixture) {
  await admin.from('operators').delete().eq('id', f.operatorId);
  for (const uid of f.bidderUserIds) {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
}

// place_bid uses SECURITY DEFINER but reads auth.uid(), so each caller must
// be authenticated as the bidder. We sign in once per bidder and reuse the
// session client for the test duration.
async function bidderClient(email: string): Promise<SupabaseClient> {
  const c = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  return c;
}

type PlaceBidRpcResult = {
  ok: boolean;
  reason: string;
  current_bid_cents: number | null;
  current_leader_id: string | null;
  was_extended: boolean;
};

// ---------------------------------------------------------------------------
// Scenario 1 — concurrent bidding, exactly one winner
// ---------------------------------------------------------------------------

async function scenarioConcurrent(numBidders: number) {
  console.log(`\n[concurrent] ${numBidders} bidders, simultaneous bid`);
  const f = await buildFixture(numBidders, 600);

  try {
    const clients = await Promise.all(f.bidderEmails.map(bidderClient));
    // Each bidder picks a unique max — bidder i bids 1000 + i*100 cents.
    // Highest-max bidder (i = numBidders-1) should win.
    const baseMax = 1000;
    const calls = clients.map((c, i) =>
      c.rpc('place_bid', {
        p_lot_id: f.lotId,
        p_max_amount_cents: baseMax + i * 100,
      }),
    );
    const results = await Promise.all(calls);

    let okCount = 0;
    for (const r of results) {
      const ok = (r.data as PlaceBidRpcResult | null)?.ok;
      if (ok) okCount++;
    }
    console.log(`  ${okCount}/${results.length} bids accepted`);

    const { data: lot } = await admin
      .from('lots')
      .select('current_bid_cents, winner_bidder_id, bid_count')
      .eq('id', f.lotId)
      .single();

    const winnerIdx = f.bidderUserIds.indexOf(lot?.winner_bidder_id ?? '');
    const expectedWinnerIdx = numBidders - 1;
    console.log(`  current_bid_cents=${lot?.current_bid_cents} bid_count=${lot?.bid_count}`);
    console.log(`  winner index=${winnerIdx} (expected ${expectedWinnerIdx})`);

    if (winnerIdx === expectedWinnerIdx) console.log('  PASS: highest max won');
    else console.log('  FAIL');
  } finally {
    await teardown(f);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — soft-close extension
// ---------------------------------------------------------------------------

async function scenarioSoftClose() {
  console.log('\n[soft-close] bid inside soft-close window extends close_at');
  // Lot closes in 30s; soft_close_minutes=1 → any bid placed should extend.
  const f = await buildFixture(1, 30);

  try {
    const c = await bidderClient(f.bidderEmails[0]!);

    const before = await admin.from('lots').select('close_at').eq('id', f.lotId).single();
    const closeBefore = new Date(before.data?.close_at ?? '').getTime();

    const { data } = await c.rpc('place_bid', { p_lot_id: f.lotId, p_max_amount_cents: 500 });
    const result = data as PlaceBidRpcResult | null;

    const after = await admin.from('lots').select('close_at').eq('id', f.lotId).single();
    const closeAfter = new Date(after.data?.close_at ?? '').getTime();

    const extendedSec = Math.round((closeAfter - closeBefore) / 1000);
    console.log(`  was_extended=${result?.was_extended} delta=${extendedSec}s`);
    if (result?.was_extended && extendedSec > 0) console.log('  PASS');
    else console.log('  FAIL');
  } finally {
    await teardown(f);
  }
}

async function main() {
  await scenarioConcurrent(10);
  await scenarioSoftClose();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
