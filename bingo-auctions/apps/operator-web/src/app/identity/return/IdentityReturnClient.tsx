'use client';

// IdentityReturnClient — polls bidders.identity_verified_at after the
// Stripe Identity redirect returns to /identity/return.
//
// The Stripe webhook is authoritative; the column may not be set yet when
// Stripe redirects back (network latency between Stripe → our webhook).
// We poll for up to ~30s (10 attempts × 3s) before giving up and showing
// a "pending" state with support contact.
//
// Uses the Supabase browser client so the session cookie is included
// automatically (no Bearer token needed for browser→Next.js→Supabase).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 10;

interface Props {
  userId: string | null;
  initialVerifiedAt: string | null;
  next: string | null;
}

type PollState = 'polling' | 'verified' | 'pending' | 'no_session';

export function IdentityReturnClient({ userId, initialVerifiedAt, next }: Props) {
  const [verifiedAt, setVerifiedAt] = useState<string | null>(initialVerifiedAt);
  const [pollState, setPollState] = useState<PollState>(
    !userId ? 'no_session' : initialVerifiedAt ? 'verified' : 'polling',
  );
  const attemptsRef = useRef(0);

  useEffect(() => {
    // Already verified at page load (webhook fired before redirect).
    if (verifiedAt) {
      setPollState('verified');
      return;
    }
    // No session — can't poll.
    if (!userId) {
      setPollState('no_session');
      return;
    }

    const supabase = getSupabaseBrowser();

    const timer = setInterval(async () => {
      attemptsRef.current += 1;
      const { data } = await supabase
        .from('bidders')
        .select('identity_verified_at')
        .eq('id', userId)
        .maybeSingle();
      const va = (data?.identity_verified_at as string | null) ?? null;
      if (va) {
        setVerifiedAt(va);
        setPollState('verified');
        clearInterval(timer);
        return;
      }
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        setPollState('pending');
        clearInterval(timer);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
    // Only runs on mount — userId + initialVerifiedAt are stable after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pollState === 'no_session') {
    return (
      <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem 1rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.75rem' }}>
          Session expired
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Please sign in again to check your verification status.
        </p>
        <Link
          href="/login?next=/identity/return"
          style={{
            display: 'inline-block',
            padding: '0.85rem 1.5rem',
            background: 'var(--accent)',
            color: '#000',
            borderRadius: 8,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (pollState === 'polling') {
    return (
      <div
        style={{
          maxWidth: 480,
          margin: '4rem auto',
          padding: '2rem 1rem',
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
            margin: '0 auto 1.25rem',
            animation: 'spin 0.9s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.5rem' }}>
          Confirming verification…
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          Waiting for Stripe to confirm your identity. This usually takes a few seconds.
        </p>
      </div>
    );
  }

  if (pollState === 'verified' && verifiedAt) {
    return (
      <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem 1rem' }}>
        <p
          style={{
            fontSize: 13,
            color: 'var(--success)',
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: 0.8,
            marginBottom: '0.5rem',
          }}
        >
          Verified
        </p>
        <h1
          style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.75rem' }}
        >
          Identity confirmed
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Your identity was verified on {new Date(verifiedAt).toLocaleDateString()}. You can now
          bid on any lot without restriction.
        </p>
        {next ? (
          <Link
            href={next}
            style={{
              display: 'inline-block',
              padding: '0.9rem 1.75rem',
              background: 'var(--accent)',
              color: '#000',
              borderRadius: 8,
              fontWeight: 700,
              textDecoration: 'none',
              fontSize: 15,
            }}
          >
            Back to lot
          </Link>
        ) : (
          <Link
            href="/profile"
            style={{
              display: 'inline-block',
              padding: '0.85rem 1.5rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              borderRadius: 8,
              fontWeight: 600,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Go to profile
          </Link>
        )}
      </div>
    );
  }

  // pollState === 'pending' — webhook didn't arrive in time.
  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem 1rem' }}>
      <p
        style={{
          fontSize: 13,
          color: 'var(--warning)',
          fontWeight: 900,
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          marginBottom: '0.5rem',
        }}
      >
        Verification pending
      </p>
      <h1
        style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.75rem' }}
      >
        Still processing
      </h1>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '0.75rem' }}>
        Stripe is still reviewing your documents. This can take a few minutes. You'll receive a
        notification once verification is complete.
      </p>
      <p style={{ fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
        If you don't hear back within 10 minutes, contact{' '}
        <a
          href="mailto:support@bingoauctions.com"
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          support@bingoauctions.com
        </a>
        .
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {next && (
          <Link
            href={next}
            style={{
              padding: '0.85rem 1.5rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              borderRadius: 8,
              fontWeight: 600,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Back to lot
          </Link>
        )}
        <Link
          href="/profile"
          style={{
            padding: '0.85rem 1.5rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            borderRadius: 8,
            fontWeight: 600,
            textDecoration: 'none',
            fontSize: 14,
          }}
        >
          Go to profile
        </Link>
      </div>
    </div>
  );
}
