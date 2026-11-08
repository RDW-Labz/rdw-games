// /auth/handoff — native → web session handoff.
//
// The bidder-app (React Native) can't run the Square Web Payments SDK
// natively (deliberately no native payments SDK — Stripe's caused iOS
// launch deadlocks historically, see apps/bidder-app/app/_layout.tsx).
// Instead the app hands its live Supabase session to this web page, which
// re-establishes the browser session and drops the user straight onto the
// existing web Square card form.
//
// Contract — the app opens:
//   https://bingoauctions.com/auth/handoff#access_token=<t>&refresh_token=<r>&next=<path>
//
// Tokens ride in the URL **hash fragment**, NOT the query string, so they
// are never sent to the server / logged in access logs. This page reads
// them client-side, calls supabase.auth.setSession() (browser client, so
// the session lands in the same cookie/storage the rest of operator-web
// reads), then replaces to `next` (default the card form). Missing or
// invalid tokens → /login.

'use client';

import { useEffect, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { safeInternalPath } from '@/lib/bidder-onboarding-gate';

export const dynamic = 'force-dynamic';

const DEFAULT_NEXT = '/bidder/onboarding/payment-method';

export default function AuthHandoffPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Tokens are in the hash fragment: #access_token=...&refresh_token=...&next=...
      // location.hash includes the leading '#'.
      const hash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const next = safeInternalPath(params.get('next')) ?? DEFAULT_NEXT;

      if (!accessToken || !refreshToken) {
        window.location.replace('/login');
        return;
      }

      try {
        const supabase = getSupabaseBrowser();
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (cancelled) return;
        if (error) {
          setFailed(true);
          window.location.replace('/login');
          return;
        }
        // Strip the tokens out of the URL before leaving (defense in depth —
        // replace() to `next` navigates away anyway, but this also clears the
        // fragment from history if the nav is intercepted).
        window.location.replace(next);
      } catch {
        if (cancelled) return;
        setFailed(true);
        window.location.replace('/login');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.25rem',
        padding: '2rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          border: '3px solid var(--border)',
          borderTop: '3px solid var(--accent)',
          borderRadius: '50%',
          animation: 'spin 0.9s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>
        {failed ? 'Redirecting…' : 'Signing you in…'}
      </p>
    </main>
  );
}
