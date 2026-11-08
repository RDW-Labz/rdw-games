// Optional profile fields (0448 plan): phone + explicit SMS consent + "how
// did you hear about us?". Offered once (skippable) right after the bidder
// clears the mandatory ZIP step, and always editable later from
// app/profile/edit.tsx. Every write goes through set_my_optional_profile()
// (SECURITY DEFINER) — see ~/Documents/bingo-migrations-pending/
// 0448_bidder_optional_profile.sql.
//
// FAIL SOFT, same as postal-code.ts: before 0448 is applied the RPC/columns
// are missing and every call here resolves to "don't show" / "nothing
// saved", never a crash or a blocked bid/checkout (this step never gates
// anything — Skip and "it failed to load" look the same to the bidder).

import { SMS_CONSENT_ENABLED } from '@auction-platform/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX_LEN,
  SMS_CONSENT_TEXT,
  SMS_CONSENT_TEXT_VERSION,
  isValidHeardAbout,
  sanitizeHeardAboutOther,
  type HeardAboutValue,
} from '@auction-platform/shared';

export { HEARD_ABOUT_OPTIONS, HEARD_ABOUT_OTHER_MAX_LEN, SMS_CONSENT_TEXT, SMS_CONSENT_TEXT_VERSION };
export type { HeardAboutValue };

export type OptionalProfileState = {
  phone: string | null;
  sms_consent_at: string | null;
  heard_about: string | null;
  heard_about_other: string | null;
  optional_profile_prompted_at: string | null;
};

/** null on any error (not signed in, column missing before 0448, offline). */
export async function fetchOptionalProfileState(
  supabase: SupabaseClient,
  userId: string,
): Promise<OptionalProfileState | null> {
  try {
    const { data, error } = await supabase
      .from('bidders')
      .select('phone, sms_consent_at, heard_about, heard_about_other, optional_profile_prompted_at')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as OptionalProfileState;
  } catch {
    return null;
  }
}

/** True only once we positively know the step has never been offered —
 *  "don't know" (lookup failed / 0448 not applied) must never show it. */
export function needsOptionalProfilePrompt(state: OptionalProfileState | null): boolean {
  return state != null && state.optional_profile_prompted_at == null;
}

/** Same normalization app/profile/edit.tsx uses for its own phone field. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return `+${digits}`;
}

export type SaveOptionalProfileInput = {
  phone?: string | null;
  smsConsent: boolean;
  heardAbout?: string | null;
  heardAboutOther?: string | null;
};

export type SaveOptionalProfileResult = 'saved' | 'invalid' | 'failed';

/**
 * Save (or Skip, by passing no fields and smsConsent: false) whichever
 * optional fields the bidder filled in. Always stamps
 * optional_profile_prompted_at server-side, so repeated Skips never show
 * the nudge again.
 */
export async function saveOptionalProfile(
  supabase: SupabaseClient,
  input: SaveOptionalProfileInput,
): Promise<SaveOptionalProfileResult> {
  if (input.heardAbout != null && !isValidHeardAbout(input.heardAbout)) return 'invalid';
  try {
    const { error } = await supabase.rpc('set_my_optional_profile', {
      // Held (SMS_CONSENT_ENABLED): never write a phone from this step; NULL leaves it alone.
      p_phone: SMS_CONSENT_ENABLED && input.phone ? normalizePhone(input.phone) : null,
      p_sms_consent: SMS_CONSENT_ENABLED && input.smsConsent,
      p_sms_consent_text_version: SMS_CONSENT_ENABLED && input.smsConsent ? SMS_CONSENT_TEXT_VERSION : null,
      p_heard_about: input.heardAbout ?? null,
      p_heard_about_other:
        input.heardAbout === 'other' ? sanitizeHeardAboutOther(input.heardAboutOther) : null,
    });
    if (!error) return 'saved';
    if (error.code === '22023') return 'invalid';
    return 'failed';
  } catch {
    return 'failed';
  }
}
