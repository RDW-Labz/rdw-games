// /privacy-choices — the advertising opt-out the privacy policy links to.
//
// Top-level and short on purpose. California requires the "do not sell or
// share" control to be conspicuous, and a link buried three levels deep in a
// legal subtree is the thing that requirement exists to prevent. It is also
// linked from the storefront footer.

import Link from 'next/link';
import type { Metadata } from 'next';
import { PrivacyChoicesForm } from './PrivacyChoicesForm';

export const metadata: Metadata = {
  title: 'Your privacy choices',
  description:
    'Opt out of sharing your information with Meta for advertising. No account needed.',
  openGraph: { images: [{ url: '/og-default.png', width: 1200, height: 628 }] },
};

export default function PrivacyChoicesPage() {
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
      <h1 style={{ marginBottom: '0.5rem' }}>Your privacy choices</h1>
      <p style={{ color: 'var(--fg-muted, #57606a)', marginTop: 0 }}>
        Do not sell or share my personal information
      </p>

      <p>
        We share a limited record of certain actions with Meta (Facebook and Instagram) so we can
        measure whether our advertising works and reach people likely to be interested in our
        auctions. Under California law this counts as <em>sharing for cross-context behavioral
        advertising</em>, and you have the right to opt out.
      </p>

      <h2 style={{ fontSize: '1.1rem', marginTop: '1.75rem' }}>What we share</h2>
      <ul>
        <li>That an account was created</li>
        <li>That a first bid was placed</li>
        <li>That an invoice was paid, and the invoice total</li>
      </ul>
      <p>
        Where your email address or phone number is included, it is hashed before it leaves our
        servers — Meta never receives them in readable form. We also pass back the identifiers
        Meta&rsquo;s own pixel set in your browser, which is what lets Meta connect a purchase to
        the advertisement you clicked; opting out erases them. We do not send Meta your bid history,
        the items you browse, your address, your IP address, or your payment details.
      </p>

      <h2 style={{ fontSize: '1.1rem', marginTop: '1.75rem' }}>Opting out</h2>
      <p>
        Opting out stops both halves: the Meta Pixel in your browser, and the information we send
        from our own servers. It also stops anything we had queued but not yet sent. It does not
        affect your account, your bids, or your ability to use BinGo in any way.
      </p>

      <PrivacyChoicesForm />

      <p style={{ marginTop: '2rem', fontSize: 14, color: 'var(--fg-muted, #57606a)' }}>
        Full detail is in our{' '}
        <Link href="/legal/privacy" style={{ color: 'var(--accent, #1f6feb)' }}>
          Privacy Policy
        </Link>
        . Questions, or want us to action this for you? Email{' '}
        <a href="mailto:privacy@bingoauctions.com" style={{ color: 'var(--accent, #1f6feb)' }}>
          privacy@bingoauctions.com
        </a>
        .
      </p>
    </div>
  );
}
