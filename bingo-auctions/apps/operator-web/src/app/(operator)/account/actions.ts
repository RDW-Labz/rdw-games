// Server actions for /account — force-rotate-on-first-login flow
// (LAUNCH_PLAN §1.7) and display name update.
//
// rotatePasswordOnFirstLogin:
//   Combined "set new password + clear the force flag" call. Runs as the
//   user's own cookie session, NOT service-role. supabase.auth.updateUser
//   handles the auth-side write; the same client patches
//   operator_users.force_password_rotate = FALSE via RLS (covered by
//   operator_users_self_update in migration 0080).
//
// Why a server action vs. a client-side supabase.auth.updateUser:
//   We need to update operator_users.force_password_rotate AT THE SAME
//   TIME as the password change, atomically from the user's standpoint.
//   If we did it client-side and the update succeeded but the flag-flip
//   failed, the user would be stuck in the rotate-loop. A server action
//   gives us a clean two-step that returns a single { ok, error } shape.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const rotateSchema = z.object({
  newPassword: z.string().min(12).max(128),
});

export type RotateResult =
  | { ok: true }
  | { ok: false; error: string };

export async function rotatePasswordOnFirstLogin(
  formData: FormData,
): Promise<RotateResult> {
  const parsed = rotateSchema.safeParse({
    newPassword: formData.get('newPassword'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'not_authenticated' };
  }

  // Step 1: update the auth password. Supabase Auth bcrypt-hashes server-side;
  // the plaintext never lands in our DB.
  const { error: passErr } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (passErr) {
    return { ok: false, error: passErr.message };
  }

  // Step 2: clear the force-rotate flag via the column-scoped RPC.
  // Migration 0091 dropped the broad operator_users_self_update RLS policy
  // (audit F-01 — it allowed users to UPDATE their own role to 'admin'
  // via direct PostgREST, defeating MFA). The RPC is restricted to clearing
  // exactly the force_password_rotate column.
  const { error: flagErr } = await supabase.rpc('clear_force_password_rotate');
  if (flagErr) {
    // Auth password is already changed at this point — if we fail to clear
    // the flag, the user will see the rotate page again next request and
    // can retry. Surface the error so they know to retry but they CAN
    // sign in with the new password if they back out.
    return { ok: false, error: `password_changed_but_flag_persisted: ${flagErr.message}` };
  }

  // Bust the (operator) layout cache so the next render reflects the
  // cleared flag and the middleware redirect doesn't fire again.
  revalidatePath('/', 'layout');
  return { ok: true };
}

const displayNameSchema = z.object({
  displayName: z.string().max(80).nullable(),
});

export type DisplayNameResult =
  | { ok: true }
  | { ok: false; error: string };

/** Update operator_users.display_name for the signed-in user. */
export async function updateDisplayName(
  displayName: string | null,
): Promise<DisplayNameResult> {
  const parsed = displayNameSchema.safeParse({ displayName });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('operator_users')
    .update({ display_name: parsed.data.displayName })
    .eq('user_id', user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/account');
  return { ok: true };
}
