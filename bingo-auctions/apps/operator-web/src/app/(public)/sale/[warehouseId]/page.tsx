import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { describeWarehousePickup, type WarehousePickupSource } from '@/lib/warehouse-pickup';
import { PublicAuctionCard, type PublicAuctionCardRow } from '../../_components/PublicAuctionCard';

export const runtime = 'nodejs';
export const revalidate = 60;

const MAX_W = 1100;

type WarehouseRow = Record<string, unknown> & { id: string };

type AuctionQueryRow = Omit<PublicAuctionCardRow, 'lot_count'> & { operator_id: string };

async function loadWarehouse(id: string): Promise<WarehouseRow | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('warehouses').select('*').eq('id', id).maybeSingle();
    if (error || !data) return null;
    return data as WarehouseRow;
  } catch {
    return null;
  }
}

async function loadWarehouseAuctions(warehouseId: string): Promise<PublicAuctionCardRow[]> {
  const supabase = getSupabaseAdmin();
  const demoExclude = demoExclusionList(await getDemoOperatorIds());

  let auctionQuery = supabase
    .from('auctions')
    .select(
      'id, title, status, starts_at, ends_at, last_lot_ends_at, featured_image_urls, operator_id, warehouses(timezone)',
    )
    .eq('warehouse_id', warehouseId)
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) auctionQuery = auctionQuery.not('operator_id', 'in', demoExclude);

  const { data, error } = await auctionQuery
    .order('last_lot_ends_at', { ascending: true, nullsFirst: false })
    .order('ends_at', { ascending: true, nullsFirst: false });

  if (error) return [];

  const rows = (data ?? []) as AuctionQueryRow[];
  const auctionIds = rows.map((a) => a.id);
  let lotCounts: Record<string, number> = {};
  if (auctionIds.length) {
    const counts = await Promise.all(
      auctionIds.map((aid) =>
        supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .eq('auction_id', aid)
          .is('deleted_at', null)
          .then((res) => [aid, res.count ?? 0] as const),
      ),
    );
    lotCounts = Object.fromEntries(counts);
  }

  return rows.map((a) => ({ ...a, lot_count: lotCounts[a.id] ?? 0 }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ warehouseId: string }>;
}): Promise<Metadata> {
  const { warehouseId } = await params;
  const row = await loadWarehouse(warehouseId);
  const pickup = describeWarehousePickup(row as WarehousePickupSource | null);
  if (!pickup.isOffsite || (row?.active as boolean | undefined) === false) {
    return { title: 'Sale' };
  }
  const title = pickup.name ? `${pickup.name} Sale` : 'Sale';
  return { title: { absolute: `${title} — BinGo Auctions` } };
}

export default async function OffsiteSalePage({
  params,
}: {
  params: Promise<{ warehouseId: string }>;
}) {
  const { warehouseId } = await params;
  const warehouse = await loadWarehouse(warehouseId);
  const pickup = describeWarehousePickup(warehouse as WarehousePickupSource | null);
  if (!warehouse || !pickup.isOffsite || (warehouse.active as boolean | undefined) === false) {
    notFound();
  }

  const auctions = await loadWarehouseAuctions(warehouseId);

  return (
    <div style={{ padding: '3rem 1.5rem 5rem', background: 'var(--bg)', color: 'var(--fg)' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <section
          style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '1.25rem 1.5rem',
            marginBottom: '2rem',
          }}
        >
          <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.25rem)', fontWeight: 900, margin: '0 0 0.75rem' }}>
            {pickup.name ?? 'Sale'}
          </h1>
          {pickup.notice && (
            <p style={{ fontWeight: 700, margin: '0 0 1rem', lineHeight: 1.5 }}>{pickup.notice}</p>
          )}
          {pickup.fullAddress && (
            <p style={{ margin: '0 0 0.75rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              {pickup.fullAddress}
            </p>
          )}
          {pickup.directionsUrl && (
            <p style={{ margin: '0 0 1rem' }}>
              <a
                href={pickup.directionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', fontWeight: 700, textDecoration: 'none' }}
              >
                Get directions
              </a>
            </p>
          )}
          {pickup.hoursLines.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  color: 'var(--fg-muted)',
                  marginBottom: 4,
                }}
              >
                Pickup hours
              </div>
              {pickup.hoursLines.map((line) => (
                <div key={line} style={{ fontSize: 14, lineHeight: 1.45 }}>{line}</div>
              ))}
            </div>
          )}
          {pickup.instructions && (
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'var(--fg-muted)' }}>
              {pickup.instructions}
            </p>
          )}
        </section>

        <h2 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: '1.25rem' }}>Auctions</h2>

        {auctions.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No auctions are open at this location right now.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '1.25rem',
            }}
          >
            {auctions.map((auction) => (
              <PublicAuctionCard key={auction.id} auction={auction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
