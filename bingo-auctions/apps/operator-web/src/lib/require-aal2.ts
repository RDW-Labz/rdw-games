// MFA / AAL2 gate for API route handlers (LAUNCH_PLAN §3.1c).
//
// The Next.js middleware enforces AAL2 on sensitive page navigations
// (/staff, /billing, /account, /payouts), but API routes don't pass
// through the middleware — the matcher excludes /api/* so route handlers
// can do their own auth (webhooks etc.).
//
// For sensitive mutations exposed under /api/operator/* — e.g. PATCH or
// DELETE on /api/staff/[id] — we re-check the same conditions inside
// the route handler. The rules match the middleware:
//
//   • If the caller is an operator admin AND has at least one verified
//     TOTP factor AND the current session AAL is aal1 → reject with 403
//     and a structured error code the client can interpret to redirect
//     the user to /account/security/step-up.
//   • If the caller has no verified factor yet (still in the 7-day
//     grace period or has chosen not to enrol), let the mutation through
//     at AAL1. The dashboard banner is the prompt-to-enrol; the API
//     check doesn't add a second wall here because the user has no factor
//     to step up with.
//
// Non-admin staff are not gated for MFA — they're scoped by RLS but not
// by AAL2.

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AAL2Check =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Re-checks the AAL2 gate that the middleware applies to sensitive page
 * navigations. Call this at the top of API route handlers that perform
 * sensitive mutations on staff, billing, account, or payouts data.
 *
 * Returns { ok: true } when the request is allowed to proceed, or
 * { ok: false, response } with a pre-built 403 JSON response to return.
 */
/**
 * Decode the `aal` claim from a Supabase access-token JWT without verifying
 * the signature. Safe here because requireAAL2ForAdmin only reads it AFTER
 * supabase.auth.getUser() (a server round-trip) has validated the same token.
 * Used on the mobile bearer path, where the client carries no stored session
 * so supabase.auth.mfa.getAuthenticatorAssuranceLevel() returns null.
 */
function aalFromJwt(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { aal?: string };
    return payload.aal ?? null;
  } catch {
    return null;
  }
}

export async function requireAAL2ForAdmin(
  supabase: SupabaseClient,
  accessToken?: string,
): Promise<AAL2Check> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'not_authenticated' }, { status: 401 }),
    };
  }

  const { data: staff } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = (staff as { role?: string } | null)?.role ?? null;

  // Non-admins aren't MFA-gated. They still have to be authenticated
  // (above) and pass the route's own role checks (caller-side).
  if (role !== 'admin') {
    return { ok: true };
  }

  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const hasVerifiedTotp = (factorsData?.all ?? []).some(
    (f) => f.factor_type === 'totp' && f.status === 'verified',
  );

  // Admin with no factor yet — falls under the 7-day grace period. The
  // dashboard banner is the in-app nag; the API doesn't block here
  // because there's no factor for the user to step up against.
  if (!hasVerifiedTotp) {
    return { ok: true };
  }

  // Determine the caller's current AAL. Cookie path: read it from the stored
  // session. Bearer path (accessToken provided): the client has no session, so
  // getAuthenticatorAssuranceLevel() returns null — decode the authoritative
  // aal claim from the already-validated JWT instead.
  let currentLevel: string | null;
  if (accessToken) {
    currentLevel = aalFromJwt(accessToken);
  } else {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    currentLevel = aalData?.currentLevel ?? null;
  }
  if (currentLevel === 'aal2') {
    return { ok: true };
  }

  // Admin with a factor but still at aal1 — block. The client can
  // pattern-match on `error: 'aal2_required'` and redirect the user to
  // /account/security/step-up.
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: 'aal2_required',
        // step-up URL hint so the client can redirect without hardcoding
        // the path. The empty returnTo placeholder is fine — the client
        // knows the page it was on.
        step_up_url: '/account/security/step-up',
      },
      { status: 403 },
    ),
  };
}
