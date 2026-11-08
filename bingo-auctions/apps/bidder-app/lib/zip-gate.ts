// Mandatory ZIP gate (ZIP-required-before-bid/checkout): a one-time block the
// bidder can't skip or snooze, shown on the bidder's NEXT bid or checkout
// action if they have no ZIP on file yet. Distinct from components/home/
// ZipPrompt.tsx, the dismissible home-tab "ask once in a while" prompt — that
// one still exists and is unaffected by this file.
//
// requireZip() is a thin pub-sub so every bid/checkout call site (QuickBid-
// Button, the lot page's counter-bid + PlaceBidSheet via beforeBid(), the
// add-card and pay-fees screens) can block on a saved ZIP without each one
// owning its own modal. One <ZipGateHost/> (mounted once in app/_layout.tsx)
// renders the sheet and answers every call.
//
// FAIL OPEN like postal-code.ts: not signed in, or the host not mounted for
// some reason → resolve true immediately rather than hang a bid forever.

import { createZipChecker, needsZipBeforeBid, type ZipCheckResult } from '@auction-platform/shared';
import { getCurrentUserId, supabase } from '@auction-platform/supabase-client';
import { fetchZipPromptState, saveMyZip } from './postal-code';

type Listener = (open: boolean) => void;

let resolver: ((ok: boolean) => void) | null = null;
// Once this session knows the bidder has a ZIP, bids skip the lookup entirely:
// no extra round trip in the last seconds of a close. A ZIP is never removed
// by the app, so a stale "yes" cannot wrongly let a bid through.
let knownHasZip: string | null = null;
let listener: Listener | null = null;

/** Called once by <ZipGateHost/> to register/unregister itself. */
export function registerZipGateListener(l: Listener | null): void {
  listener = l;
}

const checker = createZipChecker({
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
    // A failed lookup must not read as "unknown ZIP": throw, and the checker
    // accepts the format-valid ZIP (fail open).
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  },
});

/** Exposed so <ZipGateHost/> can validate what the bidder typed. */
export function checkZip(raw: string | null | undefined): Promise<ZipCheckResult> {
  return checker.check(raw);
}

/**
 * Ensures the signed-in bidder has a saved ZIP before a bid/checkout action
 * continues. Resolves true immediately if they already have one (one cheap
 * read, not cached across calls — a ZIP saved via the sheet, profile edit, or
 * the dismissible home prompt all show up on the very next requireZip()).
 * Otherwise opens the blocking sheet and resolves once a valid ZIP is saved,
 * or false if the bidder backs out (no bid/checkout happens).
 */
export async function requireZip(): Promise<boolean> {
  // Local session read, not getUser() (a network call that returns null in a
  // warehouse dead spot).
  const uid = await getCurrentUserId();
  if (!uid) return true; // not signed in: existing auth gates handle this
  if (knownHasZip === uid) return true;
  const state = await fetchZipPromptState(supabase, uid);
  // Could not read her row (offline, timeout): never block a bid on our own
  // failure. Only a confirmed empty ZIP opens the sheet.
  if (!state) return true;
  if (!needsZipBeforeBid(state.postal_code)) {
    knownHasZip = uid;
    return true;
  }
  if (!listener) return true; // host not mounted somehow: never hang a bid
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
    listener?.(true);
  });
}

/**
 * Called by <ZipGateHost/> when the bidder saves a valid ZIP (true) or backs
 * out (false) — resolves whatever bid/checkout call is waiting on
 * requireZip(). Does NOT hide the sheet: the host decides that for itself, so
 * it can chain the optional-profile nudge after a successful save without a
 * flash of the sheet closing and reopening.
 */
export function resolveZipGate(ok: boolean): void {
  const r = resolver;
  resolver = null;
  r?.(ok);
}

export async function saveAndResolveZipGate(zip: string): Promise<'saved' | 'invalid' | 'failed'> {
  const res = await saveMyZip(supabase, zip);
  if (res === 'saved') {
    knownHasZip = await getCurrentUserId();
    resolveZipGate(true);
  }
  return res;
}
