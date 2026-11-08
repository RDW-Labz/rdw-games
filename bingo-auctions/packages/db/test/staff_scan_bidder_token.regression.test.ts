// staff_scan_bidder_token.regression.test.ts
//
// Behavioral regression test for mig 0206's staff_scan_bidder_token() RPC —
// the consolidated pickup lookup that fixes the June-14 tester items #2
// ("Bidder (no name on file)") and #3 (receipt consolidation: one scan -> all
// of a bidder's active pickups at the caller's operator).
//
// =========================================================================
// IMPORTANT — Runtime requirements
// =========================================================================
//
// Requires a FULL Supabase stack (not a plain Postgres service) because the
// RPC calls auth.uid() + current_operator_id() (operator_users join), and the
// fixture uses supabase.auth.admin.createUser() (GoTrue Admin API). On vanilla
// Postgres auth.uid() is NULL and the function returns not_operator_staff for
// everything — which is exactly what packages/db/test/app_read_paths_smoke.sql
// asserts in CI (always-on, no stack). This file's gated suite is the
// happy-path coverage you run against a local stack.
//
// Gated behind STAFF_SCAN_REGRESSION=1 to avoid a false "0 tests" in normal
// CI. The file is always importable — the smoke test at the bottom always runs.
//
// To run the full suite:
//
//   supabase start
//   SUPABASE_URL=http://127.0.0.1:54321  \
//   SUPABASE_ANON_KEY=<anon-key>         \
//   SUPABASE_SERVICE_ROLE_KEY=<svc-key>  \
//   STAFF_SCAN_REGRESSION=1              \
//     npm run test:staff-scan --workspace=@auction-platform/db
//
// =========================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const RUN = process.env['STAFF_SCAN_REGRESSION'] === '1';

