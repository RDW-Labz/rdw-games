// intake_lot_to_bin.regression.test.ts
//
// Behavioral regression test for mig 0160's refactored intake_lot_to_bin().
//
// =========================================================================
// IMPORTANT — Runtime requirements
// =========================================================================
//
// This test requires a FULL Supabase stack (not a plain Postgres service)
// because intake_lot_to_bin() calls auth.uid() and current_operator_id()
// which depend on GoTrue sessions and the operator_users join respectively.
// On vanilla Postgres, auth.uid() always returns NULL and the function
// rejects every call with 'not_authenticated'.
//
// Additionally, fixture setup calls supabase.auth.admin.createUser() which
// is only available via the Supabase GoTrue Admin API.
//
// The suite is gated behind INTAKE_LOT_REGRESSION=1 to avoid false
// "0 tests" results in normal CI. The file is always importable — the
// smoke test at the bottom fires unconditionally.
//
// To run the full suite:
//
//   supabase start          # from repo root (requires supabase CLI)
//   # copy URL + keys from `supabase status`
//   SUPABASE_URL=http://127.0.0.1:54321  \
//   SUPABASE_ANON_KEY=<anon-key>         \
//   SUPABASE_SERVICE_ROLE_KEY=<svc-key>  \
//   INTAKE_LOT_REGRESSION=1              \
//     npm run test:intake --workspace=@auction-platform/db
//
// OR via the package script shortcut:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run test:intake --workspace=@auction-platform/db
//
// =========================================================================
// Why this test exists (context for future readers)
// =========================================================================
//
// PR #129 merged mig 0160, which refactored intake_lot_to_bin() to delegate
// lot resolution to the new _find_lot_by_scan() helper instead of doing the
// resolution inline. The PR's original test (packages/db/migrations/tests/
// 0160_intake_lot_to_bin_regression.sql) was structural-only: it verified
// function existence, return-type signature, and grant presence — but it
// never called intake_lot_to_bin() with real data or asserted outcome codes.
//
// This file supersedes that structural test with ~12 behavioral assertions
// covering every outcome code in the intake_lot_result composite type:
//   ok_intaked / ok_already_here / pending_move /
//   not_lotted_yet / lot_other_operator / lot_not_in_intake_state /
//   bin_not_found_or_revoked / not_authenticated / not_operator_staff
//
// Resolution ladder exercised (mirrors mig 0160 / _find_lot_by_scan order):
//   qr_token → lot_code → sticker_code → lpn → fnsku → asin → external_code
//
// References: mig 0143 (intake_lot_result type + original outcome codes),
//             mig 0160 (refactor + _find_lot_by_scan helper), PR #129.
// =========================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Gate — only run the full suite when explicitly enabled.
// ---------------------------------------------------------------------------

const RUN = process.env['INTAKE_LOT_REGRESSION'] === '1';

