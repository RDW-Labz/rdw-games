'use client';

// VerifyPageClient — handles the POST→redirect to Stripe Identity.
//
// The server already checked auth and pre-fetched identity_verified_at.
// If the bidder is already verified this component shows a success state.
// Otherwise it shows a "Start verification" button that fires the API call,
// then does a window.location redirect to the Stripe-hosted URL.
//
// The POST goes to /api/identity/verify which reads the session via cookies
// (getSupabaseServer / verifyAuth reads the Supabase auth cookie on the
// web path — no Bearer token needed for browser requests).

import { useState } from 'react';
import Link from 'next/link';

interface Props {
  alreadyVerifiedAt: string | null;
  next: string | null;
}

export function VerifyPageClient({ alreadyVerifiedAt, next }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/identity/verify', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }
      // Redirect to Stripe Identity hosted flow. The API route's return_url
      // is /identity/return, which will receive the ?session_id= param from
      // Stripe on completion.
      const returnTarget = `/identity/return${next ? `?next=${encodeURIComponent(next)}` : ''}`;
      // We can't override the Stripe return_url client-side; we forward `next`
      // via the /identity/return page which reads it from the query string.
      // For now just redirect to the Stripe URL — Stripe will send back to
      // /identity/return as configured in the API route.
      void returnTarget; // referenced in return page, surfaced via link
      window.location.href = body.url;
    } catch (err) {
      setError((err as Error).message ?? 'Could not start verification. Please try again.');
      setBusy(false);
    }
  }

  if (alreadyVerifiedAt) {
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
          style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.5rem' }}
        >
          Identity verified
        </h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          You completed identity verification on{' '}
          {new Date(alreadyVerifiedAt).toLocaleDateString()}. You can bid on any lot without
          restriction.
        </p>
        {next ? (
          <Link
            href={next}
            style={{
              display: 'inline-block',
              padding: '0.85rem 1.5rem',
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
            Back to profile
          </Link>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem 1rem' }}>
      <h1
        style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '0.75rem' }}
      >
        Verify your identity
      </h1>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
        Bids over $500 require identity verification. We use{' '}
        <strong style={{ color: 'var(--fg)' }}>Stripe Identity</strong> — you'll take a photo of a
        government-issued ID and a quick selfie. Stripe handles the verification; we never store or
        see your ID document.
      </p>
      <p style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: '1.5rem' }}>
        Verification typically takes about 60 seconds and is a one-time requirement.
      </p>

      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 59, 59, 0.1)',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={start}
        disabled={busy}
        style={{
          width: '100%',
          padding: '1rem',
          background: 'var(--accent)',
          color: '#000',
          border: 'none',
          borderRadius: 8,
          fontSize: '1rem',
          fontWeight: 700,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? 'Starting verification…' : 'Start verification'}
      </button>

      {next && (
        <div style={{ marginTop: '1rem', textAlign: 'center' }}>
          <Link href={next} style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
            Cancel, go back
          </Link>
        </div>
      )}
    </div>
  );
}
