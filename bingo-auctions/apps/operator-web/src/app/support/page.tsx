// /support — public support contact page. Apple TestFlight + App Store
// require a support URL during external submission; this is it.

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Support',
  description: 'Contact information and help resources for BinGo Auctions bidders.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 628 }],
  },
};

export default function SupportPage() {
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
        <Link href="/" style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>
          ← Home
        </Link>
      </nav>

      <h1 style={{ fontSize: '1.875rem', marginTop: 0 }}>Support</h1>
      <p>
        Need help with your account, an auction, or a payment? We&apos;re here.
      </p>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>Contact us</h2>
        <p>
          The fastest way to reach us is by email:
        </p>
        <p style={{ fontSize: 18, fontWeight: 600 }}>
          <a
            href="mailto:support@bingoauctions.com"
            style={{ color: 'var(--accent, #2563eb)' }}
          >
            support@bingoauctions.com
          </a>
        </p>
        <p style={{ color: 'var(--fg-muted, #57606a)', fontSize: 14 }}>
          We respond within 1 business day during weekdays.
        </p>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>Report a problem or suggest something</h2>
        <p>
          Not about a specific invoice? Tell us what broke or what would make
          this better — no account needed.
        </p>
        <p>
          <Link
            href="/support/feedback"
            style={{ color: 'var(--accent, #2563eb)', fontWeight: 600 }}
          >
            Send us feedback →
          </Link>
        </p>
      </section>

      <section style={{ marginTop: '2.5rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>Common help topics</h2>
        <ul style={{ paddingLeft: '1.5rem' }}>
          <li>
            <strong>I won a lot — when can I pick it up?</strong> Our warehouse
            will send you a pickup confirmation with the time window and
            location once your invoice is settled.
          </li>
          <li>
            <strong>I was outbid — can I bid again?</strong> Yes. Open the lot
            in the app and place a higher bid. Soft-close auctions extend by
            a few minutes when bids land in the final window.
          </li>
          <li>
            <strong>Item arrived damaged or wrong.</strong> Open a dispute
            from the lot detail screen within the dispute window. Include
            photos. Our team will respond.
          </li>
          <li>
            <strong>How do I pay for a lot I won?</strong>{' '}
            After you win, we&apos;ll send your invoice with payment
            instructions. If anything looks off, email us and we&apos;ll sort it out.
          </li>
        </ul>
      </section>

      <section
        style={{
          marginTop: '3rem',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border, #d0d7de)',
          fontSize: 13,
          color: 'var(--fg-muted, #57606a)',
        }}
      >
        <Link href="/legal/terms" style={{ color: 'var(--accent, #2563eb)' }}>
          Terms of Service
        </Link>{' '}
        ·{' '}
        <Link href="/legal/privacy" style={{ color: 'var(--accent, #2563eb)' }}>
          Privacy Policy
        </Link>{' '}
        ·{' '}
        <Link href="/legal" style={{ color: 'var(--accent, #2563eb)' }}>
          All legal docs
        </Link>
      </section>
    </div>
  );
}
