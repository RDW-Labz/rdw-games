// Sidebar sign-out control. Tiny client component because supabase.auth.signOut
// has to clear the session via the browser SDK (so the local IndexedDB/cookie
// session goes away too — a server-only sign-out leaves stale client state).
//
// Behavior:
//   - Click → signOut() then router.push('/login') + router.refresh()
//   - Disabled while in-flight (avoids double-clicks creating two sign-out
//     attempts; second one would 404 with "no session" which is harmless
//     but looks like an error in the console).
//
// Styling matches the existing nav-link visual weight so it sits at the
// bottom of the "You" section without standing out as a button.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

export function SignOutLink({ style }: { style?: React.CSSProperties }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      // scope:'local' — sign out THIS browser only. The default (global)
      // revokes every device's refresh token on the account; staff share
      // one login, so a dashboard sign-out killed the warehouse iPads'
      // sessions ~1hr later ("not_authenticated" mid-pickup, 2026-07-10).
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Fall through — even if signOut throws (network blip, already
      // signed out, etc.) we still want to navigate to /login so the
      // user isn't stranded.
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <a
      href="/login"
      onClick={handleClick}
      style={{
        ...style,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
      aria-busy={busy}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </a>
  );
}
