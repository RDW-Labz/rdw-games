// operators_public_view.regression.test.ts
//
// Behavioral regression test for mig 0204 — the operators_public view
// (OP-VIS-DEFENSE, Option B). Two properties must hold forever:
//
//   1. VISIBILITY FIX: a NON-active operator (e.g. status='pending' while
//      onboarding) is readable through operators_public by an anon/bidder
//      client — so its live lots stop being dropped by the apps' embed
//      null-filter. The base `operators` table must STILL hide that same row
//      from anon (the status='active' policy is intentionally untouched).
//
//   2. COLUMN SAFETY: the view exposes ONLY the allow-listed public columns.
//      Sensitive columns (stripe_account_id, application_fee_bps, contact_*,
//      legal_name, …) must be physically absent — selecting one errors 42703.
//      This is the guard against future column-creep re-introducing the kind
//      of cross-tenant leak that migration 0152 had to clean up.
//
// =========================================================================
// Runtime requirements
// =========================================================================
// Needs a full Supabase stack (anon key subject to RLS + service-role key to
// seed/clean the fixture). Gated behind OPERATORS_PUBLIC_REGRESSION=1 so normal
// CI only runs the always-on smoke test (never "0 tests").
//
//   supabase start
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_ANON_KEY=<anon> SUPABASE_SERVICE_ROLE_KEY=<svc> \
//   OPERATORS_PUBLIC_REGRESSION=1 \
//     npm run test --workspace=@auction-platform/db
// =========================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const RUN = process.env['OPERATORS_PUBLIC_REGRESSION'] === '1';

const url = process.env['SUPABASE_URL'];
const anonKey = process.env['SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

// The complete, intended public surface of operators_public. If a migration
// adds a column to the view, update this list DELIBERATELY (and prove it is
// safe for the whole public to read) — the test failing is the point.
const ALLOWED_COLUMNS = [
  'id',
  'slug',
  'business_name',
  'logo_url',
  'brand_color',
  'offers_pickup',
  'offers_shipping',
  'status',
  'default_buyer_premium_bps',
  'bid_increment_schedule',
].sort();

// Columns that must NEVER be reachable through the view.
const FORBIDDEN_COLUMNS = [
  'stripe_account_id',
  'application_fee_bps',
  'contact_email',
  'legal_name',
  'monthly_subscription_cents',
];

describe.skipIf(!RUN)(
  'operators_public view [OPERATORS_PUBLIC_REGRESSION=1 to enable]',
  () => {
    let admin: SupabaseClient;
    let anon: SupabaseClient;
    const pendingOperatorId = randomUUID();
    const slug = `opvis-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    beforeAll(async () => {
      if (!url || !anonKey || !serviceKey) {
        throw new Error(
          'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set',
        );
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      anon = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // A PENDING operator — the exact "goes dark" case. Seed a sentinel
      // stripe_account_id so the column-safety assertion is meaningful.
      const { error } = await admin.from('operators').insert({
        id: pendingOperatorId,
        slug,
        business_name: 'OpVis Pending Operator',
        contact_email: `${slug}@example.com`,
        stripe_account_id: 'acct_sentinel_should_never_leak',
        status: 'pending',
      });
      if (error) throw new Error(`seed operator failed: ${error.message}`);
    });

    afterAll(async () => {
      if (admin) await admin.from('operators').delete().eq('id', pendingOperatorId);
    });

    // -----------------------------------------------------------------------
    // T1. The pending operator is visible through the view to anon...
    // -----------------------------------------------------------------------
    it('exposes a pending (non-active) operator to anon via the view', async () => {
      const { data, error } = await anon
        .from('operators_public')
        .select('id, business_name, status')
        .eq('id', pendingOperatorId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect((data as { business_name: string }).business_name).toBe('OpVis Pending Operator');
      expect((data as { status: string }).status).toBe('pending');
    });

    // -----------------------------------------------------------------------
    // T2. ...but the BASE operators table still hides it from anon (the
    // status='active' RLS policy is intentionally NOT broadened by 0204).
    // -----------------------------------------------------------------------
    it('base operators table still hides the pending operator from anon', async () => {
      const { data, error } = await anon
        .from('operators')
        .select('id')
        .eq('id', pendingOperatorId)
        .maybeSingle();

      // RLS yields zero rows (not an error) for a non-active operator.
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    // -----------------------------------------------------------------------
    // T3. The view exposes EXACTLY the allow-listed columns — no more.
    // -----------------------------------------------------------------------
    it('exposes only the allow-listed public columns', async () => {
      const { data, error } = await anon
        .from('operators_public')
        .select('*')
        .eq('id', pendingOperatorId)
        .single();

      expect(error).toBeNull();
      expect(Object.keys(data as Record<string, unknown>).sort()).toEqual(ALLOWED_COLUMNS);
    });

    // -----------------------------------------------------------------------
    // T4. Each sensitive column is physically absent from the view — a direct
    // select errors 42703 (undefined_column), so it cannot leak.
    // -----------------------------------------------------------------------
    it.each(FORBIDDEN_COLUMNS)('does not expose sensitive column %s', async (col) => {
      const { error } = await anon.from('operators_public').select(col).limit(1);
      expect(error).not.toBeNull();
      expect(error?.code).toBe('42703');
    });
  },
);

// ---------------------------------------------------------------------------
// Smoke — always runs so CI never reports "0 tests" for this file.
// ---------------------------------------------------------------------------
it('operators_public regression module loads (smoke)', () => {
  expect(ALLOWED_COLUMNS).toContain('business_name');
  expect(ALLOWED_COLUMNS).not.toContain('stripe_account_id');
  expect(FORBIDDEN_COLUMNS).toContain('stripe_account_id');
});
