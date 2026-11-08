// Escape hatch for the finish-profile gate (#820).
//
// The public layout sends a signed-in user with no `bidders` row to
// /bidder/onboarding. That redirect is mandatory, so the page's own "Back"
// link used to point at `/` — which the gate immediately bounced back to
// onboarding. A visitor who declines consent, cannot satisfy the age gate, or
// signed in with the wrong account had no way out.
//
// This control signs the browser out (scope:'local' — never revoke every
// device) and hard-navigates to the anonymous marketplace. No bidder row and
// no consent record is written.
//
// #825: sign-out can fail before the session is cleared (network/500 returns
// an error, or the request hangs). Navigating anyway would send the still
// signed-in orphan back through the gate into onboarding, so a failed attempt
// shows a retryable message and stays put.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { escapeToGuest } from '@/lib/guest-escape';

export function GuestEscape({
  label,
  className,
  style,
}: {
  label: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(null);

    const outcome = await escapeToGuest(async () => {
      const supabase = getSupabaseBrowser();
      return supabase.auth.signOut({ scope: 'local' });
    });

    if (!outcome.ok) {
      setError(outcome.message);
      setBusy(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <span style={{ display: 'inline-block' }}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
        className={className}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.7 : 1,
          ...style,
        }}
      >
        {busy ? 'Signing out…' : label}
      </button>
      {error && (
        <span
          role="alert"
          style={{
            display: 'block',
            marginTop: 6,
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--danger)',
          }}
        >
          {error}{' '}
          <button
            type="button"
            onClick={onClick}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              color: 'var(--accent)',
              textDecoration: 'underline',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Try again
          </button>
        </span>
      )}
    </span>
  );
}
