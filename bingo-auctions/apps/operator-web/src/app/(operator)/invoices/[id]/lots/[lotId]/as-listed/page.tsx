// "As listed" — read-only, staff-only view of a sold lot exactly as it was
// advertised: title, description, condition, photos, the auction it sold in
// and what it hammered for. Opened from the invoice detail page by clicking
// a lot line.
//
// `lotId` is invoice_lots.lot_id for THIS invoice — the exact lot row that
// sold. A relist always mints a brand-new lots row (relisted_from_lot_id
// points back at the source), so this never needs to walk lineage to find
// "the lot that sold": it's always the id already on the invoice line. The
// page 404s if that (invoiceId, lotId) pair isn't a real invoice line, so a
// guessed URL can't be used to browse arbitrary lots.
//
// No edit affordances anywhere on this page — read-only by construction.
// See src/lib/lot-as-listed.ts for exactly what the "edited after sale" note
// can and cannot detect (there is no snapshot-at-sale-time or content-edit
// audit trail today).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { lotDisplayCode } from '@auction-platform/shared';
import { formatCents } from '@auction-platform/shared/money';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { invoiceHref } from '@/lib/console-links';
import { resolveLotAsListedSnapshot, lotConditionLabel } from '@/lib/lot-as-listed';
import { PhotoGalleryClient } from '@/app/(public)/lot/[code]/PhotoGalleryClient';

export default async function LotAsListedPage({
  params,
}: {
  params: Promise<{ id: string; lotId: string }>;
}) {
  const { id: invoiceId, lotId } = await params;
  const supabase = await getSupabaseServer();

  const { data: invoice } = await supabase
    .from('invoices')
    .select('id, paid_at, auctions(title)')
    .eq('id', invoiceId)
    .single();
  if (!invoice) notFound();

  // Confirms this lot actually sold on THIS invoice — not just any lot id.
  const { data: line } = await supabase
    .from('invoice_lots')
    .select('lot_id, winning_bid_cents')
    .eq('invoice_id', invoiceId)
    .eq('lot_id', lotId)
    .maybeSingle();
  if (!line) notFound();

  const { data: lot } = await supabase
    .from('lots')
    .select('id, title, description, condition, photo_urls, lot_code, sticker_code, display_code, updated_at')
    .eq('id', lotId)
    .maybeSingle();
  if (!lot) notFound();

  const auction = Array.isArray(invoice.auctions) ? invoice.auctions[0] : invoice.auctions;
  const auctionTitle = (auction as { title?: string } | null)?.title ?? null;

  const snapshot = resolveLotAsListedSnapshot(
    {
      title: lot.title as string,
      description: (lot.description as string | null) ?? null,
      condition: (lot.condition as string | null) ?? null,
      photoUrls: (lot.photo_urls as string[] | null) ?? [],
      lotUpdatedAt: (lot.updated_at as string | null) ?? null,
    },
    { paidAt: (invoice.paid_at as string | null) ?? null },
  );

  const code =
    lotDisplayCode({
      lot_code: lot.lot_code as string | null,
      sticker_code: lot.sticker_code as string | null,
      display_code: lot.display_code as string | null,
    }) ?? (lot.lot_code as string | null);

  const condLabel = lotConditionLabel(snapshot.condition);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <PageHeader title="As listed" />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: '-0.75rem' }}>
        Read-only — exactly as advertised when this lot sold.
      </p>
      <p style={{ marginBottom: '1rem' }}>
        <Link href={invoiceHref(invoiceId)} style={{ color: 'var(--accent)' }}>
          ← Back to invoice
        </Link>
      </p>

      <PhotoGalleryClient photos={snapshot.photoUrls} title={snapshot.title} />

      <div style={{ marginTop: '1.25rem', display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ fontSize: '1.4rem', margin: 0 }}>{snapshot.title}</h2>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {code && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-dim)', fontSize: 13 }}>
              {code}
            </span>
          )}
          {condLabel && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 10px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'var(--bg-elev)',
              }}
            >
              {condLabel}
            </span>
          )}
        </div>

        {snapshot.description && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {snapshot.description}
          </p>
        )}

        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.85rem 1rem',
            display: 'grid',
            gap: 4,
          }}
        >
          {auctionTitle && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sold in: {auctionTitle}</span>
          )}
          <span style={{ fontSize: '1.1rem', fontWeight: 700 }}>
            {formatCents(line.winning_bid_cents as number)}
          </span>
        </div>

        {/* No "edited after sale" warning: lots.updated_at moves for many
            unrelated reasons (load backfill 0437 touched ~17k lots on 10-24,
            bin moves, status changes), so it would fire on most lots. */}
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Shows this lot&apos;s current text and photos. Edits made after the sale aren&apos;t tracked.
        </div>
      </div>
    </div>
  );
}
