// Shared auth helper for /api/lottr/* route handlers (and other staff routes
// that need the same identity check).
//
// Two auth paths:
//   1. Cookie session (operator-web desktop UI, Server Components)
//      — uses getSupabaseServer() which reads the cookie jar set by
//        the Next.js middleware / sign-in flow. The returned `scopedClient`
//        in that case is the cookie-session client itself: it already runs
//        every query as the caller, with RLS applied.
//   2. Bearer token (field-mobile)
//      — the mobile app sends `Authorization: Bearer <access_token>` and
//        we verify via admin.auth.getUser(token) which does a live Supabase
//        auth check with no cookie state required. For downstream DB ops
//        we build a fresh anon client and attach the caller's access token
//        in the Authorization header so PostgREST runs queries as the user
//        — RLS is applied identically to the cookie path.
//
// In both cases we confirm the user has an operator_users row (i.e. is
// actual operator staff) before returning success.
//
// IMPORTANT — service-role scoping (WORKING_AGREEMENT §2 and §4):
//   The caller receives BOTH a `scopedClient` (RLS-applied, runs as the
//   caller) AND an `admin` client (service-role, bypasses RLS). Default to
//   `scopedClient` for all DB ops. `admin` is opt-in and EVERY use must
//   carry a comment justifying why RLS bypass is needed (e.g. write to a
//   table whose RLS write policy was intentionally dropped — product_lookups
//   per 0028_security_fixes.sql — or cross-operator audit reads).
//
//   Pre-refactor, this helper returned `supabase = admin` to all callers.
//   That made cross-tenant isolation depend on every single route adding
//   `.eq('operator_id', staff.operator_id)`; one missed filter == data
//   leak. Switching to `scopedClient` makes RLS the safety net.
//
// Returns null on any auth failure so the caller can return 401/403.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabase-admin';
import { getSupabaseServer } from './supabase-server';

export type AuthedCaller = {
  userId: string;
  operatorId: string;
  /**
   * RLS-scoped client. Runs every DB op as the caller (cookie session OR
   * bearer token). Use this by default — RLS enforces operator-scope.
   */
  scopedClient: SupabaseClient;
  /**
   * Service-role client. Bypasses RLS. Use ONLY for operations that
   * legitimately need to bypass tenant scope (e.g. writes to
   * product_lookups, which has no staff write policy by design — see
   * 0028_security_fixes.sql). Every callsite MUST add an inline comment
   * justifying why RLS bypass is required.
   */
  admin: SupabaseClient;
  /**
   * @deprecated Use `scopedClient` for normal ops or `admin` for
   *   service-role ops. This alias is the old single-client API; it
   *   currently points at `admin` to keep behaviour identical to the
   *   pre-refactor code so unswitched callers still function while the
   *   audit completes. Remove once all callers are switched.
   */
  supabase: SupabaseClient;
};

export async function verifyLottrAuth(
  req: Request,
): Promise<AuthedCaller | null> {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (bearerToken) {
    // Mobile path: verify JWT via admin client then check operator_users.
    const admin = getSupabaseAdmin();
    const {
      data: { user },
      error,
    } = await admin.auth.getUser(bearerToken);
    if (error || !user) return null;

    const { data: staff } = await admin
      .from('operator_users')
      .select('operator_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!staff) return null;

    // Build a per-request anon client that runs as the caller. Every
    // subsequent query through this client triggers PostgREST's
    // role-from-JWT resolution, so RLS policies see auth.uid() = user.id
    // and current_operator_id() = staff.operator_id.
    //
    // We mirror the env-var pattern used by supabase-admin.ts so the same
    // missing-env error surface is consistent across the app.
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
    const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
    if (!url || !anon) throw new Error('Missing Supabase env vars');
    const scopedClient = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });

    return {
      userId: user.id,
      operatorId: staff['operator_id'] as string,
      scopedClient,
      admin,
      supabase: admin, // deprecated alias — see type
    };
  }

  // Desktop/web path: verify via cookie session. The cookie-session client
  // is itself RLS-scoped, so we use it as the scopedClient. We still hand
  // back an admin client for the rare callsite that needs service-role.
  const cookieClient = await getSupabaseServer();
  const {
    data: { user },
  } = await cookieClient.auth.getUser();
  if (!user) return null;

  const { data: staff } = await cookieClient
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) return null;

  const admin = getSupabaseAdmin();
  return {
    userId: user.id,
    operatorId: staff['operator_id'] as string,
    scopedClient: cookieClient,
    admin,
    supabase: cookieClient, // deprecated alias — cookie session already RLS-scoped
  };
}
