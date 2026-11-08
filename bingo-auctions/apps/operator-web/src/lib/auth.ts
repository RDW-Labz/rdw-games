// Shared auth helper for ANY route the bidder mobile app calls.
//
// Modeled on `lottr-auth.ts` but role-agnostic — does NOT check for an
// operator_users row (that gate is specific to staff routes). Use this
// for bidder-facing endpoints: /api/bidder/signup, /api/invoices/*,
// /api/identity/verify, /api/subscriptions/*.
//
// Two auth paths, same return shape:
//
//   1. Bearer token (mobile bidder app)
//      Authorization: Bearer <supabase_access_token>
//      → verify via admin.auth.getUser(token), build a fresh RLS-scoped
//      anon client that runs as the caller.
//
//   2. Cookie session (operator-web desktop, if a route is ever called
//      from web context — currently rare for bidder endpoints, but
//      supported for completeness)
//      → getSupabaseServer() reads the cookie jar set by Next.js
//      middleware. The cookie client is itself RLS-scoped.
//
// Returns null on any auth failure so the caller can return 401.
//
// The 2026-05-20 bug this addresses: before this helper, bidder-facing
// routes called getSupabaseServer() directly, which only reads cookies.
// Mobile callers (who send a Bearer header) were silently treated as
// unauthenticated and got 401. The bidder app's /complete-profile flow
// hit this on the first OAuth Apple Sign In after fix-stack v21 landed.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase-admin';
import { getSupabaseServer } from './supabase-server';

export type AuthedUser = {
  userId: string;
  email: string;
  /** Provider-supplied display name, if any (email/password signup → display_name,
   *  Apple → full_name, Google → name). Null when none of those are set. */
  displayName: string | null;
  /**
   * RLS-scoped Supabase client. Runs every query as the caller (cookie session
   * OR Bearer token). Use this by default — RLS enforces row visibility.
   * For service-role ops, use `getSupabaseAdmin()` at the call site and add
   * a comment explaining why RLS bypass is required.
   */
  scopedClient: SupabaseClient;
};

function pickDisplayName(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const candidates = ['display_name', 'full_name', 'name'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Authenticate the request via Bearer token (mobile) or cookie (web).
 * Returns the user + an RLS-scoped Supabase client, or null on failure.
 *
 * IMPORTANT: this is role-agnostic. Callers must implement any role gate
 * (e.g., "is this user a bidder", "is this user staff") on the returned
 * userId. Most bidder-app endpoints don't need an additional role check
 * because RLS already restricts row visibility — but `/api/staff/*`
 * routes that need an operator_users row should keep using verifyLottrAuth.
 */
export async function verifyAuth(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  if (bearerToken) {
    // Mobile path: verify the token via admin client, then build a fresh
    // anon client scoped to this user so PostgREST applies RLS as them.
    const admin = getSupabaseAdmin();
    const {
      data: { user },
      error,
    } = await admin.auth.getUser(bearerToken);
    if (error || !user) return null;

    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
    const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
    if (!url || !anon) throw new Error('Missing Supabase env vars');

    const scopedClient = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });

    return {
      userId: user.id,
      email: user.email ?? '',
      displayName: pickDisplayName(user.user_metadata as Record<string, unknown>),
      scopedClient,
    };
  }

  // Web/desktop path: cookie-based session.
  const cookieClient = await getSupabaseServer();
  const {
    data: { user },
  } = await cookieClient.auth.getUser();
  if (!user) return null;

  return {
    userId: user.id,
    email: user.email ?? '',
    displayName: pickDisplayName(user.user_metadata as Record<string, unknown>),
    scopedClient: cookieClient,
  };
}
