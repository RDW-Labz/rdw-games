'use client';

// Bidder signup form — bingoauctions.com/signup.
//
// Client component extracted from page.tsx so page.tsx can remain a
// server component and export `metadata`. This file owns all interactive
// auth state: email+password signup, Google OAuth, Apple (disabled), and
// the post-submission "check your inbox" confirmation view.

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { onboardingEntryHref } from '@/lib/bidder-onboarding-gate';

function BidderSignupPageInner() {
  const supabase = getSupabaseBrowser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryNext = searchParams.get('next');

  // The bidder always lands at /bidder/onboarding after their session is
  // live so they can finish DOB + card. After onboarding completes they
  // bounce to the deep link (e.g. the lot they were trying to bid on) if
  // we carry it through; otherwise to /browse.
  // Validate `next` before it is forwarded into the email-confirmation URL or
  // the OAuth callback (#825). The onboarding page validates again at use.
  const onboardingNext = onboardingEntryHref(queryNext);

  // "Give $5, get $5" (mig 0229): referral share links are /signup?ref=CODE.
  // Email confirmation round-trips through the inbox and drops query params,
  // so stash the code in localStorage — the onboarding form picks it up and
  // sends it with /api/bidder/signup.
  const queryRef = searchParams.get('ref');
  useEffect(() => {
    if (!queryRef) return;
    try {
      window.localStorage.setItem('bingo_ref', queryRef.trim().toUpperCase());
    } catch {
      // Private mode — the bidder can still type the code at onboarding.
    }
  }, [queryRef]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'google' | 'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  // Failure beacon → signup_failures (mig 0223). Auth-rejected signups leave
  // no auth.users row, so this is the only operator-visible trace. Fire and
  // forget — reporting must never block or break the form itself.
  function reportSignupFailure(attemptedEmail: string, message: string) {
    try {
      void fetch('/api/telemetry/signup-failure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: attemptedEmail, message, source: 'web' }),
        keepalive: true,
      });
    } catch {
      /* best effort */
    }
  }

  // Raw GoTrue messages read as internals ("email rate limit exceeded",
  // "For security purposes, you can only request this after 10 seconds").
  // Translate the ones customers actually hit into copy with a way forward.
  // (Diagnosed 2026-07-08: the top failure beacons were this throttle — a
  // double-submit within Supabase's 60s per-email cooldown — and browser
  // network blips, neither of which had friendly copy.)
  function friendlyAuthError(message: string): string {
    if (/after \d+ seconds|security purposes/i.test(message)) {
      return 'You just requested that — your confirmation email is already on its way. Check your inbox (and spam) in a minute. Still nothing? Use “Continue with Google” below to get in instantly.';
    }
    if (/rate limit/i.test(message)) {
      return 'We’re getting a rush of signups and can’t send another confirmation email just yet. Tap “Continue with Google” below to get in instantly — or try email signup again in about an hour.';
    }
    if (/failed to fetch|load failed|network/i.test(message)) {
      return 'Network hiccup — that didn’t go through. Check your connection and tap Create account again.';
    }
    return message;
  }

  async function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        // Email-confirmation redirect target. Supabase appends the
        // exchange `code` query param so /auth/callback can exchange it
        // for a session.
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(onboardingNext)}`,
      },
    });
    setLoading(false);

    if (signUpError) {
      reportSignupFailure(email.trim().toLowerCase(), signUpError.message);
      setError(friendlyAuthError(signUpError.message));
      return;
    }
    // If Supabase has email-confirmation ON, data.session is null and
    // data.user has an unconfirmed identity. If OFF (unlikely in prod),
    // data.session is populated and we can route immediately.
    if (data.session) {
      router.push(onboardingNext);
      router.refresh();
      return;
    }
    setEmailSent(true);
  }

  async function onGoogle() {
    setError(null);
    setOauthLoading('google');
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    callbackUrl.searchParams.set('next', onboardingNext);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl.toString() },
    });
    if (oauthError) {
      setOauthLoading(null);
      setError(oauthError.message);
    }
    // On success we're navigated to Google; no further code runs here.
  }

  async function onApple() {
    setError(null);
    setOauthLoading('apple');
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    callbackUrl.searchParams.set('next', onboardingNext);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: callbackUrl.toString() },
    });
    if (oauthError) {
      setOauthLoading(null);
      // Soft-fail until the Apple web Services ID + secret are configured in
      // Supabase (the provider returns "not enabled" until then).
      setError(
        /not enabled|unsupported provider/i.test(oauthError.message)
          ? 'Apple sign-in isn’t available yet — use Google or email for now.'
          : oauthError.message,
      );
    }
  }

  // ── Confirmation state ───────────────────────────────────────────────
  if (emailSent) {
    return (
      <main
        style={{
          padding: '6rem 1.5rem 4rem',
          maxWidth: 520,
          margin: '0 auto',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#9993;&#65039;</div>
        <h1
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            fontWeight: 900,
            letterSpacing: -1,
            margin: '0 0 1rem',
          }}
        >
          Check your inbox.
        </h1>
        <p
          style={{
            color: 'var(--fg-muted)',
            fontSize: '1rem',
            lineHeight: 1.7,
            marginBottom: '2rem',
          }}
        >
          We sent a confirmation link to <strong style={{ color: 'var(--fg)' }}>{email}</strong>.
          Click the link to finish creating your account.
        </p>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13, lineHeight: 1.6 }}>
          Didn&apos;t get it? Check your spam folder, or{' '}
          <button
            type="button"
            onClick={() => {
              setEmailSent(false);
              setPassword('');
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--accent)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            try a different email
          </button>
          .
        </p>
      </main>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────
  return (
    <main style={{ padding: '4rem 1.5rem 6rem', maxWidth: 480, margin: '0 auto' }}>
      <Link
        href="/"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to BinGo Auctions
      </Link>

      <h1
        style={{
          fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
          fontWeight: 900,
          letterSpacing: -1,
          lineHeight: 1.15,
          margin: '0 0 0.5rem',
        }}
      >
        Sign up to bid
      </h1>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: '1rem',
          lineHeight: 1.65,
          margin: '0 0 2rem',
        }}
      >
        One account works across every BinGo Auctions auction.
      </p>

      <form onSubmit={onEmailSubmit} style={{ display: 'grid', gap: '0.75rem' }}>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={inputStyle}
          />
        </Field>

        <Field label="Password (8+ characters)">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={inputStyle}
          />
        </Field>

        {error && (
          <div
            style={{
              color: 'var(--danger)',
              fontSize: 14,
              background: 'rgba(255, 59, 59, 0.08)',
              border: '1px solid rgba(255, 59, 59, 0.4)',
              padding: '0.75rem 1rem',
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !!oauthLoading}
          className="btn-primary"
          style={{
            padding: '0.85rem',
            fontSize: '1rem',
            marginTop: '0.5rem',
            opacity: loading ? 0.7 : 1,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      {/* OR divider */}
      <div
        style={{
          margin: '1.5rem 0 1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          color: 'var(--fg-dim)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 2,
        }}
      >
        <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
        <span>OR</span>
        <span style={{ flex: 1, borderTop: '1px solid var(--border)' }} />
      </div>

      {/* Google */}
      <button
        type="button"
        onClick={onGoogle}
        disabled={loading || !!oauthLoading}
        style={{
          width: '100%',
          padding: '0.85rem',
          background: '#fff',
          color: '#1f1f1f',
          border: '1px solid var(--border)',
          borderRadius: 6,
          cursor: oauthLoading ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          fontWeight: 500,
          fontSize: 15,
        }}
      >
        <span aria-hidden style={{ fontSize: 18, fontWeight: 700, color: '#4285f4' }}>
          G
        </span>
        {oauthLoading === 'google' ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>

      {/* Apple — provider-agnostic /auth/callback handles the exchange. Soft-
          fails until the Apple web Services ID + secret are configured in
          Supabase (see the config checklist). */}
      <button
        type="button"
        onClick={onApple}
        disabled={loading || !!oauthLoading}
        style={{
          width: '100%',
          marginTop: '0.6rem',
          padding: '0.85rem',
          background: '#000',
          color: '#fff',
          border: '1px solid #000',
          borderRadius: 6,
          cursor: oauthLoading ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          fontWeight: 500,
          fontSize: 15,
        }}
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 384 512" fill="#fff">
          <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
        </svg>
        {oauthLoading === 'apple' ? 'Redirecting…' : 'Continue with Apple'}
      </button>

      <div
        style={{
          marginTop: '2.5rem',
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
        Already have an account?{' '}
        <Link href="/login" style={{ color: 'var(--accent)' }}>
          Sign in
        </Link>
      </div>

      <p
        style={{
          marginTop: '1.5rem',
          fontSize: 11,
          color: 'var(--fg-dim)',
          lineHeight: 1.5,
          textAlign: 'center',
        }}
      >
        By creating an account you agree to our{' '}
        <Link href="/legal/terms" style={{ color: 'var(--fg-muted)' }}>
          Terms
        </Link>
        ,{' '}
        <Link href="/legal/privacy" style={{ color: 'var(--fg-muted)' }}>
          Privacy Policy
        </Link>
        , and the{' '}
        <Link href="/legal/bidder-agreement" style={{ color: 'var(--fg-muted)' }}>
          Bidder Agreement
        </Link>
        . You&apos;ll confirm these again on the next step.
      </p>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '0.7rem 0.85rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 6,
  fontSize: 15,
  fontFamily: 'inherit',
};

// Suspense boundary so useSearchParams() doesn't break static prerender.
// Next.js 15+ requires this for any client component that reads search
// params at the top level. Fallback renders briefly while React hydrates.
export function SignupFormClient() {
  return (
    <Suspense fallback={null}>
      <BidderSignupPageInner />
    </Suspense>
  );
}
