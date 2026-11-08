// Super-admin gate — small, env-var driven allowlist used by the
// /admin/* pages and actions. The list of emails lives in the
// SUPER_ADMIN_EMAILS env var (comma-separated, case-insensitive).
//
// Why env var rather than a DB column / role: Michael wants to be the
// sole human reviewing operator_requests for the foreseeable future,
// and bootstrapping a "super_admin" role into RLS would require touching
// migrations + invite flows. An env-var allowlist is the smallest thing
// that works for one person + can be promoted to a DB-backed role later
// without breaking callers (they all call isSuperAdmin / assertSuperAdmin).
//
// Behavior:
//   - isSuperAdmin(email):   pure helper, returns boolean. Safe to call
//                            from anywhere (server or client) so long as
//                            the caller already knows the email.
//   - assertSuperAdmin():    server-only gate. Looks up the signed-in
//                            user via the existing supabase-server client,
//                            redirects to /dashboard with ?flash=admin-only
//                            if the caller isn't on the allowlist. Mirrors
//                            the pattern used by (operator)/layout.tsx's
//                            redirect-on-no-staff and require-aal2's
//                            response-or-pass shape.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from './supabase-server';

/**
 * Pure check: is this email on the super-admin allowlist?
 *
 * Reads SUPER_ADMIN_EMAILS from process.env every call (no caching) so
 * a wrangler secret rotation takes effect without redeploy. The list is
 * tiny so the cost is negligible.
 */
export function isSuperAdmin(email: string | null | undefined): boolean {
  const list = (process.env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(email.toLowerCase());
}

/**
 * Server-only gate. Call at the top of a Server Component (page.tsx) or
 * a Server Action that must be reachable ONLY to super admins. If the
 * caller is unauthenticated → redirect to /login. If authenticated but
 * not on the allowlist → redirect to /dashboard?flash=admin-only.
 *
 * Always returns the verified email when it returns at all; the
 * not-allowed paths call Next.js `redirect()` which throws.
 */
export async function assertSuperAdmin(): Promise<{ userId: string; email: string }> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const email = user.email ?? null;
  if (!isSuperAdmin(email)) {
    // Same flash-message pattern as the rest of the (operator) console:
    // the dashboard reads ?flash=… and shows a one-shot banner.
    redirect('/dashboard?flash=admin-only');
  }

  // After the two redirects above, email is guaranteed non-null.
  return { userId: user.id, email: email as string };
}
