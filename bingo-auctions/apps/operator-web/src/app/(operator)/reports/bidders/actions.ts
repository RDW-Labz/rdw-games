'use server';

// Segment loader for the bidder report. Kept as a server action (not fetched
// with the page) because it returns bidder PII and the lists are large — no
// reason to ship hundreds of emails to the browser until staff ask for them.
//
// The RPC (operator_bidder_segment, mig 0289) is admin/manager-gated in SQL, so
// this is defence-in-depth rather than the only check: a picker/checkout staffer
// calling it gets a clean error instead of a raw Postgres exception.

import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const SEGMENT_KEYS = ['never_bid', 'one_and_done', 'lapsed', 'top_spenders', 'all_buyers'] as const;
export type SegmentKey = (typeof SEGMENT_KEYS)[number];

export type SegmentRow = {
  bidder_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  bidder_number: number | null;
  signed_up_at: string | null;
  bids: number;
  invoices: number;
  net_spend_cents: number;
  last_bid_at: string | null;
  last_paid_at: string | null;
};

const schema = z.object({
  segment: z.enum(SEGMENT_KEYS),
  limit: z.number().int().min(1).max(5000).optional(),
});

export type LoadSegmentResult =
  | { ok: true; rows: SegmentRow[] }
  | { ok: false; error: string };

export async function loadSegment(
  segment: SegmentKey,
  limit = 500,
): Promise<LoadSegmentResult> {
  const parsed = schema.safeParse({ segment, limit });
  if (!parsed.success) return { ok: false, error: 'Unknown segment' };

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  if (!['admin', 'manager'].includes((staff as { role: string }).role)) {
    return {
      ok: false,
      error: 'Admin or manager access required — these lists include customer contact details.',
    };
  }

  const { data, error } = await supabase.rpc('operator_bidder_segment', {
    p_segment: parsed.data.segment,
    p_limit: parsed.data.limit ?? 500,
  });
  if (error) {
    return {
      ok: false,
      error: `${error.message}. If this persists, migration 0289 may not be applied yet.`,
    };
  }

  return { ok: true, rows: ((data as SegmentRow[] | null) ?? []).filter(Boolean) };
}