const url = process.env['SUPABASE_URL'];
const anonKey = process.env['SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

const TEST_PASSWORD = 'staffscan-password-123';

// ---------------------------------------------------------------------------
// Return shape mirror — staff_scan_bidder_token returns jsonb (plain object).
// ---------------------------------------------------------------------------

type ScanLot = {
  lot_id: string;
  lot_code: string;
  title: string;
  bin_code: string | null;
  staged: boolean;
  picked_up: boolean;
};
type ScanPickup = {
  invoice_id: string;
  pickup_id: string;
  token: string;
  status: string;
  invoice_total_cents: number | null;
  lots: ScanLot[];
};
type ScanResult = {
  ok: boolean;
  reason?: string;
  bidder?: { id: string; name: string | null; email: string | null };
  pickups?: ScanPickup[];
  total_invoices?: number;
  total_lots?: number;
};

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

type Fixture = {
  opAId: string;
  opACode: string;
  opBId: string;
  warehouseAId: string;
  warehouseBId: string;
  binAId: string;
  binACode: string;
  altBinAId: string;
  altBinACode: string;
  staffUserId: string;
  staffEmail: string;
  bidderId: string;
  bidderEmail: string;
  bidderName: string;
  // tokens for each pickup row
  token1: string; // invoice 1, pickup pending  (2 lots, op A)
  token2: string; // invoice 2, pickup scheduled (1 lot, op A)
  token3: string; // invoice 3, pickup completed (1 lot, op A) — EXCLUDED
  tokenB: string; // operator B's pickup        (1 lot, op B) — cross-tenant
};

// ---------------------------------------------------------------------------
// buildFixture
// ---------------------------------------------------------------------------

async function buildFixture(admin: SupabaseClient): Promise<Fixture> {
  const ts = Date.now();
  const rand = () => Math.floor(Math.random() * 9000) + 1000;

  // ── Operators ──────────────────────────────────────────────────────────
  const opAId = randomUUID();
  const opBId = randomUUID();
  const opACode = `S${rand()}`;

  const { error: opAErr } = await admin.from('operators').insert({
    id: opAId,
    slug: `staffscan-a-${ts}`,
    code: opACode,
    business_name: 'Staff Scan Test Operator A',
    contact_email: `a-${ts}@example.com`,
    status: 'active',
  });
  if (opAErr) throw new Error(`Insert operator A failed: ${opAErr.message}`);

  const { error: opBErr } = await admin.from('operators').insert({
    id: opBId,
    slug: `staffscan-b-${ts}`,
    code: `R${rand()}`,
    business_name: 'Staff Scan Test Operator B',
    contact_email: `b-${ts}@example.com`,
    status: 'active',
  });
  if (opBErr) throw new Error(`Insert operator B failed: ${opBErr.message}`);

  // ── Warehouses ─────────────────────────────────────────────────────────
  const warehouseAId = randomUUID();
  const warehouseBId = randomUUID();
  for (const [whId, opId, name] of [
    [warehouseAId, opAId, 'Staff Scan WH A'],
    [warehouseBId, opBId, 'Staff Scan WH B'],
  ] as const) {
    const { error } = await admin.from('warehouses').insert({
      id: whId,
      operator_id: opId,
      name,
      address_line1: '1 Test Lane',
      city: 'Little Rock',
      state: 'AR',
      postal_code: '72201',
    });
    if (error) throw new Error(`Insert warehouse ${name} failed: ${error.message}`);
  }

  // ── Bins (operator A) ────────────────────────────────────────────────────
  const binACode = 'A-01-1-01';
  const altBinACode = 'A-01-1-02';
  const { data: binAData, error: binAErr } = await admin
    .from('bins')
    .insert({ warehouse_id: warehouseAId, code: binACode, aisle: 'A', x_px: 100, y_px: 100, qr_token: randomUUID() })
    .select('id')
    .single();
  if (binAErr ?? !binAData) throw new Error(`Insert bin A failed: ${binAErr?.message}`);
  const binAId = (binAData as { id: string }).id;

  const { data: altBinData, error: altBinErr } = await admin
    .from('bins')
    .insert({ warehouse_id: warehouseAId, code: altBinACode, aisle: 'A', x_px: 200, y_px: 100, qr_token: randomUUID() })
    .select('id')
    .single();
  if (altBinErr ?? !altBinData) throw new Error(`Insert alt bin failed: ${altBinErr?.message}`);
  const altBinAId = (altBinData as { id: string }).id;

  // ── Staff user (operator A) ──────────────────────────────────────────────
  const staffEmail = `staffscan-staff-${ts}@example.com`;
  const { data: staffAuth, error: staffAuthErr } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthErr ?? !staffAuth.user) throw new Error(`createUser (staff) failed: ${staffAuthErr?.message}`);
  const staffUserId = staffAuth.user.id;

  const { error: ouErr } = await admin.from('operator_users').insert({
    operator_id: opAId,
    user_id: staffUserId,
    role: 'picker',
    email: staffEmail,
    display_name: 'Staff Scan Test Staff',
    accepted_at: new Date().toISOString(),
  });
  if (ouErr) throw new Error(`Insert operator_users failed: ${ouErr.message}`);

  // ── Bidder (auth user + bidders row; upsert is robust to a profile trigger) ─
  const bidderEmail = `staffscan-bidder-${ts}@example.com`;
  const bidderName = 'Scan Test Bidder';
  const { data: bidderAuth, error: bidderAuthErr } = await admin.auth.admin.createUser({
    email: bidderEmail,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (bidderAuthErr ?? !bidderAuth.user) throw new Error(`createUser (bidder) failed: ${bidderAuthErr?.message}`);
  const bidderId = bidderAuth.user.id;
  const { error: bidderErr } = await admin
    .from('bidders')
    .upsert({ id: bidderId, email: bidderEmail, display_name: bidderName });
  if (bidderErr) throw new Error(`Upsert bidder failed: ${bidderErr.message}`);

  // ── Auctions (one per operator) ───────────────────────────────────────────
  const auctionAId = randomUUID();
  const auctionBId = randomUUID();
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const plus = (h: number) => new Date(now.getTime() + h * 3600_000);
  for (const [aId, opId, whId, title] of [
    [auctionAId, opAId, warehouseAId, 'Staff Scan Auction A'],
    [auctionBId, opBId, warehouseBId, 'Staff Scan Auction B'],
  ] as const) {
    const { error } = await admin.from('auctions').insert({
      id: aId,
      operator_id: opId,
      warehouse_id: whId,
      title,
      starts_at: iso(plus(-48)),
      ends_at: iso(plus(-24)),
      pickup_starts_at: iso(plus(-12)),
      pickup_ends_at: iso(plus(72)),
    });
    if (error) throw new Error(`Insert auction ${title} failed: ${error.message}`);
  }

  // ── Lot helper ─────────────────────────────────────────────────────────
  let lotSeq = 0;
  async function makeLot(opId: string, auctionId: string, whId: string): Promise<string> {
    lotSeq += 1;
    const id = randomUUID();
    const lotCode = `${opId === opAId ? opACode : 'OPB'}-${String(lotSeq).padStart(6, '0')}`;
    const { error } = await admin.from('lots').insert({
      id,
      operator_id: opId,
      auction_id: auctionId,
      warehouse_id: whId,
      lot_code: lotCode,
      title: `Staff Scan Lot ${lotCode}`,
      condition: 'good',
      status: 'won',
      winner_bidder_id: bidderId,
    });
    if (error) throw new Error(`Insert lot ${lotCode} failed: ${error.message}`);
    return id;
  }

  // ── Invoice + pickup + bin-assignment helper ─────────────────────────────
  async function makePaidInvoiceWithPickup(args: {
    opId: string;
    auctionId: string;
    whId: string;
    lotIds: string[];
    binId: string;
    pickupStatus: 'pending' | 'scheduled' | 'completed';
    binStatus: 'staged' | 'picked_up';
    token: string;
  }): Promise<void> {
    const invoiceId = randomUUID();
    const { error: invErr } = await admin.from('invoices').insert({
      id: invoiceId,
      operator_id: args.opId,
      auction_id: args.auctionId,
      bidder_id: bidderId,
      status: 'paid',
      total_cents: 1000 * args.lotIds.length + 500,
      paid_at: new Date().toISOString(),
    });
    if (invErr) throw new Error(`Insert invoice failed: ${invErr.message}`);

    for (const lotId of args.lotIds) {
      const { error: ilErr } = await admin
        .from('invoice_lots')
        .insert({ invoice_id: invoiceId, lot_id: lotId, winning_bid_cents: 1000 });
      if (ilErr) throw new Error(`Insert invoice_lot failed: ${ilErr.message}`);
      const { error: baErr } = await admin
        .from('bin_assignments')
        .insert({ lot_id: lotId, bin_id: args.binId, status: args.binStatus });
      if (baErr) throw new Error(`Insert bin_assignment failed: ${baErr.message}`);
    }

    const { error: pkErr } = await admin.from('pickups').insert({
      invoice_id: invoiceId,
      warehouse_id: args.whId,
      status: args.pickupStatus,
      bidder_check_in_token: args.token,
      ...(args.pickupStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
    });
    if (pkErr) throw new Error(`Insert pickup failed: ${pkErr.message}`);
  }

  // Operator A — invoice 1: 2 lots, pickup pending
  const token1 = randomUUID();
  const lot1 = await makeLot(opAId, auctionAId, warehouseAId);
  const lot2 = await makeLot(opAId, auctionAId, warehouseAId);
  await makePaidInvoiceWithPickup({
    opId: opAId, auctionId: auctionAId, whId: warehouseAId,
    lotIds: [lot1, lot2], binId: binAId, pickupStatus: 'pending', binStatus: 'staged', token: token1,
  });

  // Operator A — invoice 2: 1 lot, pickup scheduled (alt bin)
  const token2 = randomUUID();
  const lot3 = await makeLot(opAId, auctionAId, warehouseAId);
  await makePaidInvoiceWithPickup({
    opId: opAId, auctionId: auctionAId, whId: warehouseAId,
    lotIds: [lot3], binId: altBinAId, pickupStatus: 'scheduled', binStatus: 'staged', token: token2,
  });

  // Operator A — invoice 3: 1 lot, pickup COMPLETED → must be excluded
  const token3 = randomUUID();
  const lot4 = await makeLot(opAId, auctionAId, warehouseAId);
  await makePaidInvoiceWithPickup({
    opId: opAId, auctionId: auctionAId, whId: warehouseAId,
    lotIds: [lot4], binId: binAId, pickupStatus: 'completed', binStatus: 'picked_up', token: token3,
  });

  // Operator B — invoice for the SAME bidder → cross-tenant token
  const tokenB = randomUUID();
  const lotB1 = await makeLot(opBId, auctionBId, warehouseBId);
  await makePaidInvoiceWithPickup({
    opId: opBId, auctionId: auctionBId, whId: warehouseBId,
    lotIds: [lotB1], binId: binAId, pickupStatus: 'pending', binStatus: 'staged', token: tokenB,
  });

  return {
    opAId, opACode, opBId,
    warehouseAId, warehouseBId,
    binAId, binACode, altBinAId, altBinACode,
    staffUserId, staffEmail,
    bidderId, bidderEmail, bidderName,
    token1, token2, token3, tokenB,
  };
}

async function teardown(admin: SupabaseClient, f: Fixture): Promise<void> {
  await admin.from('operators').delete().eq('id', f.opAId);
  await admin.from('operators').delete().eq('id', f.opBId);
  await admin.from('bidders').delete().eq('id', f.bidderId);
  await admin.auth.admin.deleteUser(f.staffUserId).catch(() => {});
  await admin.auth.admin.deleteUser(f.bidderId).catch(() => {});
}

async function makeStaffClient(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`staff signIn failed: ${error.message}`);
  return client;
}

async function callScan(client: SupabaseClient, token: string): Promise<ScanResult | null> {
  const { data, error } = await client.rpc('staff_scan_bidder_token', { p_token: token });
  if (error) throw new Error(`staff_scan_bidder_token RPC error: ${error.message}`);
  return data as ScanResult | null;
}

// ===========================================================================
// Suite — gated on STAFF_SCAN_REGRESSION=1
// ===========================================================================

describe.skipIf(!RUN)(
  'staff_scan_bidder_token() behavioral regression [STAFF_SCAN_REGRESSION=1 to enable]',
  () => {
    let admin: SupabaseClient;
    let staffClient: SupabaseClient;
    let f: Fixture;

    beforeAll(async () => {
      if (!url || !anonKey || !serviceKey) {
        throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set');
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      f = await buildFixture(admin);
      staffClient = await makeStaffClient(f.staffEmail);
    }, 45_000);

    afterAll(async () => {
      if (admin && f) await teardown(admin, f);
    }, 20_000);

    // -----------------------------------------------------------------------
    // #2 + #3 — one scan returns the bidder name + ALL active pickups.
    // -----------------------------------------------------------------------
    it('scan of an active token → bidder name + all active pickups (excludes completed)', async () => {
      const r = await callScan(staffClient, f.token1);

      expect(r?.ok).toBe(true);
      // #2: column-safe bidder identity present
      expect(r?.bidder?.name).toBe(f.bidderName);
      expect(r?.bidder?.email).toBe(f.bidderEmail);
      expect(r?.bidder?.id).toBe(f.bidderId);

      // #3: both ACTIVE invoices (1 pending + 2 scheduled), NOT the completed one
      expect(r?.total_invoices).toBe(2);
      expect(r?.total_lots).toBe(3); // 2 lots (inv1) + 1 lot (inv2)

      const statuses = (r?.pickups ?? []).map((p) => p.status).sort();
      expect(statuses).toEqual(['pending', 'scheduled']);

      // completed pickup token must NOT appear in the consolidated set
      const tokens = (r?.pickups ?? []).map((p) => p.token);
      expect(tokens).not.toContain(f.token3);
      expect(tokens).toContain(f.token1);
      expect(tokens).toContain(f.token2);

      // lot detail shape — staged flag + bin code resolved
      const inv1 = (r?.pickups ?? []).find((p) => p.token === f.token1);
      expect(inv1?.lots.length).toBe(2);
      expect(inv1?.lots.every((l) => l.staged === true)).toBe(true);
      expect(inv1?.lots.every((l) => l.picked_up === false)).toBe(true);
      expect(inv1?.lots.map((l) => l.bin_code)).toEqual([f.binACode, f.binACode]);
      expect(inv1?.lots.every((l) => typeof l.lot_code === 'string' && l.lot_code.length > 0)).toBe(true);
    }, 20_000);

    // -----------------------------------------------------------------------
    // A completed token still identifies the bidder + returns the ACTIVE set.
    // -----------------------------------------------------------------------
    it('scan of a completed token → still resolves bidder, returns only active pickups', async () => {
      const r = await callScan(staffClient, f.token3);
      expect(r?.ok).toBe(true);
      expect(r?.bidder?.name).toBe(f.bidderName);
      expect(r?.total_invoices).toBe(2);
      const tokens = (r?.pickups ?? []).map((p) => p.token);
      expect(tokens).not.toContain(f.token3);
    }, 20_000);

    // -----------------------------------------------------------------------
    // Cross-tenant — operator A's staff scanning operator B's token is denied.
    // -----------------------------------------------------------------------
    it('cross-operator token → other_operator (no bidder leak)', async () => {
      const r = await callScan(staffClient, f.tokenB);
      expect(r?.ok).toBe(false);
      expect(r?.reason).toBe('other_operator');
      expect(r?.bidder).toBeUndefined();
    }, 20_000);

    // -----------------------------------------------------------------------
    // Unknown token → token_not_found.
    // -----------------------------------------------------------------------
    it('unknown token → token_not_found', async () => {
      const r = await callScan(staffClient, randomUUID());
      expect(r?.ok).toBe(false);
      expect(r?.reason).toBe('token_not_found');
    }, 20_000);

    // -----------------------------------------------------------------------
    // Unauthenticated / non-staff caller → not_operator_staff (or PostgREST 401).
    // -----------------------------------------------------------------------
    it('anon caller → not_operator_staff (or PostgREST rejects)', async () => {
      const anon = createClient(url!, anonKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await anon.rpc('staff_scan_bidder_token', { p_token: f.token1 });
      if (error) {
        expect(
          error.message.toLowerCase().includes('authenticated') ||
            error.code === 'PGRST301' ||
            error.code === '28000',
        ).toBe(true);
      } else {
        const r = data as ScanResult | null;
        expect(r?.ok).toBe(false);
        expect(r?.reason).toBe('not_operator_staff');
      }
    }, 20_000);
  },
);

// ---------------------------------------------------------------------------
// Smoke — always runs (no DB). Ensures the module imports + gate constant is
// wired. CI's app_read_paths_smoke.sql covers the no-auth behavior on real PG.
// ---------------------------------------------------------------------------
it('staff_scan_bidder_token regression module loads (smoke)', () => {
  expect(typeof RUN).toBe('boolean');
  expect(RUN).toBe(process.env['STAFF_SCAN_REGRESSION'] === '1');
});
