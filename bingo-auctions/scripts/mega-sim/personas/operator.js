// scripts/mega-sim/personas/operator.js
//
// Persona: operator admin doing initial setup. Creates a SIM operator
// with predictable code prefix, a warehouse, three bins, and two staff
// users (admin + picker). All writes use service-role to bypass RLS —
// real-world ops setup goes through the operator console, but this is
// the "fixture seed" phase, not a permission test.
//
// Returns the populated context the rest of the personas consume.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function setup({ operatorPrefix }) {
  setPhase('Operator setup');

  const ts = Date.now().toString().slice(-8);
  const slug = ('sim-' + operatorPrefix + '-' + ts).toLowerCase();
  const code = (operatorPrefix + ts.slice(-3)).toUpperCase().slice(0, 8);
  const adminEmail = 'sim-admin-' + ts + '@example.com';
  const pickerEmail = 'sim-picker-' + ts + '@example.com';
  const password = 'SimPass!' + ts + 'xyz';

  const ctx = {
    operatorId: null,
    operatorCode: code,
    operatorSlug: slug,
    warehouseId: null,
    bins: [],
    adminUserId: null,
    pickerUserId: null,
    adminToken: null,
    pickerToken: null,
    adminEmail,
    pickerEmail,
    password,
  };

  // ── Mint operator ────────────────────────────────────────────────────
  // stripe_onboarding_complete + stripe_onboarding_skipped: per migration
  // 0035, this combo lets the operator reach every code path (auction
  // builder, scheduling, lot assignment) without a real Stripe account.
  // Phase 2A doesn't touch payment, so we don't need stripe_account_id;
  // Phase 2B (settlement) will need a real Stripe Connect account.
  await step('create SIM operator (service-role) with stripe-skip flags', async () => {
    const { value } = await time('supa.insert.operators', () =>
      supa.supaInsert(
        null,
        'operators',
        {
          slug,
          code,
          business_name: 'Sim Test ' + code,
          contact_email: adminEmail,
          status: 'active',
          stripe_onboarding_complete: true,
          stripe_onboarding_skipped: true,
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.id).toBeTruthy('operator created');
    ctx.operatorId = value.data.id;
  });

  // ── Mint admin user + operator_users join ──────────────────────────
  await step('create admin auth user + operator_users join', async () => {
    const { value: authUser } = await time('supa.admin.createUser.admin', () =>
      supa.adminCreateUser({
        email: adminEmail,
        password,
        userMetadata: { sim: true, role: 'admin' },
      }),
    );
    ctx.adminUserId = authUser.userId;

    const { value: ouRes } = await time('supa.insert.operator_users.admin', () =>
      supa.supaInsert(
        null,
        'operator_users',
        {
          operator_id: ctx.operatorId,
          user_id: ctx.adminUserId,
          role: 'admin',
          email: adminEmail,
          display_name: 'Sim Admin',
        },
        true,
      ),
    );
    expect(ouRes.error).toBeNull();
  });

  await step('sign admin in to get a real JWT', async () => {
    const { value } = await time('supa.signIn.admin', () =>
      supa.signInWithPassword(adminEmail, password),
    );
    expect(value.token).toBeTruthy('admin token');
    ctx.adminToken = value.token;
  });

  // ── Mint picker user ─────────────────────────────────────────────────
  await step('create picker auth user + operator_users join', async () => {
    const { value: authUser } = await time('supa.admin.createUser.picker', () =>
      supa.adminCreateUser({
        email: pickerEmail,
        password,
        userMetadata: { sim: true, role: 'picker' },
      }),
    );
    ctx.pickerUserId = authUser.userId;

    const { value: ouRes } = await time('supa.insert.operator_users.picker', () =>
      supa.supaInsert(
        null,
        'operator_users',
        {
          operator_id: ctx.operatorId,
          user_id: ctx.pickerUserId,
          role: 'picker',
          email: pickerEmail,
          display_name: 'Sim Picker',
        },
        true,
      ),
    );
    expect(ouRes.error).toBeNull();
  });

  await step('sign picker in to get a real JWT', async () => {
    const { value } = await time('supa.signIn.picker', () =>
      supa.signInWithPassword(pickerEmail, password),
    );
    expect(value.token).toBeTruthy('picker token');
    ctx.pickerToken = value.token;
  });

  // ── Mint warehouse ───────────────────────────────────────────────────
  await step('create warehouse', async () => {
    const { value } = await time('supa.insert.warehouses', () =>
      supa.supaInsert(
        null,
        'warehouses',
        {
          operator_id: ctx.operatorId,
          name: 'Sim Warehouse',
          address_line1: '1 Sim Way',
          city: 'Simtown',
          state: 'OH',
          postal_code: '45000',
          country: 'US',
          timezone: 'America/New_York',
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.id).toBeTruthy('warehouse created');
    ctx.warehouseId = value.data.id;
  });

  // ── Mint 3 bins ──────────────────────────────────────────────────────
  await step('create 3 bins', async () => {
    const binRows = [
      { code: 'SIM-A-01', aisle: 'A', x_px: 100, y_px: 100 },
      { code: 'SIM-A-02', aisle: 'A', x_px: 100, y_px: 150 },
      { code: 'SIM-B-01', aisle: 'B', x_px: 200, y_px: 100 },
    ].map((r) => ({ ...r, warehouse_id: ctx.warehouseId, is_active: true }));

    const { value } = await time('supa.insert.bins.x3', () =>
      supa.supaInsertMany(null, 'bins', binRows, true),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(3);
    ctx.bins = value.data; // each has id, code, qr_token
  });

  // ── Sanity: admin can SELECT own operator ──────────────────────────
  await step('admin can SELECT own operator (RLS smoke)', async () => {
    const { value } = await time('supa.select.operators.adminToken', () =>
      supa.supaSelect(
        ctx.adminToken,
        'operators',
        'id=eq.' + ctx.operatorId,
        'id,code,slug',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    expect(value.data[0].code).toBe(code);
  });

  // ── Sanity: picker can SELECT own bins ──────────────────────────────
  await step('picker can SELECT bins via RLS', async () => {
    const { value } = await time('supa.select.bins.pickerToken', () =>
      supa.supaSelect(
        ctx.pickerToken,
        'bins',
        'warehouse_id=eq.' + ctx.warehouseId,
        'id,code,qr_token',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(3);
  });

  return ctx;
}

module.exports = { setup };
