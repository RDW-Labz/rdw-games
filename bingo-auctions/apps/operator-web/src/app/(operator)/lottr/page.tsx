// LotTR-Pro desktop landing.
//
// Tier 1 (product_lookups cache + OpenRouter web-search fallback, AI-free
// from the operator's perspective) is the default for both UPC and keyword
// search. AI fallback (Tier 2) is invoked only when Tier 1 returns no match
// and the operator opts in.

import Link from 'next/link';
import { PageHeader } from '@/components/Form';

export default function LottrLanding() {
  // OpenRouter is the only provider we actually route through now —
  // ANTHROPIC_API_KEY referred to a legacy direct-Anthropic path
  // (packages/domain-lotting/src/ai/pricing.ts → callAnthropic) which
  // no active code path invokes. Tier 1 and Tier 2 both depend on
  // OPENROUTER_API_KEY now. One check, one variable.
  const openrouterConfigured = Boolean(process.env['OPENROUTER_API_KEY']);
  const aiConfigured = openrouterConfigured;

  return (
    <div>
      <PageHeader title="AI Lotting" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5 }}>
        Bulk classify inventory at speed. UPC scan and keyword search hit the
        platform&apos;s product cache first; misses fall through to OpenRouter
        web-search models for live retail listings and sold-comp prices. Most
        lookups return in under a second. Save selections as pending-intake lots
        that warehouse staff scan onto bins. Backed by{' '}
        <code style={{ background: 'var(--bg-elev)', padding: '2px 6px', borderRadius: 4 }}>
          @auction-platform/domain-lotting
        </code>
        .
      </p>

      {!openrouterConfigured && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255, 90, 90, 0.1)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 6,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          <strong>OPENROUTER_API_KEY is not set.</strong> Add your OpenRouter
          API key to apps/operator-web/.env.local. Until then, lookups return
          only warm cache hits (no live product data for cache misses).
        </div>
      )}

      {!aiConfigured && openrouterConfigured && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg-muted)',
            borderRadius: 6,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          <strong>AI is not configured.</strong> Set <code>OPENROUTER_API_KEY</code>{' '}
          in environment variables. Both Tier 1 (UPC + keyword lookups) and
          Tier 2 (photo classifier and AI-enrich) route through OpenRouter.
        </div>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginTop: '1.5rem',
          maxWidth: 1080,
        }}
      >
        <Card
          title="Quick Lot"
          body="No manifest, no AI. Type title + tap a condition/price preset → lot created in ~5 s. For commodity pallets and identical sealed units."
          href="/lottr/quick"
          accent="primary"
        />
        <Card
          title="Batch UPC lookup"
          body="Paste UPCs / ASINs (one per line). Cache + OpenRouter web-search return title + sold-comp prices in parallel. Pick which to save as draft lots."
          href="/lottr/batch"
          accent="primary"
        />
        <Card
          title="Keyword search"
          body="Items without a UPC: type brand + model. Cache hits show first, OpenRouter live-search fills in the rest. Tier 1, AI-free."
          href="/lottr/keyword"
          accent="primary"
        />
        <Card
          title="Manifest queue"
          body="Review pending-intake lots that came in from a CSV import. Pre-filled inline from cache when the lot has a UPC; cold rows fall back to Enrich."
          href="/lottr/queue"
          accent="primary"
        />
        <Card
          title="Photo classifier — AI fallback"
          body="Drop a folder of product photos. Bulk version of the BinGo Staff photo-scan flow. Costs ~$0.09 per call — reserve for items without scannable codes."
          disabled
        />
      </section>
    </div>
  );
}

function Card({
  title,
  body,
  href,
  disabled,
  accent,
}: {
  title: string;
  body: string;
  href?: string;
  disabled?: boolean;
  accent?: 'primary' | undefined;
}) {
  const inner = (
    <div
      style={{
        padding: '1rem 1.25rem',
        background: 'var(--bg-elev)',
        border: `1px solid ${accent === 'primary' ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
        {body}
      </div>
    </div>
  );
  if (disabled || !href) return inner;
  return (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </Link>
  );
}
