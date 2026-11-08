// Bidder ZIP code (migration 0434): validation, "is the launch prompt due",
// and the three server calls. Pure logic + calls that take the client as a
// parameter, so vitest can cover it without native modules.
//
// FAIL SOFT: the app may reach phones before 0434 is applied. Every call here
// swallows errors: a missing column / RPC means "don't prompt" and "nothing
// saved", never a crash, a blocked screen or an error over bidding/checkout.

import type { SupabaseClient } from '@supabase/supabase-js';

export const ZIP_ERROR_MESSAGE = 'Enter a 5-digit ZIP';
/** The prompt stops after this many "Not now" taps (0434 prompt_count). */
export const ZIP_PROMPT_MAX = 3;
/** Matches snooze_my_postal_code_prompt(): now() + 30 days. */
export const ZIP_SNOOZE_DAYS = 30;

export type ZipValidation = { ok: true; zip: string | null } | { ok: false; error: string };

/**
 * Same rule as set_my_postal_code(): trim; empty → clear (null); otherwise
 * exactly five digits.
 */
export function validateZip(raw: string | null | undefined): ZipValidation {
  const zip = (raw ?? '').trim();
  if (zip === '') return { ok: true, zip: null };
  if (/^[0-9]{5}$/.test(zip)) return { ok: true, zip };
  return { ok: false, error: ZIP_ERROR_MESSAGE };
}

/** Keep only digits, at most five — for the TextInput onChangeText. */
export function sanitizeZipInput(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, 5);
}

export type ZipPromptState = {
  postal_code: string | null;
  postal_code_prompt_count: number | null;
  postal_code_prompt_after: string | null;
};

/**
 * Show the launch prompt only when the bidder has no ZIP, has said "Not now"
 * fewer than 3 times, and any snooze has run out.
 */
export function isZipPromptDue(state: ZipPromptState | null, now: Date): boolean {
  if (!state) return false;
  if (state.postal_code) return false;
  if ((state.postal_code_prompt_count ?? 0) >= ZIP_PROMPT_MAX) return false;
  if (state.postal_code_prompt_after) {
    const after = Date.parse(state.postal_code_prompt_after);
    if (Number.isNaN(after)) return false;
    if (after >= now.getTime()) return false;
  }
  return true;
}

/** Read the signed-in bidder's own prompt state. null on any error. */
export async function fetchZipPromptState(
  supabase: SupabaseClient,
  userId: string,
): Promise<ZipPromptState | null> {
  try {
    const { data, error } = await supabase
      .from('bidders')
      .select('postal_code, postal_code_prompt_count, postal_code_prompt_after')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data as ZipPromptState;
  } catch {
    return null;
  }
}

/** The signed-in bidder's ZIP, or null (none, or not readable yet). */
export async function fetchMyZip(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const state = await fetchZipPromptState(supabase, userId);
  return state?.postal_code ?? null;
}

export type SaveZipResult = 'saved' | 'invalid' | 'failed';

/**
 * set_my_postal_code(). 'invalid' only for the server's invalid_postal_code;
 * anything else (offline, RPC not deployed yet) is 'failed' and the caller
 * moves on.
 */
export async function saveMyZip(
  supabase: SupabaseClient,
  zip: string | null,
): Promise<SaveZipResult> {
  try {
    const { error } = await supabase.rpc('set_my_postal_code', { p_postal_code: zip ?? '' });
    if (!error) return 'saved';
    if (error.code === '22023' || /invalid_postal_code/.test(error.message ?? '')) return 'invalid';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** snooze_my_postal_code_prompt(). Errors ignored. */
export async function snoozeZipPrompt(supabase: SupabaseClient): Promise<void> {
  try {
    await supabase.rpc('snooze_my_postal_code_prompt');
  } catch {
    /* fail soft */
  }
}

// ── ZIP typed at email signup before the account has a session ──────────────
// When email confirmation is on, signup ends with no session, so the ZIP
// can't be saved yet. The signup screen stores it on the device with the
// email it belongs to; the home screen saves it on the first signed-in launch
// for that same email only (never onto another account on a shared phone).

export const PENDING_ZIP_STORAGE_KEY = 'pending_postal_code_v1';

export type PendingZip = { zip: string; email: string };

export function encodePendingZip(zip: string, email: string): string {
  return JSON.stringify({ zip, email: email.trim().toLowerCase() });
}

/** The pending ZIP for this signed-in email, or null (absent, other account, malformed). */
export function pendingZipFor(raw: string | null, email: string | null | undefined): string | null {
  if (!raw || !email) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingZip>;
    if (typeof p.zip !== 'string' || typeof p.email !== 'string') return null;
    if (p.email !== email.trim().toLowerCase()) return null;
    const v = validateZip(p.zip);
    return v.ok ? v.zip : null;
  } catch {
    return null;
  }
}
