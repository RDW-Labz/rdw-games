// Public-facing legal layout. NOT auth-gated — Apple TestFlight + App
// Store reviewers, plus any random bidder, must be able to read these
// without signing in. The middleware already exempts /legal via its
// public-route allowlist.

import Link from 'next/link';
import type { ReactNode } from 'react';

export default function LegalLayout({ children }: { children: ReactNode }) {
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
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <Link href="/" style={linkStyle}>← Home</Link>
        <span style={{ color: 'var(--fg-muted, #8b949e)' }}>·</span>
        <Link href="/legal/terms" style={linkStyle}>Terms</Link>
        <Link href="/legal/privacy" style={linkStyle}>Privacy</Link>
        <Link href="/legal/bidder-agreement" style={linkStyle}>Bidder Agreement</Link>
        <Link href="/legal/operator-agreement" style={linkStyle}>Operator Agreement</Link>
        <Link href="/support" style={linkStyle}>Support</Link>
      </nav>
      {children}
    </div>
  );
}

const linkStyle = {
  color: 'var(--accent, #2563eb)',
  textDecoration: 'none',
};
