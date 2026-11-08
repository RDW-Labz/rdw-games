// ── Demo-operator exclusion ────────────────────────────────────────────────
//
// H4-c (2026-06-03): the demo operator (Demo Auctioneer) carries a permanent
// "BinGo Auctions Demo Auction — App Review" auction so Apple/Google reviewers always
// have something biddable. Real users must NOT see it on the public storefront.
//
// The storefront loaders that consume this helper use the service-role admin
// client (getSupabaseAdmin), which BYPASSES RLS — so the reviewer-scoped RLS
// guard in migration 0181 does NOT apply there. The exclusion must live in the
// query. Reviewers test via the mobile bidder app (see
// docs/APP_REVIEWER_NOTES.md), NOT the public web pages, so web excludes demo
// operators UNCONDITIONALLY (there is no reviewer auth context to honour on
// these public pages).
//
// Lifted verbatim from (public)/browse/page.tsx (2026-06-10) so every public
// web loader can share one implementation — the exclusion previously lived in
// browse/page.tsx alone and every other public loader leaked the demo content.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

/**
 * Returns the list of operator IDs flagged is_demo. Cached for 60s — the demo
 * flag effectively never changes, and a stale-by-a-minute exclusion is
 * harmless.
 */
// Direct per-render lookup — deliberately NOT unstable_cache (Workers runtime
// froze cached values; see browse counts, 2026-07-04). One tiny select.
export const getDemoOperatorIds = async (): Promise<string[]> => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('operators')
      .select('id')
      .eq('is_demo', true);
    if (error) {
      // Fail safe: on error, return [] so the storefront still renders. The
      // worst case is the demo briefly leaking, not a blank page.
      console.error('[browse] demo-operator lookup failed', error.message);
      return [];
    }
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  };

/** PostgREST `not in` list literal: `(id1,id2)`. Empty list → null (skip filter). */
export function demoExclusionList(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return `(${ids.join(',')})`;
}
