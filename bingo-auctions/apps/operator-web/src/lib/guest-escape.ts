// Sign-out controller for the finish-profile gate (#825).
//
// The guest escape must only leave the onboarding page once the browser
// session is actually gone. `supabase.auth.signOut({scope:'local'})` can
// resolve with an error (network/500) before clearing the session; navigating
// home in that case lets the public layout bounce the still-signed-in orphan
// straight back to onboarding — an invisible redirect loop.
//
// This is pure so the success / returned-error / thrown-error / timeout paths
// can be tested without a DOM.

export type SignOutResultLike = { error?: { message?: string } | null } | null | undefined | void;

export type GuestEscapeOutcome = { ok: true } | { ok: false; message: string };

export const GUEST_ESCAPE_FAILED_MESSAGE =
  'Could not sign you out — you are still signed in. Check your connection and try again.';

/**
 * Run one sign-out attempt. Never navigates; the caller decides.
 *
 * A resolved `{ error }`, a thrown error and a hung request all return
 * `{ ok: false }` so the screen can show a retry instead of looping.
 */
export async function escapeToGuest(
  signOut: () => Promise<SignOutResultLike>,
  timeoutMs = 10_000,
): Promise<GuestEscapeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('sign-out timed out')), timeoutMs);
    });
    const result = await Promise.race([signOut(), timeout]);
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      return { ok: false, message: GUEST_ESCAPE_FAILED_MESSAGE };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: GUEST_ESCAPE_FAILED_MESSAGE };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
