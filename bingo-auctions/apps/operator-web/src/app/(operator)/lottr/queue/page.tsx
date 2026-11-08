// LotTR-Pro Manifest Queue. Cross-import view of pending manifest rows
// that look thin (no MSRP). The whole point of LotTR is to fatten these
// rows up before the operator lots them into real inventory.
//
// Tier 1 auto-prefill: every row with a UPC gets a batch lookup against
// product_lookups in this server render. Cache hits are pushed to the
// client as pre-loaded candidates so the operator sees a "Review & apply"
// card immediately — no Enrich click.
//
// After enrichment, the operator goes to /imports/[id] to multi-select
// rows and lot them — that mints the lot codes and starts the intake
// flow.

import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import {
  productToCandidate,
  type LotCandidate,
  type ProductLookup,
} from '@auction-platform/domain-lotting';
import { ManifestQueue } from './ManifestQueue';

const UPC_RE = /^\d{8,14}$/;

export default async function ManifestQueuePage() {
  const supabase = await getSupabaseServer();

  // RLS scopes to the operator. Pull pending import_rows that look thin
  // (no MSRP). Cap at 200; older items page through /imports/[id].
  const { data: rowsData } = await supabase
    .from('import_rows')
    .select(
      `id, title, description, upc, external_code, msrp_cents, starting_bid_cents,
       photo_url, category_raw, condition, created_at,
       imports:imports!inner(id, filename)`,
    )
    .eq('status', 'pending')
    .or('msrp_cents.is.null,msrp_cents.eq.0')
    .order('created_at', { ascending: false })
    .limit(200);

  type Joined = {
    id: string;
    title: string;
    description: string | null;
    upc: string | null;
    external_code: string | null;
    msrp_cents: number | null;
    starting_bid_cents: number | null;
    photo_url: string | null;
    category_raw: string | null;
    condition: string | null;
    created_at: string;
    imports: { id: string; filename: string } | null;
  };

  const joined = (rowsData ?? []) as unknown as Joined[];

  // Batch-fetch product_lookups for every row with a UPC. Single
  // roundtrip — much cheaper than the per-row "Enrich" click pattern.
  const upcs = Array.from(
    new Set(
      joined
        .map((r) => (r.upc ?? r.external_code ?? '').trim())
        .filter((c) => UPC_RE.test(c)),
    ),
  );
  const prefilled: Record<string, LotCandidate> = {};
  if (upcs.length > 0) {
    const { data: lookups } = await supabase
      .from('product_lookups')
      .select('*')
      .in('upc', upcs)
      .neq('confidence', 'none');
    const byUpc = new Map<string, ProductLookup>();
    for (const row of (lookups ?? []) as ProductLookup[]) {
      byUpc.set(row.upc, row);
    }
    for (const r of joined) {
      const code = (r.upc ?? r.external_code ?? '').trim();
      if (!UPC_RE.test(code)) continue;
      const hit = byUpc.get(code);
      if (hit) prefilled[r.id] = productToCandidate(hit);
    }
  }

  // Shape we pass to the client. We flatten the joined import filename
  // for display.
  const rows = joined.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    upc: r.upc,
    external_code: r.external_code,
    msrp_cents: r.msrp_cents,
    starting_bid_cents: r.starting_bid_cents,
    photo_url: r.photo_url,
    category_raw: r.category_raw,
    condition: r.condition,
    created_at: r.created_at,
    import_filename: r.imports?.filename ?? '',
    import_id: r.imports?.id ?? '',
  }));

  const ebayConfigured = Boolean(process.env['EBAY_CLIENT_ID']);
  // AI is OpenRouter now. ANTHROPIC_API_KEY referred to a legacy
  // direct-API path (packages/domain-lotting/src/ai/pricing.ts) that
  // no active code path invokes.
  const aiConfigured = Boolean(process.env['OPENROUTER_API_KEY']);
  const prefilledCount = Object.keys(prefilled).length;

  return (
    <div>
      <PageHeader
        title="Manifest queue"
        action={
          <Link
            href="/lottr"
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            Back to AI Lotting
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5 }}>
        Pending manifest rows missing MSRP. Rows with a cached UPC match
        are pre-filled — review & apply. Rows without a cache hit show an{' '}
        <strong>Enrich</strong> button that runs a Tier 1 lookup (UPC →
        eBay; or keyword search by title). After enrichment, head to the
        manifest detail to lot rows into real inventory.
      </p>

      {prefilledCount > 0 && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.5rem 0.75rem',
            background: 'rgba(34, 211, 154, 0.08)',
            border: '1px solid var(--success, #22c55e)',
            color: 'var(--success, #22c55e)',
            borderRadius: 4,
            fontSize: 13,
            maxWidth: 720,
          }}
        >
          ✓ {prefilledCount} of {rows.length} rows pre-filled from cache.
        </div>
      )}

      {!ebayConfigured && (
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
          <strong>EBAY_CLIENT_ID is not set.</strong> Cache pre-fill still
          works for warmed UPCs, but Enrich on cold rows will return 503
          until eBay credentials are configured.
        </div>
      )}

      {!aiConfigured && ebayConfigured && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.5rem 0.75rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--fg-muted)',
            borderRadius: 4,
            fontSize: 12,
            maxWidth: 720,
          }}
        >
          AI fallback (Tier 2) disabled — no Anthropic key. Rows without a
          UPC fall back to keyword search; if nothing comes back, the
          operator enters values manually.
        </div>
      )}

      <ManifestQueue initialRows={rows} prefilled={prefilled} />
    </div>
  );
}
