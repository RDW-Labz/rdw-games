// Reset password — the destination of Supabase's reset-password email.
//
// ── WHY THIS IS NOT JUST getSession() ────────────────────────────────────────
// Reported 2026-08-24 (staff member): "If a customer forgot their password for the
// app and tries to get a new one, the password reset link sent to the email —
// if you click it, it says it's broken."
//
// The link was fine. This page assumed Supabase had already turned the token
// into a session before redirecting here, which is only true for ONE of the
// two shapes Supabase can send:
//
//   PKCE     →  /reset-password?code=<uuid>
//               needs exchangeCodeForSession(), and needs the code verifier
//               that the REQUESTING client stored.
//   implicit →  /reset-password#access_token=…&refresh_token=…&type=recovery
//               needs setSession() from the hash.
//
// The bidder MOBILE app requests these resets (packages/supabase-client, plain
// createClient → implicit), while this page is built on @supabase/ssr's
// browser client, which is PKCE. So a customer who asked for a reset in the
// app arrived here with a hash this client would not read, no session, and a
// page confidently telling them the link was expired. Every app-originated
// reset failed this way, which is every reset a bidder can perform — the app
// is the only place they can ask for one.
//
// So: handle BOTH shapes explicitly rather than hoping the client did it, and
// only claim "expired" once neither produced a session.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
};

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowser();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Already signed in (client auto-detected it, or the tab had a
      //    session): nothing to redeem.
      const { data: existing } = await supabase.auth.getSession();
      if (cancelled) return;
      if (existing.session) {
        setHasSession(true);
        return;
      }

      // 2. PKCE — ?code=<uuid>. Only succeeds when the reset was requested
      //    from THIS browser, which is why it cannot be the only path.
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      if (code) {
        const { data, error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code);
        if (cancelled) return;
        if (!exchangeError && data.session) {
          setHasSession(true);
          return;
        }
      }

      // 3. Implicit — tokens in the fragment. This is the shape the mobile
      //    app's reset produces, and the one that used to fall through to
      //    "Link expired".
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const accessToken = hash.get('access_token');
      const refreshToken = hash.get('refresh_token');
      if (accessToken && refreshToken) {
        const { data, error: setError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (cancelled) return;
        if (!setError && data.session) {
          // Strip the tokens from the address bar so a shared or
          // shoulder-surfed URL cannot be replayed into a session.
          window.history.replaceState(null, '', url.pathname);
          setHasSession(true);
          return;
        }
      }

      // 4. Genuinely nothing to work with.
      if (!cancelled) setHasSession(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords don’t match.');
      return;
    }
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
    // Sign out so they have to log in fresh with the new password.
    await supabase.auth.signOut();
    setTimeout(() => router.push('/login'), 2500);
  }

  if (hasSession === null) {
    return (
      <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
        <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>
      </main>
    );
  }

  if (!hasSession) {
    return (
      <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
        <h1>Link expired</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.75rem', lineHeight: 1.5 }}>
          This reset link is no longer valid (it may have expired, been used already, or been
          opened in a different browser than the one you started from). Request a fresh one.
        </p>
        <p style={{ marginTop: '1.5rem' }}>
          <Link href="/forgot-password" style={{ color: 'var(--accent)' }}>
            Get a new reset link
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
      <h1>Set a new password</h1>
      {done ? (
        <p style={{ color: 'var(--success)', marginTop: '1.5rem', lineHeight: 1.5 }}>
          Password updated. Redirecting you to sign in…
        </p>
      ) : (
        <form
          onSubmit={onSubmit}
          style={{ display: 'grid', gap: '0.75rem', marginTop: '1.5rem' }}
        >
          <input
            type="password"
            placeholder="New password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            style={inputStyle}
          />
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '0.75rem',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
            }}
          >
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}
    </main>
  );
}
