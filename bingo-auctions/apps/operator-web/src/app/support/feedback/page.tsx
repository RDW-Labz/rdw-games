// /support/feedback — public customer feedback (0327).
//
// Separate URL from the operator inbox, which owns /feedback via the
// (operator) route group. Sits under /support so it inherits that prefix's
// public access in middleware.ts and so it is one click from where customers
// already land when something goes wrong.

import Link from 'next/link';
import type { Metadata } from 'next';
import { FeedbackForm } from './FeedbackForm';

export const metadata: Metadata = {
  title: 'Send us feedback',
  description:
    'Report a problem or suggest an improvement to BinGo Auctions. No account needed.',
  openGraph: { images: [{ url: '/og-default.png', width: 1200, height: 628 }] },
};

export default function CustomerFeedbackPage() {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '2.5rem 1.5rem 4rem',
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: 'var(--fg, #0d1117)',
        lineHeight: 1.6,
      }}
    >
      <nav
        style={{
          marginBottom: '2rem',
          paddingBottom: '1rem',
          borderBottom: '1px solid var(--border, #d0d7de)',
          fontSize: 13,
        }}
      >
        <Link href="/support" style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>
          ← Support
        </Link>
      </nav>

      <h1 style={{ fontSize: '1.875rem', marginTop: 0 }}>Send us feedback</h1>
      <p>
        Something broken, confusing, or missing? Tell us here — no account
        needed, and it goes straight to the people who can fix it.
      </p>
      <p style={{ fontSize: 14, color: 'var(--fg-muted, #57606a)' }}>
        Need help with a specific invoice, payment or pickup?{' '}
        <Link href="/support" style={{ color: 'var(--accent, #2563eb)' }}>
          Contact support
        </Link>{' '}
        instead — that reaches a person who can look up your account.
      </p>

      <FeedbackForm />
    </div>
  );
}
