'use client';

/**
 * Root-level error boundary.
 *
 * Renders only when the root layout itself crashes — at that point we can't
 * trust globals.css to have loaded, so styling is fully inline and we own
 * the <html> + <body> tags ourselves (Next.js requirement for global-error).
 *
 * Keep this dependency-free: no nav, no footer, no Supabase, no CSS vars.
 */

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  // Observability (PATCH-launch-readiness §4): a render of global-error means
  // the root layout itself threw — the most severe client-side failure class.
  // Report it so it isn't silent. Redaction beforeSend (sentry.client.config)
  // still scrubs secrets from the captured event.
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: '4rem 1.5rem',
          background: '#0a0c11',
          color: '#f3f4f8',
          minHeight: '100vh',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif",
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <h1
            style={{
              fontSize: '1.75rem',
              fontWeight: 900,
              letterSpacing: -0.5,
              margin: '0 0 1rem',
            }}
          >
            BinGo Auctions is having trouble.
          </h1>
          <p
            style={{
              fontSize: '1rem',
              color: '#8a93a6',
              lineHeight: 1.55,
              margin: '0 0 2rem',
            }}
          >
            Try refreshing the page.
          </p>

          <button
            type="button"
            onClick={() => reset()}
            style={{
              display: 'inline-block',
              padding: '0.75rem 1.5rem',
              background: '#22c55e',
              color: '#000',
              border: 'none',
              borderRadius: 6,
              fontWeight: 800,
              letterSpacing: '0.3px',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>

          {error.digest ? (
            <div
              style={{
                fontSize: 12,
                color: '#5a6276',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, monospace',
                marginTop: '1.5rem',
              }}
            >
              Reference: {error.digest}
            </div>
          ) : null}
        </div>
      </body>
    </html>
  );
}
