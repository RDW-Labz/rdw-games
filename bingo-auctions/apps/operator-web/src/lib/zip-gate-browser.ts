// Web wiring for the mandatory ZIP gate (ZIP-required-before-bid/checkout
// plan). Pure decision logic lives in packages/shared's zip-gate.ts; this
// file just plugs a Supabase browser client into it. Used by BidWidget,
// SquareCardForm (add card), and PayFeesForm (pay fees) — every bidder-facing
// surface on the web that places a bid or spends money.

import { createZipChecker, type ZipCheckResult } from '@auction-platform/shared';
import type { getSupabaseBrowser } from '@/lib/supabase-browser';

type BrowserSupabase = ReturnType<typeof getSupabaseBrowser>;

// Remembered for the page's life once known: no extra round trip per bid.
const knownHasZip = new Set<string>();

/** Mark a bidder as having a ZIP (after a successful save). */
export function rememberBidderHasZip(bidderId: string): void {
  knownHasZip.add(bidderId);
}

/**
 * Does this bidder already have a ZIP on file? A failed read answers TRUE:
 * never block a bid or checkout on our own lookup failing. Only a confirmed
 * empty ZIP opens the modal.
 */
export async function bidderHasZip(supabase: BrowserSupabase, bidderId: string): Promise<boolean> {
  if (knownHasZip.has(bidderId)) return true;
  try {
    const { data, error } = await supabase
      .from('bidders')
      .select('postal_code')
      .eq('id', bidderId)
      .maybeSingle();
    if (error || !data) return true;
    const has = !!(data as { postal_code?: string | null }).postal_code;
    if (has) knownHasZip.add(bidderId);
    return has;
  } catch {
    return true;
  }
}

export function makeZipChecker(supabase: BrowserSupabase) {
  return createZipChecker({
    hasAnyRows: async () => {
      const { data, error } = await supabase.from('zip_reference').select('postal_code').limit(1);
      if (error) throw new Error(error.message); // checker fails open on a throw
      return (data?.length ?? 0) > 0;
    },
    exists: async (zip: string) => {
      const { data, error } = await supabase
        .from('zip_reference')
        .select('postal_code')
        .eq('postal_code', zip)
        .limit(1);
      if (error) throw new Error(error.message); // a failed lookup is not "unknown ZIP"
      return (data?.length ?? 0) > 0;
    },
  });
}

export type SaveZipResult = { ok: true } | { ok: false; error: string };

export async function saveBidderZip(supabase: BrowserSupabase, zip: string): Promise<SaveZipResult> {
  const { error } = await supabase.rpc('set_my_postal_code', { p_postal_code: zip });
  if (!error) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id) rememberBidderHasZip(data.session.user.id);
    return { ok: true };
  }
  if (error.code === '22023' || /invalid_postal_code/.test(error.message ?? '')) {
    return { ok: false, error: 'Enter a 5-digit ZIP' };
  }
  return { ok: false, error: 'Could not save your ZIP. Check your connection and try again.' };
}

export type { ZipCheckResult };
