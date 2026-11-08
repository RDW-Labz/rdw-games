// Keep a saved card's billing ZIP as the bidder's account ZIP, only when they
// have none (migration 0436, fill_bidder_postal_code_if_empty). Square's card
// form asks for the billing ZIP and CreateCard returns it on
// card.billing_address.postal_code.
//
// This must never fail or slow a card save: every error is swallowed, the call
// is capped by a short timeout, and logs carry only an error code (no ZIP, no
// bidder id). Before 0434/0436 are applied the RPC is missing (PGRST202 /
// 42883); that is expected and not logged.

import type { SupabaseClient } from '@supabase/supabase-js';

const US_ZIP_RE = /^([0-9]{5})(?:-[0-9]{4})?$/;
const MISSING_FN_CODES = new Set(['PGRST202', '42883']);
export const FILL_ZIP_TIMEOUT_MS = 1500;

/**
 * US 5-digit or ZIP+4 → the first 5 digits; anything else → null. A card whose
 * billing country is set and is not US is skipped. The SQL function checks
 * the format again.
 */
export function normaliseUsZip(raw: unknown, country?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (typeof country === 'string' && country.trim() !== '' && country.trim().toUpperCase() !== 'US') {
    return null;
  }
  const m = US_ZIP_RE.exec(raw.trim());
  return m ? m[1]! : null;
}

/**
 * Best effort. Resolves true if a ZIP was filled, false otherwise (no ZIP,
 * already had one, function missing, error, timeout). Never rejects.
 */
export async function fillBidderPostalCodeFromCard(
  admin: SupabaseClient,
  bidderId: string,
  postalCode: string | null | undefined,
  timeoutMs: number = FILL_ZIP_TIMEOUT_MS,
): Promise<boolean> {
  if (!postalCode) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve(
      admin.rpc('fill_bidder_postal_code_if_empty', {
        p_bidder_id: bidderId,
        p_postal_code: postalCode,
      }),
    ).then(({ data, error }) => {
      if (error) {
        if (!MISSING_FN_CODES.has(error.code ?? '')) {
          console.error('[square/save-card] billing ZIP fill failed:', error.code ?? 'unknown');
        }
        return false;
      }
      return data === true;
    });
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        console.error('[square/save-card] billing ZIP fill timed out');
        resolve(false);
      }, timeoutMs);
    });
    const safe = call.catch(() => {
      console.error('[square/save-card] billing ZIP fill threw');
      return false;
    });
    return await Promise.race([safe, timeout]);
  } catch {
    console.error('[square/save-card] billing ZIP fill threw');
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
