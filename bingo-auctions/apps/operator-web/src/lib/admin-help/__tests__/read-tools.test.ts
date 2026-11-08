import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  chicagoRange,
  hasStaffAppHeaders,
  isAdminHelpEnabled,
  runAdminHelpTool,
  stripIdentities,
  SYNTHETIC_MODEL_PAYLOAD,
  type Chain,
  type ReadResult,
  type ScopedReadClient,
} from '../read-tools';

const NOW = new Date('2026-11-03T18:00:00Z');
const OP = '00000000-0000-0000-0000-0000000000aa';
const miss = (c: string): ReadResult => ({
  data: null,
  error: { code: '42703', message: `${c} does not exist` },
});
const boom: ReadResult = { data: null, error: { code: '08006', message: 'fetch failed' } };
const rows = [
  {
    status: 'active',
    created_at: '2026-11-03T12:00:00.000Z',
    email: 'fixture-buyer@example.test',
  },
  { status: 'trialing', created_at: '2026-10-01T12:00:00.000Z' },
];

function client(script: Record<string, ReadResult[]>): ScopedReadClient {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const next = (): ReadResult => {
        const list = script[table] ?? [];
        return list.length > 1 ? list.shift()! : (list[0] ?? { data: [], error: null });
      };
      for (const k of ['select', 'eq', 'gte', 'lt', 'limit']) q[k] = () => q;
      q.maybeSingle = () => Promise.resolve(next());
      q.then = (ok: (v: ReadResult) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(next()).then(ok, bad);
      return q as unknown as Chain;
    },
  };
}

const run = (tool: string, script: Record<string, ReadResult[]>) =>
  runAdminHelpTool({ operatorId: OP, client: client(script) }, tool, { range: 'today', now: NOW });

const state = vi.hoisted(() => ({
  user: { id: '00000000-0000-0000-0000-0000000000cc' } as { id: string } | null,
  staff: { operator_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin' },
  tables: {} as Record<string, ReadResult[]>,
  fromCalls: 0,
}));

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from(table: string) {
      state.fromCalls += 1;
      return client(state.tables).from(table);
    },
  }),
}));

import { POST } from '../../../app/api/admin-help/tools/route';

const req = (body: unknown, headers?: Record<string, string>) =>
  new Request('https://bingoauctions.com/api/admin-help/tools', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

describe('Admin Help read tools', () => {
  it('covers flag, entitlements, tools, and route gates', async () => {
    expect(isAdminHelpEnabled({})).toBe(false);
    expect(isAdminHelpEnabled({ ADMIN_HELP_ENABLED: 'true' })).toBe(true);
    expect(hasStaffAppHeaders(new Headers({ authorization: 'Bearer x' }))).toBe(true);
    const today = chicagoRange('today', NOW);
    expect('error' in today ? '' : today.from.toISOString()).toBe('2026-11-03T06:00:00.000Z');
    expect(stripIdentities({ n: 1, email: 'fixture-buyer@example.test' })).toEqual({ n: 1 });

    const enabled = await run('subscriptions', {
      bidder_subscriptions: [{ data: rows, error: null }],
      invoices: [miss('revenue_source')],
    });
    expect(enabled).toMatchObject({
      ok: true,
      data: {
        by_status: { none: 0, trialing: 1, active: 1, past_due: 0, canceled: 0 },
        created_in_range: 1,
        revenue_by_source_cents: { unavailable: true, reason: 'schema_missing' },
      },
    });
    expect(JSON.stringify(enabled)).not.toContain('@');
    expect(
      await run('subscriptions', {
        bidder_subscriptions: [{ data: null, error: { code: '42501' } }],
      }),
    ).toEqual({ ok: false, error: 'denied' });
    const missing = await run('subscriptions', {
      bidder_subscriptions: [{ data: null, error: { code: '42P01', message: 'does not exist' } }],
    });
    expect(missing.ok && missing.data.by_status).toMatchObject({ reason: 'schema_missing' });
    expect(
      await run('subscriptions', {
        bidder_subscriptions: [boom, { data: rows, error: null }],
        invoices: [miss('revenue_source')],
      }),
    ).toMatchObject({ ok: true });
    expect(await run('subscriptions', { bidder_subscriptions: [boom, boom] })).toEqual({
      ok: false,
      error: 'retry_exhausted',
    });

    const bal = await run('balances', { bidder_credits: [miss('bucket')] });
    expect(bal.ok && bal.data).toMatchObject({
      wallet_cash_cents: { reason: 'schema_missing' },
      store_credit_cents: { reason: 'operator_read_unavailable' },
    });
    expect(JSON.stringify(bal)).not.toMatch(/_cents":\d/);
    expect(
      JSON.stringify(await run('balances', { bidder_credits: [{ data: [], error: null }] })),
    ).not.toMatch(/_cents":\d/);
    expect(
      await run('balances', { bidder_credits: [{ data: null, error: { code: '42501' } }] }),
    ).toEqual({ ok: false, error: 'denied' });
    expect(await run('balances', { bidder_credits: [boom, boom] })).toEqual({
      ok: false,
      error: 'retry_exhausted',
    });
  });
});

describe('POST /api/admin-help/tools', () => {
  afterEach(() => delete process.env.ADMIN_HELP_ENABLED);

  it('disabled, enabled, denied, retry, dependency-missing', async () => {
    state.user = { id: '00000000-0000-0000-0000-0000000000cc' };
    state.staff = { operator_id: OP, role: 'admin' };
    state.fromCalls = 0;
    state.tables = {
      operator_users: [{ data: state.staff, error: null }],
      bidder_subscriptions: [{ data: rows, error: null }],
      invoices: [miss('revenue_source')],
      bidder_credits: [miss('bucket')],
    };
    delete process.env.ADMIN_HELP_ENABLED;
    expect((await POST(req({ tool: 'subscriptions' }))).status).toBe(404);
    expect(state.fromCalls).toBe(0);
    process.env.ADMIN_HELP_ENABLED = 'true';
    const res = await POST(req({ tool: 'subscriptions', range: 'today' }));
    expect(res.status).toBe(200);
    expect((await res.json()).model_payload).toEqual(SYNTHETIC_MODEL_PAYLOAD);
    expect((await POST(req({ tool: 'subscriptions' }, { authorization: 'Bearer x' }))).status).toBe(
      403,
    );
    state.tables.operator_users = [{ data: { operator_id: OP, role: 'manager' }, error: null }];
    expect((await POST(req({ tool: 'subscriptions' }))).status).toBe(403);
    state.tables.operator_users = [{ data: state.staff, error: null }];
    state.tables.bidder_subscriptions = [boom, boom];
    expect((await POST(req({ tool: 'subscriptions', range: 'today' }))).status).toBe(503);
    const missing = await (await POST(req({ tool: 'balances', range: 'today' }))).json();
    expect(missing.result.wallet_cash_cents.reason).toBe('schema_missing');
    const src =
      readFileSync(resolve(__dirname, '../read-tools.ts'), 'utf8') +
      readFileSync(resolve(__dirname, '../../../app/api/admin-help/tools/route.ts'), 'utf8');
    expect(src).not.toMatch(/supabase-admin|getSupabaseAdmin|SERVICE_ROLE/);
  });
});
