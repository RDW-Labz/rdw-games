// Quota saver (2026-10-23): past 90% of the Resend cap, only win / payment /
// pickup email goes out; the rest is marked skipped ('quota_saver').
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  sentCount: 0 as number | null,
  countError: null as { message: string } | null,
  sends: [] as string[],
  updates: [] as Array<{ patch: Record<string, unknown>; ids: string[] }>,
  countCalls: 0,
}));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let head = false;
  let pendingUpdate: Record<string, unknown> | null = null;
  const chain = () => b;
  b.select = (_c: string, opts?: { head?: boolean }) => {
    head = Boolean(opts?.head);
    if (head) state.countCalls++;
    return b;
  };
  for (const m of ['is', 'lt', 'gte', 'order', 'limit']) b[m] = chain;
  b.returns = async () => ({ data: state.rows });
  b.update = (patch: Record<string, unknown>) => {
    pendingUpdate = patch;
    return b;
  };
  b.in = (_c: string, ids: string[]) => {
    if (pendingUpdate) {
      state.updates.push({ patch: pendingUpdate, ids });
      return Promise.resolve({ error: null });
    }
    if (table === 'bidders') {
      return Promise.resolve({ data: ids.map((id) => ({ id, email: `${id}@example.test`, email_enabled: true, referral_code: null })) });
    }
    return Promise.resolve({ data: [] });
  };
  b.eq = (_c: string, id: string) => {
    if (pendingUpdate) state.updates.push({ patch: pendingUpdate, ids: [id] });
    return Promise.resolve({ error: null });
  };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(head ? { count: state.sentCount, error: state.countError } : { data: [] }).then(res, rej);
  return b;
}

vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/notification-offsite-load', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadOffsiteNotificationCopyByInvoiceId: async () => new Map(),
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (m: { to: string }) => {
        state.sends.push(m.to);
        return { error: null };
      },
    };
  },
}));

import { runEmailDrain } from '../email-drain';

const row = (id: string, kind: string) => ({
  id,
  kind,
  target_user_id: `u-${id}`,
  email_attempt_count: 0,
  payload: { lot_id: null, amount_cents: 500, lot_title: 'Chair', auction_title: 'A' },
});

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.RESEND_MONTHLY_CAP;
  state.rows = [row('1', 'outbid'), row('2', 'won'), row('3', 'saved_search_hit')];
  state.sentCount = 0;
  state.countError = null;
  state.sends = [];
  state.updates = [];
  state.countCalls = 0;
});

const skippedWith = (reason: string) =>
  state.updates.filter((u) => u.patch['last_email_error'] === reason).flatMap((u) => u.ids);

describe('email drain quota saver', () => {
  it('2026-10-23 numbers (57,773 of 60,800): sends the win, skips outbid and saved search', async () => {
    state.sentCount = 57_773;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runEmailDrain();
    warn.mockRestore();
    expect(state.sends).toEqual(['u-2@example.test']);
    expect(skippedWith('quota_saver').sort()).toEqual(['1', '3']);
    expect(r.sent).toBe(1);
  });

  it('under 90%: sends everything', async () => {
    state.sentCount = 40_000;
    await runEmailDrain();
    expect(state.sends).toContain('u-1@example.test'); // outbid
    expect(state.sends).toContain('u-2@example.test'); // won
    expect(skippedWith('quota_saver')).toEqual([]);
  });

  it('a raised cap from env turns the saver off again', async () => {
    state.sentCount = 57_773;
    process.env.RESEND_MONTHLY_CAP = '100000';
    await runEmailDrain();
    expect(skippedWith('quota_saver')).toEqual([]);
  });

  it('count fails: sends normally (fail open)', async () => {
    state.sentCount = null;
    state.countError = { message: 'timeout' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runEmailDrain();
    warn.mockRestore();
    expect(skippedWith('quota_saver')).toEqual([]);
  });

  it('an all-essential batch never runs the count', async () => {
    state.rows = [row('2', 'won'), row('4', 'payment_succeeded')];
    state.sentCount = 60_000;
    await runEmailDrain();
    expect(state.countCalls).toBe(0);
    expect(skippedWith('quota_saver')).toEqual([]);
  });
});