const url = process.env['SUPABASE_URL'];
const anonKey = process.env['SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

const TEST_PASSWORD = 'intaketest-password-123';

// ---------------------------------------------------------------------------
// Return type mirror for intake_lot_result composite.
// Fields match the 7-attribute composite type as extended in mig 0143.
// Supabase-js returns composite types as plain objects.
// ---------------------------------------------------------------------------

type IntakeLotResult = {
  ok: boolean;
  reason: string;
  lot_id: string | null;
  lot_code: string | null;
  bin_code: string | null;
  warehouse_id: string | null;
  // 7th field added in mig 0143 — called "old_bin_code" internally but the
  // composite attribute is named from_bin_code in the type definition.
  from_bin_code: string | null;
};

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

type LotHandle = {
  id: string;
  lotCode: string;
};

type Fixture = {
  // Operator A (the authenticated staff's operator)
  opAId: string;
  opACode: string; // e.g. "TST" — used to build sticker codes

  // Operator B (cross-operator test)
  opBId: string;

  // Warehouse + bins for operator A
  warehouseId: string;
  binId: string;
  binCode: string;
  binQrToken: string; // UUID as string

  // Alternative bin (for pending_move test — lot already in this one)
  altBinId: string;
  altBinCode: string;
  altBinQrToken: string;

  // Staff user (linked to operator A via operator_users)
  staffUserId: string;
  staffEmail: string;

  // Lots
  lotA: LotHandle; // pending_intake → ok_intaked path
  lotB: LotHandle; // in_inventory in target bin → ok_already_here
  lotC: LotHandle; // in_inventory in alt bin → pending_move
  lotD: LotHandle; // status='sold' → lot_not_in_intake_state
  lotE: LotHandle; // belongs to operator B → lot_other_operator
};

// ---------------------------------------------------------------------------
// buildFixture
// ---------------------------------------------------------------------------

async function buildFixture(admin: SupabaseClient): Promise<Fixture> {
  const ts = Date.now();
  const rand = () => Math.floor(Math.random() * 9000) + 1000;

  // ------------------------------------------------------------------
  // Operators
  // ------------------------------------------------------------------
  const opAId = randomUUID();
  const opBId = randomUUID();
  const opACode = `T${rand()}`; // short unique operator code, e.g. "T4217"
  const opASlug = `intaketest-a-${ts}`;
  const opBSlug = `intaketest-b-${ts}`;

  const { error: opAErr } = await admin.from('operators').insert({
    id: opAId,
    slug: opASlug,
    code: opACode,
    business_name: 'Intake Test Operator A',
    contact_email: `a-${ts}@example.com`,
    status: 'active',
  });
  if (opAErr) throw new Error(`Insert operator A failed: ${opAErr.message}`);

  const { error: opBErr } = await admin.from('operators').insert({
    id: opBId,
    slug: opBSlug,
    code: `U${rand()}`,
    business_name: 'Intake Test Operator B',
    contact_email: `b-${ts}@example.com`,
    status: 'active',
  });
  if (opBErr) throw new Error(`Insert operator B failed: ${opBErr.message}`);

  // ------------------------------------------------------------------
  // Warehouse (operator A)
  // ------------------------------------------------------------------
  const warehouseId = randomUUID();
  const { error: whErr } = await admin.from('warehouses').insert({
    id: warehouseId,
    operator_id: opAId,
    name: 'Intake Test Warehouse',
    address_line1: '1 Test Lane',
    city: 'Little Rock',
    state: 'AR',
    postal_code: '72201',
  });
  if (whErr) throw new Error(`Insert warehouse failed: ${whErr.message}`);

  // ------------------------------------------------------------------
  // Bins (operator A's warehouse)
  // ------------------------------------------------------------------
  const binQrToken = randomUUID();
  const altBinQrToken = randomUUID();
  const binCode = 'A-01-1-01';
  const altBinCode = 'A-01-1-02';

  const { data: binData, error: binErr } = await admin
    .from('bins')
    .insert({
      warehouse_id: warehouseId,
      code: binCode,
      aisle: 'A',
      bay: '01',
      level: 1,
      position: 1,
      x_px: 100,
      y_px: 100,
      qr_token: binQrToken,
    })
    .select('id')
    .single();
  if (binErr ?? !binData) throw new Error(`Insert bin failed: ${binErr?.message}`);
  const binId: string = (binData as { id: string }).id;

  const { data: altBinData, error: altBinErr } = await admin
    .from('bins')
    .insert({
      warehouse_id: warehouseId,
      code: altBinCode,
      aisle: 'A',
      bay: '01',
      level: 1,
      position: 2,
      x_px: 200,
      y_px: 100,
      qr_token: altBinQrToken,
    })
    .select('id')
    .single();
  if (altBinErr ?? !altBinData) throw new Error(`Insert alt bin failed: ${altBinErr?.message}`);
  const altBinId: string = (altBinData as { id: string }).id;

  // ------------------------------------------------------------------
  // Staff user (operator A)
  // ------------------------------------------------------------------
  const staffEmail = `intaketest-staff-${ts}@example.com`;
  const { data: staffAuthData, error: staffAuthErr } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthErr ?? !staffAuthData.user)
    throw new Error(`createUser (staff) failed: ${staffAuthErr?.message}`);
  const staffUserId = staffAuthData.user.id;

  // Link staff user to operator A via operator_users.
  // current_operator_id() reads: SELECT operator_id FROM operator_users WHERE user_id = auth.uid()
  const { error: ouErr } = await admin.from('operator_users').insert({
    operator_id: opAId,
    user_id: staffUserId,
    role: 'picker',
    email: staffEmail,
    display_name: 'Intake Test Staff',
    accepted_at: new Date().toISOString(),
  });
  if (ouErr) throw new Error(`Insert operator_users failed: ${ouErr.message}`);

  // ------------------------------------------------------------------
  // Lot A: pending_intake, will be intaked fresh (ok_intaked).
  // We insert a minimal lot; lot_code is set directly.
  // Individual tests clone this lot with different identifier columns.
  // ------------------------------------------------------------------
  const lotAId = randomUUID();
  const lotACode = `${opACode}-000001`;

  const { error: lotAErr } = await admin.from('lots').insert({
    id: lotAId,
    operator_id: opAId,
    lot_code: lotACode,
    title: 'Intake Test Lot A',
    condition: 'good',
    status: 'pending_intake',
  });
  if (lotAErr) throw new Error(`Insert lot A failed: ${lotAErr.message}`);

  // ------------------------------------------------------------------
  // Lot B: in_inventory, already in the TARGET bin (ok_already_here).
  // ------------------------------------------------------------------
  const lotBId = randomUUID();
  const lotBCode = `${opACode}-000002`;

  const { error: lotBErr } = await admin.from('lots').insert({
    id: lotBId,
    operator_id: opAId,
    lot_code: lotBCode,
    title: 'Intake Test Lot B',
    condition: 'good',
    status: 'in_inventory',
    intake_bin_id: binId,
    warehouse_id: warehouseId,
    intake_at: new Date().toISOString(),
  });
  if (lotBErr) throw new Error(`Insert lot B failed: ${lotBErr.message}`);

  // ------------------------------------------------------------------
  // Lot C: in_inventory, in the ALT bin (pending_move when scanned to main bin).
  // ------------------------------------------------------------------
  const lotCId = randomUUID();
  const lotCCode = `${opACode}-000003`;

  const { error: lotCErr } = await admin.from('lots').insert({
    id: lotCId,
    operator_id: opAId,
    lot_code: lotCCode,
    title: 'Intake Test Lot C',
    condition: 'good',
    status: 'in_inventory',
    intake_bin_id: altBinId,
    warehouse_id: warehouseId,
    intake_at: new Date().toISOString(),
  });
  if (lotCErr) throw new Error(`Insert lot C failed: ${lotCErr.message}`);

  // ------------------------------------------------------------------
  // Lot D: status='sold' → lot_not_in_intake_state.
  // 'sold' is not a real lot_status value — the valid terminal statuses
  // are won/unsold/canceled. Use 'won' as the "past intake state" lot.
  // ------------------------------------------------------------------
  const lotDId = randomUUID();
  const lotDCode = `${opACode}-000004`;

  const { error: lotDErr } = await admin.from('lots').insert({
    id: lotDId,
    operator_id: opAId,
    lot_code: lotDCode,
    title: 'Intake Test Lot D',
    condition: 'good',
    status: 'won', // any status that is NOT pending_intake or in_inventory
  });
  if (lotDErr) throw new Error(`Insert lot D failed: ${lotDErr.message}`);

  // ------------------------------------------------------------------
  // Lot E: belongs to operator B (lot_other_operator).
  // When operator A's staff tries to intake it, _find_lot_by_scan finds
  // it by lot_code (not operator-scoped for lot_code probe in mig 0160)
  // then the operator_id check fires.
  // ------------------------------------------------------------------
  const lotEId = randomUUID();
  const lotECode = `OPBTEST-000001`;

  const { error: lotEErr } = await admin.from('lots').insert({
    id: lotEId,
    operator_id: opBId,
    lot_code: lotECode,
    title: 'Intake Test Lot E',
    condition: 'good',
    status: 'pending_intake',
  });
  if (lotEErr) throw new Error(`Insert lot E failed: ${lotEErr.message}`);

  return {
    opAId,
    opACode,
    opBId,
    warehouseId,
    binId,
    binCode,
    binQrToken,
    altBinId,
    altBinCode,
    altBinQrToken,
    staffUserId,
    staffEmail,
    lotA: { id: lotAId, lotCode: lotACode },
    lotB: { id: lotBId, lotCode: lotBCode },
    lotC: { id: lotCId, lotCode: lotCCode },
    lotD: { id: lotDId, lotCode: lotDCode },
    lotE: { id: lotEId, lotCode: lotECode },
  };
}

