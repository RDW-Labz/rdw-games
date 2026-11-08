import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { formatInTimeZone, warehouseTimezone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { StatusPill } from '@/components/console';
import { ResolveDisputeForm } from './ResolveDisputeForm';

export default async function DisputeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data: d } = await supabase
    .from('disputes')
    .select(
      'id, status, reason, bidder_photo_urls, resolution_notes, refund_cents, created_at, resolved_at, lot_id, invoice_id, bidder_id, lots(title, photo_urls, current_bid_cents, warehouses(timezone)), bidders(email, display_name), invoices(total_cents, status)',
    )
    .eq('id', id)
    .single();
  if (!d) notFound();

  const lot = (d as { lots?: { title?: string; photo_urls?: string[]; current_bid_cents?: number } }).lots;
  // Dispute timestamps render in the disputed lot's warehouse zone.
  const tz = warehouseTimezone(
    (d as { lots?: { warehouses?: unknown } }).lots?.warehouses,
  );
  const b = (d as { bidders?: { email?: string; display_name?: string | null } }).bidders;
  const inv = (d as { invoices?: { total_cents?: number; status?: string } }).invoices;
  const photos = (d.bidder_photo_urls as string[]) ?? [];

  const closed = d.status !== 'open';

  return (
    <div>
      <PageHeader title={`Dispute · ${(d.id as string).slice(0, 8)}`} />
      <p style={{ color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>
          {b?.display_name ?? b?.email ?? 'Bidder'} · {formatInTimeZone(d.created_at as string, tz)}
        </span>
        <StatusPill status={d.status as string} />
      </p>

      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          marginTop: '1rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1rem',
        }}
      >
        <Stat label="Lot" value={lot?.title ?? '—'} link={`/lots/${d.lot_id}`} />
        <Stat
          label="Winning bid"
          value={lot?.current_bid_cents != null ? formatCents(lot.current_bid_cents) : '—'}
        />
        <Stat
          label="Invoice"
          value={inv?.total_cents != null ? `${formatCents(inv.total_cents)} (${inv.status})` : '—'}
          link={`/invoices/${d.invoice_id}`}
        />
      </section>

      <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Bidder&apos;s reason</h2>
      <p style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-elev)', padding: '1rem', borderRadius: 6 }}>
        {d.reason as string}
      </p>

      <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Bidder&apos;s photos ({photos.length})</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
        {photos.map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer">
            <Image
              src={url}
              alt="Dispute evidence"
              width={160}
              height={160}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
          </a>
        ))}
      </div>

      {(lot?.photo_urls?.length ?? 0) > 0 && (
        <>
          <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Original listing photos</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            {(lot!.photo_urls ?? []).map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                <Image
                  src={url}
                  alt="Listing photo"
                  width={160}
                  height={160}
                  style={{ objectFit: 'cover', borderRadius: 6 }}
                />
              </a>
            ))}
          </div>
        </>
      )}

      {!closed ? (
        <section style={{ marginTop: '2rem' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Resolve</h2>
          <ResolveDisputeForm
            disputeId={d.id as string}
            invoiceId={d.invoice_id as string}
            maxRefundCents={(inv?.total_cents as number | undefined) ?? 0}
          />
        </section>
      ) : (
        <section
          style={{
            marginTop: '2rem',
            padding: '1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, textTransform: 'uppercase' }}>
            Resolution
          </div>
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusPill status={d.status as string} />
            <span>{d.resolved_at ? formatInTimeZone(d.resolved_at as string, tz) : '—'}</span>
          </div>
          {(d.refund_cents as number) > 0 && (
            <div style={{ color: 'var(--success)', marginTop: 4 }}>
              Refunded {formatCents(d.refund_cents as number)}
            </div>
          )}
          {d.resolution_notes && (
            <p style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--fg-muted)' }}>
              {d.resolution_notes as string}
            </p>
          )}
        </section>
      )}

      <p style={{ marginTop: '2rem', fontSize: 13 }}>
        <Link href="/disputes">← Back to disputes</Link>
      </p>
    </div>
  );
}

function Stat({ label, value, link }: { label: string; value: string; link?: string }) {
  const inner = (
    <div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 14 }}>{value}</div>
    </div>
  );
  if (link) return <Link href={link}>{inner}</Link>;
  return inner;
}
