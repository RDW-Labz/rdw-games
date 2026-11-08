// Sign-out button — client component because supabase.auth.signOut()
// needs to clear the browser-side session + cookies. After sign-out we
// hard-navigate to / so the server re-renders without the auth cookie.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    const supabase = getSupabaseBrowser();
    // scope:'local' — this browser only; global sign-out revokes every
    // device on the account (kills shared-login staff iPads mid-shift).
    await supabase.auth.signOut({ scope: 'local' });
    router.push('/');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="btn-secondary"
      style={{
        padding: '0.6rem 1.25rem',
        fontSize: 14,
        opacity: busy ? 0.7 : 1,
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
