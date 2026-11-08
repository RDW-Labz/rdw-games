// resolveOperatorIdForUpload — the SINGLE authority for the operator id that
// must prefix a lot-photos Storage path.
//
// WHY THIS EXISTS (data-loss bug, tester-confirmed):
//   The `lot-photos` bucket INSERT RLS policy requires the upload path's FIRST
//   folder segment to equal current_operator_id():
//     (storage.foldername(name))[1] = current_operator_id()::text
//   where the server resolves
//     current_operator_id() = SELECT operator_id FROM operator_users
//                             WHERE user_id = auth.uid() LIMIT 1
//   (see migrations 0002_rls.sql + 0004_storage.sql + 0028_security_fixes.sql).
//
//   Every mobile lot-photo uploader used to build `${operatorId}/…` from
//   `useOperatorRole().operatorId`. That value is `undefined` whenever the hook
//   is still `loading` or transiently reports non-staff (a TOKEN_REFRESHED blip
//   / network hiccup). A custom-lot save that captured a photo during that
//   window produced a path like `undefined/{lotCode}/…` whose first segment
//   ≠ current_operator_id()::text → the Storage INSERT was RLS-rejected → the
//   photo was SILENTLY DROPPED while the lot row still saved. No error shown.
//
//   Fixing the callers one-by-one is whack-a-mole. Instead, the two path-
//   building uploaders resolve the first segment from THIS helper, which asks
//   the exact same source the server's current_operator_id() does. The path
//   segment is therefore GUARANTEED to match the RLS check for any authed
//   staff session, regardless of what the caller passed or what state the
//   role hook is in.

import { supabase } from './client';

/**
 * Resolve the authenticated user's operator id the same way the Postgres
 * `current_operator_id()` SECURITY DEFINER function does:
 *   SELECT operator_id FROM operator_users WHERE user_id = auth.uid() LIMIT 1
 *
 * Uses the locally-persisted session (getSession, no network round trip) for
 * the user id, then a single indexed lookup for the row. `.limit(1)` matches
 * the server's `LIMIT 1` semantics so a user with more than one operator_users
 * row resolves deterministically instead of erroring (which `.single()` /
 * an unbounded `.maybeSingle()` would do).
 *
 * @returns the operator id string, or null if the user is not signed in / has
 *          no operator_users row (genuinely not staff) or the lookup errored.
 *          Callers MUST treat null as "cannot upload — surface a visible
 *          error" rather than proceeding with a bad path.
 */
export async function resolveOperatorIdForUpload(): Promise<string | null> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr) return null;
  const userId = sessionData.session?.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data && typeof data.operator_id === 'string' ? data.operator_id : null;
}
