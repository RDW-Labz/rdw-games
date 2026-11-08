'use client';

/**
 * Route-level error boundary.
 *
 * Next.js renders this when a server component throws or a route handler
 * 500s within a non-root segment. The `reset` prop, when called, re-mounts
 * the failing segment so the user can retry without a full reload. The
 * `error.digest` field is a server-generated hash that lets ops cross-
 * reference user reports against Cloudflare Worker logs.
 *
 * Must be a Client Component — Next.js requirement so the boundary can hold
 * state and re-render after `reset()`.
 */

import Link from 'next/link';
import { useEffect } from 'react';

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Surface the failure in the browser console — useful when bisecting
    // a regression locally. Production logs flow through Cloudflare's
    // Worker tail, keyed by error.digest.
    console.error('[BinGo Auctions] route error boundary caught:', error);
  }, [error]);

  return (
    <div
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4rem 1.5rem',
      }}
    >
      <div style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: 3,
            textTransform: 'uppercase',
            color: 'var(--danger)',
            marginBottom: '1rem',
          }}
        >
          Error
        </div>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 900,
            letterSpacing: -0.5,
            margin: '0 0 1rem',
          }}
        >
          Something went wrong.
        </h1>
        <p
          style={{
            fontSize: '1.05rem',
            color: 'var(--fg-muted)',
            lineHeight: 1.55,
            margin: '0 0 2rem',
          }}
        >
          We&apos;ve logged the error. Try refreshing, or head back to browse.
        </p>

        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginBottom: '1.5rem',
          }}
        >
          <button
            type="button"
            onClick={() => reset()}
            className="btn-primary"
            style={{ border: 'none', cursor: 'pointer' }}
          >
            Try again
          </button>
          <Link href="/" className="btn-secondary">
            Back to home
          </Link>
        </div>

        {error.digest ? (
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-dim)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              marginTop: '1rem',
            }}
          >
            Reference: {error.digest}
          </div>
        ) : null}
      </div>
    </div>
  );
}
