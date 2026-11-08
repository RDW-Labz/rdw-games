'use client';

// Login form client component — extracted from page.tsx so page.tsx can
// remain a server component and export `metadata`. Handles email+password
// sign-in, Google OAuth, and post-login routing (operator → /dashboard,
// bidder → /browse, ?next= param wins over both defaults).

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { safePostAuthPath } from '@/lib/bidder-onboarding-gate';

const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
};

function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  // Validate `next` before it reaches navigation or the OAuth callback (#825).
  const safeNext = safePostAuthPath(params.get('next'));
  const supabase = getSupabaseBrowser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  /**
   * Route the just-signed-in user to the right home screen. Operators
   * (anyone with an `operator_users` row) go to /dashboard; bidders go
   * to /browse. If the URL came with ?next= (e.g. from a "Sign in to bid"
   * redirect on /lot/[code]), that wins over both defaults.
   */
  async function routePostLogin() {
    if (safeNext) {
      router.push(safeNext);
      router.refresh();
      return;
    }
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      router.push('/');
      router.refresh();
      return;
    }
    const { data: staff } = await supabase
      .from('operator_users')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    router.push(staff ? '/dashboard' : '/browse');
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }
    await routePostLogin();
    setLoading(false);
  }

  async function onGoogle() {
    setError(null);
    setOauthLoading(true);
    // Carry ?next= through the OAuth round-trip so /auth/callback can
    // honor it (and falls back to its own bidder-vs-operator routing
    // when next is absent).
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    if (safeNext) callbackUrl.searchParams.set('next', safeNext);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl.toString(),
      },
    });
    if (oauthError) {
      setOauthLoading(false);
      setError(oauthError.message);
    }
    // On success Supabase redirects to Google -> back to /auth/callback,
    // so we don't reach this line.
  }

  async function onApple() {
    setError(null);
    setOauthLoading(true);
    // Same PKCE round-trip as Google — /auth/callback is provider-agnostic.
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    if (safeNext) callbackUrl.searchParams.set('next', safeNext);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: callbackUrl.toString() },
    });
    if (oauthError) {
      setOauthLoading(false);
      // Until the Apple provider's web Services ID + secret are configured in
      // Supabase, this comes back "provider is not enabled" — show a soft note
      // instead of a scary raw error (Google/email still work).
      setError(
        /not enabled|unsupported provider/i.test(oauthError.message)
          ? 'Apple sign-in isn’t available yet — use Google or email for now.'
          : oauthError.message,
      );
    }
  }

  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 420, margin: '0 auto' }}>
      <h1>Sign in</h1>
      <p
        style={{
          marginTop: '0.5rem',
          marginBottom: '1.5rem',
          color: 'var(--fg-muted)',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        Sign in to bid on live BinGo Auctions, track your bids, and manage your pickups. New here?
        Create a bidder account below.
      </p>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#9ca3af' }}>
            Email
          </span>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#9ca3af' }}>
            Password
          </span>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
        </label>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <button
          type="submit"
          disabled={loading || oauthLoading}
          style={{
            padding: '0.75rem',
            background: 'var(--accent)',
            color: '#000',
            border: 'none',
            borderRadius: 4,
          }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <div style={{ textAlign: 'right' }}>
          <Link href="/forgot-password" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Forgot password?
          </Link>
        </div>
      </form>

      <div
        style={{
          margin: '1.5rem 0 1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          color: 'var(--fg-muted)',
          fontSize: 12,
        }}
      >
        <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
        OR
        <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
      </div>

      <button
        type="button"
        onClick={onGoogle}
        disabled={loading || oauthLoading}
        style={{
          width: '100%',
          padding: '0.75rem',
          background: '#fff',
          color: '#1f1f1f',
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          fontWeight: 500,
        }}
      >
        <span aria-hidden style={{ fontSize: 18, fontWeight: 700, color: '#4285f4' }}>
          G
        </span>
        {oauthLoading ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>

      <button
        type="button"
        onClick={onApple}
        disabled={loading || oauthLoading}
        style={{
          width: '100%',
          marginTop: '0.6rem',
          padding: '0.75rem',
          background: '#000',
          color: '#fff',
          border: '1px solid #000',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          fontWeight: 500,
        }}
      >
        <svg aria-hidden width="15" height="15" viewBox="0 0 384 512" fill="#fff">
          <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
        </svg>
        {oauthLoading ? 'Redirecting…' : 'Continue with Apple'}
      </button>

      {/* New-bidder CTA. /signup is the bidder signup page. */}
      <div
        style={{
          marginTop: '2rem',
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          textAlign: 'center',
          color: 'var(--fg-muted)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>New to BinGo Auctions?</strong>
        <br />
        <Link href="/signup" style={{ color: 'var(--accent)' }}>
          Sign up to bid &rarr;
        </Link>
      </div>
    </main>
  );
}

// Suspense boundary so useSearchParams() doesn't break static prerender.
// Next.js 15+ requires this for any client component that reads search
// params at the top level. The fallback renders briefly (microseconds)
// while React hydrates the search-param read on the client.
export function LoginFormClient() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
