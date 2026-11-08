// Negative-case test for the 2026-09-16 removal of the 'refund_minus_restock'
// no-show policy option (WORKING_AGREEMENT §7c).
//
// Removing the <option> from PoliciesForm only stops the BROWSER offering the
// value. This asserts the server refuses it too: a hand-crafted POST carrying
// 'refund_minus_restock' must fail at inputSchema.safeParse and return before
// any Supabase client is constructed — i.e. before any read, and well before
// the operator_policies INSERT.
//
// Both Supabase factories are mocked to THROW. If validation ever stops
// short-circuiting, the action reaches them and the test fails loudly rather
// than silently passing on a changed error string.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock factories are lifted above normal const declarations,
// so the spies have to be created in the hoisted scope to be referenceable.
const { getSupabaseServer, getSupabaseAdmin } = vi.hoisted(() => ({
  getSupabaseServer: vi.fn(() => {
    throw new Error('getSupabaseServer called — validation did not short-circuit');
  }),
  getSupabaseAdmin: vi.fn(() => {
    throw new Error('getSupabaseAdmin called — validation did not short-circuit');
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin }));

import { saveDraft, publishPolicy } from '../actions';

// Every field the schema requires, all valid. Only no_show_policy varies.
function formWith(noShowPolicy: string): FormData {
  const fd = new FormData();
  const body = 'x'.repeat(40); // clears the min(20) on the markdown fields
  fd.set('terms_md', body);
  fd.set('refund_md', body);
  fd.set('shipping_md', body);
  fd.set('payment_window_hours', '48');
  fd.set('pickup_window_days', '6');
  fd.set('refund_window_post_pickup_hours', '24');
  fd.set('no_show_policy', noShowPolicy);
  fd.set('restock_fee_cents', '5');
  fd.set('relist_fee_cents', '5');
  fd.set('identity_check_threshold_dollars', '500');
  return fd;
}

describe('no_show_policy — retired option is refused server-side', () => {
  beforeEach(() => {
    getSupabaseServer.mockClear();
    getSupabaseAdmin.mockClear();
  });

  it('rejects refund_minus_restock on saveDraft, before any DB access', async () => {
    const result = await saveDraft(formWith('refund_minus_restock'));

    expect(result.ok).toBe(false);
    // Proves the rejection happened at inputSchema.safeParse: neither Supabase
    // client was ever constructed, so no read and no INSERT could have run.
    expect(getSupabaseServer).not.toHaveBeenCalled();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('rejects refund_minus_restock on publishPolicy too', async () => {
    const result = await publishPolicy(formWith('refund_minus_restock'));

    expect(result.ok).toBe(false);
    expect(getSupabaseServer).not.toHaveBeenCalled();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('still accepts full_forfeit through validation (guard is not over-broad)', async () => {
    // The mocks throw, so reaching getSupabaseServer proves validation PASSED.
    // That is the point: this test must fail if someone narrows the enum to
    // nothing, or breaks an unrelated field and makes every submission invalid.
    await expect(saveDraft(formWith('full_forfeit'))).rejects.toThrow(
      /getSupabaseServer called/,
    );
    expect(getSupabaseServer).toHaveBeenCalled();
  });
});