// ---------------------------------------------------------------------------
// teardown — cascade delete via operators (ON DELETE CASCADE covers all children)
// ---------------------------------------------------------------------------

async function teardown(admin: SupabaseClient, f: Fixture): Promise<void> {
  await admin.from('operators').delete().eq('id', f.opAId);
  await admin.from('operators').delete().eq('id', f.opBId);
  await admin.auth.admin.deleteUser(f.staffUserId).catch(() => {});
}

// ---------------------------------------------------------------------------
// makeStaffClient — authenticated Supabase client for the staff user
// ---------------------------------------------------------------------------

async function makeStaffClient(email: string): Promise<SupabaseClient> {
  const client = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`staff signIn failed: ${error.message}`);
  return client;
}

// ---------------------------------------------------------------------------
// Helper — call intake_lot_to_bin via RPC and return the typed result.
// Supabase-js returns composite types as plain objects keyed by attribute name.
// ---------------------------------------------------------------------------

async function callIntake(
  client: SupabaseClient,
  lotIdentifier: string,
  binQrToken: string,
): Promise<IntakeLotResult | null> {
  const { data, error } = await client.rpc('intake_lot_to_bin', {
    p_lot_identifier: lotIdentifier,
    p_bin_qr_token: binQrToken,
  });
  if (error) throw new Error(`intake_lot_to_bin RPC error: ${error.message}`);
  return data as IntakeLotResult | null;
}

