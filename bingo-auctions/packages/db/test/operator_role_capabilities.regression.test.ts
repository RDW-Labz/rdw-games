// operator_role_capabilities.regression.test.ts
//
// Locks the Staff Role Matrix seed (migration 0205). The live
// operator_role_capabilities table must match the EXPECTED matrix below
// exactly, and must stay monotonic (picker subset of lead subset of manager
// subset of admin). When Phase 2 wires operator_role_can() into real gates, an
// accidental seed change (e.g. giving 'picker' refund.in_window, or dropping
// 'admin' settings.edit) would silently shift who can touch money — this test
// makes that a red CI.
//
// =========================================================================
// Runtime: gated behind ROLE_MATRIX_REGRESSION=1. Needs the service-role key
// (reads the global reference table directly; no auth fixture required). The
// always-on smoke test below validates the expected matrix is internally
// monotonic without any DB.
//
//   supabase start
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<svc> \
//   ROLE_MATRIX_REGRESSION=1 npm run test --workspace=@auction-platform/db
// =========================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const RUN = process.env['ROLE_MATRIX_REGRESSION'] === '1';
const url = process.env['SUPABASE_URL'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

type Role = 'picker' | 'lead' | 'manager' | 'admin';

// Mirror of the 0205 seed — the authoritative "today" matrix. Each higher role
// inherits everything below it (monotonic).
const FLOOR_COUNTER = [
  'inventory.intake',
  'inventory.putaway',
  'inventory.lot',
  'pickup.verify',
  'pickup.sign',
  'pickup.manual_checkout',
  'checkout.take_payment',
];
const PICKER = [...FLOOR_COUNTER];
const LEAD = [...PICKER, 'refund.in_window'];
const MANAGER = [
  ...LEAD,
  'auction.publish',
  'auction.cancel',
  'inventory.dispose',
  'payment.mark_paid_offline',
  'audit.view',
];
const ADMIN = [
  ...MANAGER,
  'settings.edit',
  'policy.edit',
  'staff.manage',
  'payouts.manage',
  'refund.override',
];
const EXPECTED: Record<Role, string[]> = {
  picker: PICKER,
  lead: LEAD,
  manager: MANAGER,
  admin: ADMIN,
};

const ROLES: Role[] = ['picker', 'lead', 'manager', 'admin'];

describe.skipIf(!RUN)(
  'operator_role_capabilities seed [ROLE_MATRIX_REGRESSION=1 to enable]',
  () => {
    let admin: SupabaseClient;
    const live: Record<string, Set<string>> = {};

    beforeAll(async () => {
      if (!url || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await admin
        .from('operator_role_capabilities')
        .select('role, capability');
      if (error) throw new Error(`read matrix failed: ${error.message}`);
      for (const row of data as { role: string; capability: string }[]) {
        (live[row.role] ??= new Set()).add(row.capability);
      }
    });

    it.each(ROLES)('role %s grants exactly the expected capabilities', (role) => {
      const got = [...(live[role] ?? new Set<string>())].sort();
      expect(got).toEqual([...EXPECTED[role]].sort());
    });

    it('is monotonic: picker subset of lead subset of manager subset of admin (live data)', () => {
      const chain: Role[] = ['picker', 'lead', 'manager', 'admin'];
      for (let i = 1; i < chain.length; i++) {
        const lower = live[chain[i - 1]!] ?? new Set<string>();
        const higher = live[chain[i]!] ?? new Set<string>();
        for (const cap of lower) {
          expect(higher.has(cap), `${chain[i]} should inherit ${cap}`).toBe(true);
        }
      }
    });

    it('does NOT grant picker any money/admin capability', () => {
      const picker = live['picker'] ?? new Set<string>();
      for (const forbidden of [
        'refund.in_window',
        'refund.override',
        'auction.publish',
        'settings.edit',
        'staff.manage',
      ]) {
        expect(picker.has(forbidden), `picker must not have ${forbidden}`).toBe(false);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Smoke — always runs (no DB). Proves the expected matrix is itself monotonic
// so the gated assertions above can't be vacuously satisfied by a bad EXPECTED.
// ---------------------------------------------------------------------------
it('expected role matrix is internally monotonic (smoke)', () => {
  expect(new Set(LEAD)).toEqual(new Set([...PICKER, 'refund.in_window']));
  for (const cap of PICKER) expect(ADMIN).toContain(cap);
  expect(ADMIN).toContain('refund.override');
  expect(PICKER).not.toContain('refund.in_window');
});
