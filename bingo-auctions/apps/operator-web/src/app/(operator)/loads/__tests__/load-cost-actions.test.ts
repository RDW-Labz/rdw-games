import { describe, it, expect, vi, beforeEach } from 'vitest';

const LOAD_ID = '00000000-0000-0000-0000-0000000000aa';
const OP_ID = '00000000-0000-0000-0000-0000000000bb';
const USER_ID = '00000000-0000-0000-0000-0000000000cc';

const state = vi.hoisted(() => ({
  user: { id: '00000000-0000-0000-0000-0000000000cc' } as { id: string } | null,
  staff: {
    operator_id: '00000000-0000-0000-0000-0000000000bb',
    role: 'admin',
  } as { operator_id: string; role: string } | null,
  loadRow: {
    purchase_cost_cents: null as number | null,
    purchase_date: '2026-01-15' as string | null,
  },
  loadFound: true,
  updatePayload: null as Record<string, unknown> | null,
  updateEq: [] as Array<[string, string]>,
  updateRowCount: 1,
  auditRows: [] as unknown[],
  auditError: null as { message: string } | null,
  userFromTables: [] as string[],
  adminFromTables: [] as string[],
}));

function loadsBuilder() {
  let mode: 'read' | 'update' = 'read';
  const b: Record<string, unknown> = {};

  b.select = (cols?: string) => {
    if (mode === 'update' && cols === 'id') {
      return Promise.resolve({
        data: state.updateRowCount > 0 ? [{ id: LOAD_ID }] : [],
        error: null,
      });
    }
    return b;
  };
  b.eq = (col: string, val: string) => {
    if (mode === 'update') state.updateEq.push([col, val]);
    return b;
  };
  b.maybeSingle = async () => {
    if (!state.loadFound) return { data: null, error: null };
    return { data: state.loadRow, error: null };
  };
  b.update = (payload: Record<string, unknown>) => {
    mode = 'update';
    state.updatePayload = payload;
    state.updateEq = [];
    return b;
  };

  return b;
}

function userClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
    from(table: string) {
      state.userFromTables.push(table);
      if (table === 'operator_users') {
        const ou: Record<string, unknown> = {};
        ou.select = () => ou;
        ou.eq = () => ou;
        ou.maybeSingle = async () => ({ data: state.staff, error: null });
        return ou;
      }
      if (table === 'loads') {
        return loadsBuilder();
      }
      throw new Error(`unexpected user table ${table}`);
    },
  };
}

function adminClient() {
  return {
    from(table: string) {
      state.adminFromTables.push(table);
      if (table === 'operator_audit_log') {
        return {
          insert: async (row: unknown) => {
            state.auditRows.push(row);
            return { error: state.auditError };
          },
        };
      }
      throw new Error(`unexpected admin table ${table}`);
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => userClient() }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => adminClient() }));

import { updateLoadCost } from '../actions';

beforeEach(() => {
  state.user = { id: USER_ID };
  state.staff = { operator_id: OP_ID, role: 'admin' };
  state.loadRow = { purchase_cost_cents: 100, purchase_date: '2026-01-15' };
  state.loadFound = true;
  state.updatePayload = null;
  state.updateEq = [];
  state.updateRowCount = 1;
  state.auditRows = [];
  state.auditError = null;
  state.userFromTables = [];
  state.adminFromTables = [];
});

describe('updateLoadCost', () => {
  it('admin sets cost with scoped update and audit before/after', async () => {
    state.loadRow = { purchase_cost_cents: 100, purchase_date: '2026-01-15' };
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: 123456 });
    expect(r).toEqual({ ok: true });
    expect(state.updatePayload).toEqual({ purchase_cost_cents: 123456 });
    expect(state.updateEq).toEqual([['id', LOAD_ID], ['operator_id', OP_ID]]);
    expect(state.auditRows).toHaveLength(1);
    expect(state.auditRows[0]).toMatchObject({
      operator_id: OP_ID,
      actor_user_id: USER_ID,
      action_type: 'load.cost_updated',
      target_id: LOAD_ID,
      before_state: { purchase_cost_cents: 100, purchase_date: '2026-01-15' },
      after_state: { purchase_cost_cents: 123456, purchase_date: '2026-01-15' },
    });
  });

  it('null clears the cost', async () => {
    state.loadRow = { purchase_cost_cents: 500, purchase_date: null };
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: null });
    expect(r).toEqual({ ok: true });
    expect(state.updatePayload).toEqual({ purchase_cost_cents: null });
  });

  it('refuses picker with no write and no audit', async () => {
    state.staff = { operator_id: OP_ID, role: 'picker' };
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: 100 });
    expect(r).toEqual({ ok: false, error: 'Only admins and managers can change load costs' });
    expect(state.updatePayload).toBeNull();
    expect(state.auditRows).toHaveLength(0);
  });

  it('refuses when not signed in', async () => {
    state.user = null;
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: 100 });
    expect(r).toEqual({ ok: false, error: 'Not signed in' });
    expect(state.updatePayload).toBeNull();
  });

  it('rejects invalid amounts and bad uuid without write', async () => {
    for (const input of [
      { loadId: LOAD_ID, costCents: -1 },
      { loadId: LOAD_ID, costCents: 1.5 },
      { loadId: LOAD_ID, costCents: 100_000_001 },
      { loadId: 'not-a-uuid', costCents: 100 },
    ] as const) {
      state.updatePayload = null;
      const r = await updateLoadCost(input);
      expect(r.ok).toBe(false);
      expect(state.updatePayload).toBeNull();
    }
  });

  it('returns Load not found when update touches zero rows', async () => {
    state.updateRowCount = 0;
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: 50 });
    expect(r).toEqual({ ok: false, error: 'Load not found' });
  });

  it('still returns ok when audit insert fails', async () => {
    state.auditError = { message: 'audit down' };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await updateLoadCost({ loadId: LOAD_ID, costCents: 200 });
    expect(r).toEqual({ ok: true });
    expect(errSpy).toHaveBeenCalledWith('[loads] audit insert failed', 'audit down');
    errSpy.mockRestore();
  });

  it('uses admin client only for operator_audit_log', async () => {
    await updateLoadCost({ loadId: LOAD_ID, costCents: 300 });
    expect(state.userFromTables).toContain('operator_users');
    expect(state.userFromTables).toContain('loads');
    expect(state.userFromTables).not.toContain('operator_audit_log');
    expect(state.adminFromTables).toEqual(['operator_audit_log']);
  });
});
