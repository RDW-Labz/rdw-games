// Public legal document renderer.
//
// URLs:
//   /legal/terms              → legal/terms.md
//   /legal/privacy            → legal/privacy.md
//   /legal/bidder-agreement   → legal/bidder-agreement.md
//   /legal/operator-agreement → legal/operator-agreement.md
//   /legal/dmca-policy        → legal/dmca-policy.md
//   /legal/prohibited-items   → legal/prohibited-items.md
//
// Anything else 404s. Allowlisted in the slug match below so a path
// like /legal/../../etc/passwd can't escape.
//
// Markdown content is bundled into the Worker at build time via
// scripts/generate-legal-content.mjs (runs as a prebuild + precf:build
// hook). At runtime we look up the slug in LEGAL_CONTENT — no fs access,
// works identically on Node and Cloudflare Workers.
//
// Publish gate: documents are only rendered when policy_versions.published=TRUE
// for that slug. Until lawyer review is complete all docs stay at
// published=FALSE and return 404. Flip the flag via a service-role SQL update
// once the doc is cleared for public release.
//
// Version + effective date is displayed at the top of each published doc.

import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { LEGAL_CONTENT } from './_content.generated';

const TITLES = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  'bidder-agreement': 'Bidder Agreement',
  'dmca-policy': 'DMCA Policy',
  'prohibited-items': 'Prohibited Items',
} as const;

type Slug = keyof typeof TITLES;

function isAllowedSlug(s: string): s is Slug {
  return Object.prototype.hasOwnProperty.call(TITLES, s);
}

/** Fetch the published version row for this slug from policy_versions. */
async function getPublishedVersion(
  slug: string,
): Promise<{ version: number; effective_at: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data } = await supabase
    .from('policy_versions')
    .select('version, effective_at')
    .eq('slug', slug)
    .eq('published', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}

const DESCRIPTIONS: Record<Slug, string> = {
  terms: 'Read the BinGo Auctions Terms of Service governing your use of our auctions, website, and apps.',
  privacy: 'Read the BinGo Auctions Privacy Policy to understand how we collect, use, and protect your information.',
  'bidder-agreement': 'Read the BinGo Auctions Bidder Agreement covering bidding rules, payment obligations, and pickup requirements.',
  'dmca-policy': 'Read the BinGo Auctions DMCA Policy for reporting copyright infringement.',
  'prohibited-items': 'Review the categories of items BinGo Auctions does not auction or sell.',
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isAllowedSlug(slug)) return { title: 'Not found' };
  return {
    title: TITLES[slug],
    description: DESCRIPTIONS[slug],
    openGraph: {
      images: [{ url: '/og-default.png', width: 1200, height: 628 }],
    },
  };
}

export default async function LegalDocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isAllowedSlug(slug)) notFound();

  // Only serve published documents
  const published = await getPublishedVersion(slug);
  if (!published) notFound();

  const content = LEGAL_CONTENT[slug];
  if (!content) notFound();

  const effectiveDate = new Date(published.effective_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <article className="legal-doc">
      {/* Version + effective date banner */}
      <div
        style={{
          marginBottom: '1.5rem',
          padding: '0.75rem 1rem',
          background: 'var(--bg-elev, #f6f8fa)',
          borderRadius: 6,
          fontSize: 13,
          color: 'var(--fg-muted, #57606a)',
          display: 'flex',
          gap: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <strong>Version:</strong> {published.version}
        </span>
        <span>
          <strong>Effective:</strong> {effectiveDate}
        </span>
      </div>

      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1
              style={{
                fontSize: '1.875rem',
                marginTop: 0,
                marginBottom: '1.5rem',
              }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              style={{
                fontSize: '1.25rem',
                marginTop: '2rem',
                marginBottom: '0.5rem',
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              style={{
                fontSize: '1.05rem',
                marginTop: '1.5rem',
                marginBottom: '0.25rem',
              }}
            >
              {children}
            </h3>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              style={{
                color: 'var(--accent, #2563eb)',
                textDecoration: 'underline',
              }}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul style={{ paddingLeft: '1.5rem', marginTop: '0.5rem' }}>
              {children}
            </ul>
          ),
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: '3px solid var(--accent, #2563eb)',
                paddingLeft: '1rem',
                margin: '1rem 0',
                color: 'var(--fg-muted, #57606a)',
                fontStyle: 'italic',
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code
              style={{
                background: 'var(--bg-elev, #f6f8fa)',
                padding: '0.1em 0.3em',
                borderRadius: 3,
                fontSize: '0.9em',
                fontFamily:
                  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              }}
            >
              {children}
            </code>
          ),
          hr: () => (
            <hr
              style={{
                border: 'none',
                borderTop: '1px solid var(--border, #d0d7de)',
                margin: '2rem 0',
              }}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>

      <p
        style={{
          marginTop: '3rem',
          paddingTop: '1rem',
          borderTop: '1px solid var(--border, #d0d7de)',
          fontSize: 12,
          color: 'var(--fg-muted, #57606a)',
        }}
      >
        Questions? Contact{' '}
        <a href="mailto:legal@bingoauctions.com" style={{ color: 'var(--accent, #2563eb)' }}>
          legal@bingoauctions.com
        </a>
        .
      </p>
    </article>
  );
}

// Do NOT use generateStaticParams here — published status can change without
// a code deploy. Dynamic rendering ensures we check policy_versions on every
// request and serve 404 when published=FALSE.
