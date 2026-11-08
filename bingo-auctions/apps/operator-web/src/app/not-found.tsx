/**
 * Branded 404 page — bingoauctions.com/<missing>
 *
 * Renders when Next.js can't match a route. App Router applies this file at
 * the root, so it covers every non-(public) tree too. We inline a minimal nav
 * + footer here instead of relying on (public)/layout.tsx because not-found
 * pages don't go through route-group layouts in Next 16 — wrapping the page
 * in the public chrome requires owning it directly.
 *
 * Tone: treasure-hunt — "that lot's already on someone's truck." Calmly
 * routes the visitor back to /browse (primary) or / (secondary).
 */

import Link from 'next/link';
import type { Metadata } from 'next';

const MAX_W = 1100;

export const metadata: Metadata = {
  title: { absolute: '404 — Page not found | BinGo Auctions' },
  description:
    "We couldn't find what you were looking for. Maybe it sold.",
};

export default function NotFound() {
  return (
    <div style={{ background: 'var(--bg)', color: 'var(--fg)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MinimalNav />

      <main
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4rem 1.5rem',
        }}
      >
        <div
          style={{
            maxWidth: 560,
            width: '100%',
            textAlign: 'center',
          }}
        >
          <img
            src="/art/not-found-404.webp"
            alt=""
            width={320}
            height={224}
            style={{ maxWidth: '100%', height: 'auto', marginBottom: '1.5rem' }}
          />
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              marginBottom: '1rem',
            }}
          >
            404
          </div>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: 900,
              letterSpacing: -0.5,
              margin: '0 0 1rem',
            }}
          >
            404 &mdash; Page not found
          </h1>
          <p
            style={{
              fontSize: '1.05rem',
              color: 'var(--fg-muted)',
              lineHeight: 1.55,
              margin: '0 0 0.75rem',
            }}
          >
            We couldn&apos;t find what you were looking for. Maybe it sold.
          </p>
          <p
            style={{
              fontSize: 14,
              color: 'var(--fg-dim)',
              lineHeight: 1.55,
              margin: '0 0 2rem',
              fontStyle: 'italic',
            }}
          >
            Looks like that lot&apos;s already on someone&apos;s truck. Try the live ones.
          </p>

          <div
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Link href="/browse" className="btn-primary">
              Browse auctions
            </Link>
            <Link href="/" className="btn-secondary">
              Back to home
            </Link>
          </div>
        </div>
      </main>

      <MinimalFooter />
    </div>
  );
}

function MinimalNav() {
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(10, 12, 17, 0.92)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 1.5rem',
      }}
    >
      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 56,
        }}
      >
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
          }}
        >
          <img src="/icon.png" alt="" width={28} height={28} style={{ borderRadius: 6 }} />
          <span
            style={{
              fontWeight: 900,
              fontSize: '1.1rem',
              color: 'var(--fg)',
              letterSpacing: -0.5,
            }}
          >
            BinGo Auctions
          </span>
        </Link>

        <nav style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', fontSize: 14, fontWeight: 500 }}>
          <Link href="/browse" style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
            Auctions
          </Link>
          <Link href="/support" style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
            Support
          </Link>
        </nav>
      </div>
    </header>
  );
}

function MinimalFooter() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        padding: '1.5rem',
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          fontSize: 12,
          color: 'var(--fg-dim)',
        }}
      >
        <span>&copy; 2026 BinGo Auctions. All rights reserved.</span>
        <span>US-only service</span>
      </div>
    </footer>
  );
}
