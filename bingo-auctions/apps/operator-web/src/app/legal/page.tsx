// /legal — index of available public legal documents.

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Legal',
  description:
    'Terms of Service, Privacy Policy, and policies for BinGo Auctions.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 628 }],
  },
};

const DOCS = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    body: 'The terms governing your use of BinGo Auctions — our auctions, website, and apps.',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    body: 'What data we collect, how we use it, who we share it with, and your rights regarding it.',
  },
  {
    slug: 'bidder-agreement',
    title: 'Bidder Agreement',
    body: 'Additional terms a bidder accepts before placing their first bid.',
  },
  {
    slug: 'dmca-policy',
    title: 'DMCA Policy',
    body: 'How to report copyright infringement. Section 512(c) takedown procedure and designated agent.',
  },
  {
    slug: 'prohibited-items',
    title: 'Prohibited Items',
    body: 'Categories of items BinGo Auctions does not auction or sell. Incorporated by reference into the Terms of Service.',
  },
];

export default function LegalIndex() {
  return (
    <>
      <h1 style={{ fontSize: '1.875rem', marginTop: 0 }}>Legal</h1>
      <p style={{ color: 'var(--fg-muted, #57606a)' }}>
        Public agreements and policies governing BinGo Auctions.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: '2rem' }}>
        {DOCS.map((d) => (
          <li
            key={d.slug}
            style={{
              padding: '1rem',
              border: '1px solid var(--border, #d0d7de)',
              borderRadius: 6,
              marginBottom: '0.75rem',
            }}
          >
            <Link
              href={`/legal/${d.slug}`}
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--accent, #2563eb)',
                textDecoration: 'none',
              }}
            >
              {d.title} →
            </Link>
            <p style={{ marginTop: 4, fontSize: 14, color: 'var(--fg-muted, #57606a)' }}>
              {d.body}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