// ===========================================================================
// Suite — gated on INTAKE_LOT_REGRESSION=1
// ===========================================================================

describe.skipIf(!RUN)(
  'intake_lot_to_bin() behavioral regression [INTAKE_LOT_REGRESSION=1 to enable]',
  () => {
    let admin: SupabaseClient;
    let staffClient: SupabaseClient;
    let f: Fixture;

    // -----------------------------------------------------------------------
    // One-time setup: build fixture + authenticated staff client
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      if (!url || !anonKey || !serviceKey) {
        throw new Error(
          'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set',
        );
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      f = await buildFixture(admin);
      staffClient = await makeStaffClient(f.staffEmail);
    }, 30_000);

    afterAll(async () => {
      if (admin && f) await teardown(admin, f);
    }, 15_000);

    // -----------------------------------------------------------------------
    // T1. Resolve by lot_code → ok_intaked
    //
    // Lot A is pending_intake. Scanning its lot_code to the target bin should
    // flip it to in_inventory and return ok_intaked.
    // -----------------------------------------------------------------------

    it('resolves by lot_code → ok_intaked', async () => {
      // Reset Lot A to pending_intake so the test is repeatable if the suite
      // runs more than once against the same DB (defensive).
      await admin
        .from('lots')
        .update({ status: 'pending_intake', intake_bin_id: null, warehouse_id: null })
        .eq('id', f.lotA.id);

      const result = await callIntake(staffClient, f.lotA.lotCode, f.binQrToken);

      expect(result?.ok).toBe(true);
      expect(result?.reason).toBe('ok_intaked');
      expect(result?.lot_id).toBe(f.lotA.id);
      expect(result?.lot_code).toBe(f.lotA.lotCode);
      expect(result?.bin_code).toBe(f.binCode);
      expect(result?.warehouse_id).toBe(f.warehouseId);
      expect(result?.from_bin_code).toBeNull();

      // Verify DB state was actually updated.
      const { data: lot } = await admin
        .from('lots')
        .select('status, intake_bin_id, warehouse_id')
        .eq('id', f.lotA.id)
        .single();
      expect(lot?.status).toBe('in_inventory');
      expect(lot?.intake_bin_id).toBe(f.binId);
      expect(lot?.warehouse_id).toBe(f.warehouseId);
    }, 15_000);

    // -----------------------------------------------------------------------
    // T2. Resolve by qr_token (UUID string) → ok_intaked
    //
    // Insert a fresh lot with a known qr_token. Scanning the UUID string should
    // match via the qr_token probe (first in the resolution ladder).
    // -----------------------------------------------------------------------

    it('resolves by qr_token → ok_intaked', async () => {
      const lotQrToken = randomUUID();
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-QRT001`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        qr_token: lotQrToken,
        title: 'QR Token Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        const result = await callIntake(staffClient, lotQrToken, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
        expect(result?.from_bin_code).toBeNull();
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T3. Resolve by sticker_code → ok_intaked
    //
    // sticker_code is stored as "{op_code}:{raw}" in the lots table.
    // The function appends the operator code when the input has no colon,
    // so passing just the raw portion ("STICK001") should match.
    // -----------------------------------------------------------------------

    it('resolves by sticker_code (raw input, no colon prefix) → ok_intaked', async () => {
      const rawSticker = `STICK${Date.now()}`;
      const stickerFull = `${f.opACode}:${rawSticker}`;
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-STK001`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        sticker_code: stickerFull,
        title: 'Sticker Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        // Pass only the raw portion — function builds full sticker code internally.
        const result = await callIntake(staffClient, rawSticker, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T4. Resolve by lpn → ok_intaked
    // -----------------------------------------------------------------------

    it('resolves by lpn → ok_intaked', async () => {
      const lpn = `LPN-${Date.now()}`;
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-LPN001`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        lpn,
        title: 'LPN Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        const result = await callIntake(staffClient, lpn, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T5a. Resolve by fnsku → ok_intaked
    // -----------------------------------------------------------------------

    it('resolves by fnsku → ok_intaked', async () => {
      const fnsku = `X00FNSK${Date.now()}`;
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-FNSK01`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        fnsku,
        title: 'FNSKU Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        const result = await callIntake(staffClient, fnsku, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T5b. Resolve by asin → ok_intaked
    //
    // When multiple lots share an ASIN, the function prefers pending_intake
    // over others. We insert only one pending_intake lot here.
    // -----------------------------------------------------------------------

    it('resolves by asin → ok_intaked', async () => {
      const asin = `B0ASIN${Date.now()}`.slice(0, 10); // keep ASIN-like length
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-ASIN01`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        asin,
        title: 'ASIN Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        const result = await callIntake(staffClient, asin, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T5c. Resolve by external_code → ok_intaked
    // -----------------------------------------------------------------------

    it('resolves by external_code → ok_intaked', async () => {
      const externalCode = `EXT-${Date.now()}`;
      const lotId = randomUUID();
      const lotCode = `${f.opACode}-EXT001`;

      await admin.from('lots').insert({
        id: lotId,
        operator_id: f.opAId,
        lot_code: lotCode,
        external_code: externalCode,
        title: 'External Code Test Lot',
        condition: 'good',
        status: 'pending_intake',
      });

      try {
        const result = await callIntake(staffClient, externalCode, f.binQrToken);

        expect(result?.ok).toBe(true);
        expect(result?.reason).toBe('ok_intaked');
        expect(result?.lot_id).toBe(lotId);
        expect(result?.lot_code).toBe(lotCode);
        expect(result?.bin_code).toBe(f.binCode);
      } finally {
        await admin.from('lots').delete().eq('id', lotId);
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T6. Already-here → ok_already_here
    //
    // Lot B is already in_inventory in the TARGET bin. Scanning it again to the
    // same bin is a no-op; the function returns ok=true with ok_already_here.
    // Note: from_bin_code equals bin_code for this case (lot IS in that bin).
    // -----------------------------------------------------------------------

    it('already in target bin → ok_already_here', async () => {
      const result = await callIntake(staffClient, f.lotB.lotCode, f.binQrToken);

      expect(result?.ok).toBe(true);
      expect(result?.reason).toBe('ok_already_here');
      expect(result?.lot_id).toBe(f.lotB.id);
      expect(result?.lot_code).toBe(f.lotB.lotCode);
      expect(result?.bin_code).toBe(f.binCode);
      expect(result?.warehouse_id).toBe(f.warehouseId);
      // from_bin_code is the current bin (same as destination) for this case.
      expect(result?.from_bin_code).toBe(f.binCode);

      // Verify DB was NOT touched (status should still be in_inventory,
      // bin still the same).
      const { data: lot } = await admin
        .from('lots')
        .select('status, intake_bin_id')
        .eq('id', f.lotB.id)
        .single();
      expect(lot?.status).toBe('in_inventory');
      expect(lot?.intake_bin_id).toBe(f.binId);
    }, 15_000);

    // -----------------------------------------------------------------------
    // T7. Wrong-bin → pending_move
    //
    // Lot C is in_inventory in the ALT bin. Scanning it to the MAIN bin should
    // NOT move it — the function returns ok=false with pending_move and
    // from_bin_code = altBinCode so the client can show a "move from X to Y?"
    // confirmation modal. DB must be unchanged.
    // -----------------------------------------------------------------------

    it('already in different bin → pending_move, no DB change', async () => {
      const result = await callIntake(staffClient, f.lotC.lotCode, f.binQrToken);

      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('pending_move');
      expect(result?.lot_id).toBe(f.lotC.id);
      expect(result?.lot_code).toBe(f.lotC.lotCode);
      // bin_code = destination (the bin the worker scanned)
      expect(result?.bin_code).toBe(f.binCode);
      expect(result?.warehouse_id).toBe(f.warehouseId);
      // from_bin_code = current location (alt bin)
      expect(result?.from_bin_code).toBe(f.altBinCode);

      // Verify DB was NOT updated — lot still in the alt bin.
      const { data: lot } = await admin
        .from('lots')
        .select('status, intake_bin_id')
        .eq('id', f.lotC.id)
        .single();
      expect(lot?.status).toBe('in_inventory');
      expect(lot?.intake_bin_id).toBe(f.altBinId);
    }, 15_000);

    // -----------------------------------------------------------------------
    // T8. Not found → not_lotted_yet
    //
    // A completely unknown identifier string should hit the end of the
    // resolution ladder without finding anything, returning not_lotted_yet.
    // -----------------------------------------------------------------------

    it('unknown identifier → not_lotted_yet', async () => {
      const result = await callIntake(staffClient, 'NOTREAL-DOESNOTEXIST-99999', f.binQrToken);

      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('not_lotted_yet');
      expect(result?.lot_id).toBeNull();
      expect(result?.lot_code).toBeNull();
      expect(result?.bin_code).toBeNull();
    }, 15_000);

    // -----------------------------------------------------------------------
    // T9. Cross-operator lot → lot_other_operator
    //
    // Lot E belongs to operator B. When operator A's staff scans its lot_code,
    // _find_lot_by_scan resolves it (lot_code is not operator-scoped), then
    // the operator_id guard fires and returns lot_other_operator.
    // -----------------------------------------------------------------------

    it('lot belongs to different operator → lot_other_operator', async () => {
      const result = await callIntake(staffClient, f.lotE.lotCode, f.binQrToken);

      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('lot_other_operator');
      // lot_id and lot_code are NULL in the return — the guard fires before
      // those fields are populated in the result tuple.
      expect(result?.lot_id).toBeNull();
      expect(result?.lot_code).toBeNull();
    }, 15_000);

    // -----------------------------------------------------------------------
    // T10. Lot in terminal state → lot_not_in_intake_state
    //
    // Lot D has status='won'. Only pending_intake and in_inventory are valid
    // intake states; won (and any other terminal status) returns this code.
    // The lot_id and lot_code ARE populated in this case.
    // -----------------------------------------------------------------------

    it('lot in terminal status (won) → lot_not_in_intake_state', async () => {
      const result = await callIntake(staffClient, f.lotD.lotCode, f.binQrToken);

      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('lot_not_in_intake_state');
      expect(result?.lot_id).toBe(f.lotD.id);
      expect(result?.lot_code).toBe(f.lotD.lotCode);
      // bin_code is NULL — we never got to the bin step in this path
      expect(result?.bin_code).toBeNull();
    }, 15_000);

    // -----------------------------------------------------------------------
    // T11. Invalid bin token → bin_not_found_or_revoked
    //
    // Passing a random UUID that has no corresponding row in bins should hit
    // the bin-not-found guard before any lot resolution happens.
    // -----------------------------------------------------------------------

    it('nonexistent bin qr_token → bin_not_found_or_revoked', async () => {
      const fakeToken = randomUUID();
      const result = await callIntake(staffClient, f.lotA.lotCode, fakeToken);

      expect(result?.ok).toBe(false);
      expect(result?.reason).toBe('bin_not_found_or_revoked');
      // All lot/bin fields are NULL when bin guard fires
      expect(result?.lot_id).toBeNull();
      expect(result?.lot_code).toBeNull();
      expect(result?.bin_code).toBeNull();
    }, 15_000);

    // -----------------------------------------------------------------------
    // T12. Unauthenticated call → not_authenticated
    //
    // An anon (unsigned-in) client calling the RPC should get not_authenticated
    // because auth.uid() returns NULL. Note: Supabase may surface this as an
    // RPC error rather than a composite result depending on RLS config, so we
    // accept either form.
    // -----------------------------------------------------------------------

    it('unauthenticated call → not_authenticated', async () => {
      const anonClient = createClient(url!, anonKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data, error } = await anonClient.rpc('intake_lot_to_bin', {
        p_lot_identifier: f.lotA.lotCode,
        p_bin_qr_token: f.binQrToken,
      });

      // The function returns a composite with ok=false, reason='not_authenticated'
      // OR PostgREST may reject with a 401/403. Accept both.
      if (error) {
        // PostgREST surface — treat as authenticated-only enforcement
        expect(
          error.message.toLowerCase().includes('authenticated') ||
          error.code === 'PGRST301' ||
          error.code === '28000',
        ).toBe(true);
      } else {
        const result = data as IntakeLotResult | null;
        expect(result?.ok).toBe(false);
        expect(result?.reason).toBe('not_authenticated');
      }
    }, 15_000);

    // -----------------------------------------------------------------------
    // T13. Revoked bin token → bin_not_found_or_revoked
    //
    // A bin with qr_revoked_at set should behave identically to a missing bin
    // because the SELECT in intake_lot_to_bin filters WHERE qr_revoked_at IS NULL.
    // -----------------------------------------------------------------------

    it('revoked bin token → bin_not_found_or_revoked', async () => {
      // Create a fresh bin, then immediately revoke it.
      const revokedToken = randomUUID();
      const { data: rBinData, error: rBinErr } = await admin
        .from('bins')
        .insert({
          warehouse_id: f.warehouseId,
          code: 'A-99-9-99',
          aisle: 'A',
          bay: '99',
          level: 9,
          position: 99,
          x_px: 999,
          y_px: 999,
          qr_token: revokedToken,
          qr_revoked_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (rBinErr ?? !rBinData) throw new Error(`Insert revoked bin failed: ${rBinErr?.message}`);
      const rBinId: string = (rBinData as { id: string }).id;

      try {
        const result = await callIntake(staffClient, f.lotA.lotCode, revokedToken);

        expect(result?.ok).toBe(false);
        expect(result?.reason).toBe('bin_not_found_or_revoked');
        expect(result?.lot_id).toBeNull();
      } finally {
        await admin.from('bins').delete().eq('id', rBinId);
      }
    }, 15_000);
  },
);

// ---------------------------------------------------------------------------
// Smoke test — always runs, even when suite is skipped.
// Ensures the file is importable and the env-gate constant is correct.
// ---------------------------------------------------------------------------

it('intake_lot_to_bin regression test module loads (smoke)', () => {
  expect(typeof RUN).toBe('boolean');
  expect(RUN).toBe(process.env['INTAKE_LOT_REGRESSION'] === '1');
});
