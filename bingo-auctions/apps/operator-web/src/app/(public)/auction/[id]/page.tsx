/**
 * Public auction detail — bingoauctions.com/auction/{id}
 *
 * One auction's lot grid + operator info. Server-rendered for SEO.
 *
 * Each lot card links to /lots/{lot_code} where bidders can read the full
 * detail and either bid (signed-in) or sign in / get the app (anonymous).
 *
 * For now the URL slug is the auction UUID. A future migration can add
 * auctions.slug for prettier URLs; the (id) param name supports either
 * once we add a string-vs-UUID branch.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatInTimeZone, warehouseTimezone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { publicAuctionState, NON_SELLABLE_LOT_STATUS_FILTER } from '@/lib/auction-status';
import { LotCard, type LotCardLot } from '../../_components/LotCard';
import { BrowseAutoRefresh } from '../../_components/BrowseAutoRefresh';
import { JsonLd, auctionEventJsonLd, loadPrimaryBusiness } from '@/lib/seo';
import {
  describeWarehousePickup,
  type WarehousePickupDescribed,
  type WarehousePickupSource,
} from '@/lib/warehouse-pickup';

const MAX_W = 1100;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AuctionRow = {
  id: string;
  operator_id: string;
  title: string;
  description: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  last_lot_ends_at: string | null;
  featured_image_urls: string[] | null;
  // Embedded warehouse zone (to-one via auctions.warehouse_id) so the public
  // "Ends/Opens" label renders in the auction's local time, not SSR UTC.
  warehouses: (WarehousePickupSource & { timezone: string | null }) | null;
};

// LotCardLot is imported from the shared LotCard component. The grid uses
// `lot.id` for React keys AND for the watchlist button row identity.
type LotRow = LotCardLot;

type OperatorPolicySummary = {
  businessName: string | null;
  buyerPremiumPct: number;
  pickupHoursText: string | null;
  disputeWindowDays: number;
  customTermsMd: string | null;
};

async function loadAuction(id: string): Promise<{
  auction: AuctionRow | null;
  operator: OperatorPolicySummary | null;
  lots: LotRow[];
}> {
  const supabase = getSupabaseAdmin();

  const { data: auction } = await supabase
    .from('auctions')
    .select(
      'id, operator_id, title, description, status, starts_at, ends_at, last_lot_ends_at, featured_image_urls, warehouses(*)',
    )
    .eq('id', id)
    // Public-visible auction states: scheduled (upcoming), live (open), and
    // closed (ended). Keeping `closed` here means shared links and "see the
    // results" returns render the auction + final lot state instead of a
    // 404. Genuinely-non-public states (draft / canceled) aren't in this
    // list, so maybeSingle() returns null for them → notFound below.
    .in('status', ['scheduled', 'live', 'closed'])
    .maybeSingle();

  if (!auction) return { auction: null, operator: null, lots: [] };

  const auctionRow = auction as unknown as AuctionRow;

  const [opQ, lotsQ] = await Promise.all([
    supabase
      .from('operators')
      .select(
        'business_name, default_buyer_premium_bps, pickup_hours_text, dispute_window_days, custom_terms_md',
      )
      .eq('id', auctionRow.operator_id)
      .maybeSingle(),
    supabase
      .from('lots')
      .select(
        // Preview-B: include `status` so scheduled lots render the static
        // "Upcoming" pill (LotCardLot.status) instead of a live countdown.
        'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, bid_count, close_at, condition, msrp_cents, status',
      )
      .eq('auction_id', id)
      .is('deleted_at', null) // match every other storefront lot query — never show soft-deleted lots
      // A disposed or canceled lot is not for sale. Disposal leaves auction_id
      // set, so without this the storefront advertises destroyed goods that the
      // bidder UI then refuses to take a bid on.
      .not('status', 'in', NON_SELLABLE_LOT_STATUS_FILTER)
      .order('lot_number', { ascending: true, nullsFirst: false })
      .limit(500),
  ]);

  const opRow = opQ.data as {
    business_name?: string | null;
    default_buyer_premium_bps?: number | null;
    pickup_hours_text?: string | null;
    dispute_window_days?: number | null;
    custom_terms_md?: string | null;
  } | null;

  return {
    auction: auctionRow,
    operator: opRow
      ? {
          businessName: opRow.business_name ?? null,
          buyerPremiumPct: Math.round((opRow.default_buyer_premium_bps ?? 0) / 100),
          pickupHoursText: opRow.pickup_hours_text ?? null,
          disputeWindowDays: opRow.dispute_window_days ?? 2,
          customTermsMd: opRow.custom_terms_md ?? null,
        }
      : null,
    lots: (lotsQ.data ?? []) as unknown as LotRow[],
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { auction } = await loadAuction(id);
  if (!auction) return { title: 'Auction' };
  return {
    // Bare title — the layout template appends "— BinGo Auctions".
    title: auction.title,
    description: auction.description ?? `Bid on ${auction.title} at BinGo Auctions.`,
    openGraph: {
      title: auction.title,
      description: auction.description ?? '',
      url: `https://bingoauctions.com/auction/${auction.id}`,
      siteName: 'BinGo Auctions',
      images: auction.featured_image_urls?.[0]
        ? [{ url: auction.featured_image_urls[0] }]
        : undefined,
    },
  };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { auction, operator, lots } = await loadAuction(id);

  if (!auction) {
    return (
      <div style={{ padding: '4rem 1.5rem' }}>
        <div style={{ maxWidth: MAX_W, margin: '0 auto', textAlign: 'center' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 900, marginBottom: '0.5rem' }}>
            Auction not found
          </h1>
          <p style={{ color: 'var(--fg-muted)', marginBottom: '2rem' }}>
            This auction may have closed or the link may be mistyped.
          </p>
          <Link href="/browse" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
            Browse all auctions
          </Link>
        </div>
      </div>
    );
  }

  const cover = auction.featured_image_urls?.[0];
  // Derive from the clock-gated shared state so badge + label + timestamp all
  // agree with the browse card — the lifecycle cron can flip status to 'live'
  // before starts_at actually passes.
  const state = publicAuctionState(auction);
  const isLive = state === 'live';
  // Ended auctions (status='closed') still render — we keep shared links and
  // results pages alive — but with "Ended" chrome + a banner instead of the
  // live/upcoming treatment.
  const hasEnded = state === 'ended';
  const closeTime = auction.last_lot_ends_at ?? auction.ends_at;
  // Render the Ends/Opens/Ended label in the auction's warehouse zone, not SSR UTC.
  const tz = warehouseTimezone(auction.warehouses) ?? DEFAULT_TIME_ZONE;
  // Auto-flip the badge (Upcoming→Live, then Live→Ended) without a manual reload
  // when the clock crosses the boundary — the RSC badge below is computed once at
  // request time on CF Workers, so a left-open tab went stale (reported 2026-06-19).
  const startsAtMs = auction.starts_at ? new Date(auction.starts_at).getTime() : null;
  const closeAtMs = closeTime ? new Date(closeTime).getTime() : null;

  // schema.org SaleEvent — start/end times + organizer for search engines
  // and AI crawlers. Cheap: loadPrimaryBusiness is React-cached per render.
  const biz = await loadPrimaryBusiness();
  const eventLd = auctionEventJsonLd({
    id: auction.id,
    title: auction.title,
    description: auction.description,
    startsAt: auction.starts_at,
    endsAt: closeTime,
    imageUrl: cover ?? null,
    biz,
  });

  const pickupLoc = describeWarehousePickup(auction.warehouses);

  return (
    <div style={{ padding: '0 0 5rem' }}>
      <JsonLd data={eventLd} />
      <BrowseAutoRefresh intervalMs={0} boundaries={[startsAtMs, closeAtMs]} />
      {/* Hero */}
      <section
        style={{
          background: cover
            ? `linear-gradient(180deg, rgba(10,12,17,0.55) 0%, rgba(10,12,17,0.95) 100%), url("${cover}") center / cover`
            : 'var(--bg-elev)',
          padding: '5rem 1.5rem 3rem',
        }}
      >
        <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
          <div style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: '0.75rem' }}>
            <Link href="/browse" style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
              ← All auctions
            </Link>
          </div>
          <div
            style={{
              display: 'inline-block',
              background: hasEnded
                ? 'rgba(255,255,255,0.10)'
                : isLive
                  ? 'rgba(34,197,94,0.95)'
                  : 'rgba(255,255,255,0.15)',
              color: '#fff',
              padding: '0.25rem 0.6rem',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              marginBottom: '1rem',
            }}
          >
            {hasEnded ? 'Ended' : isLive ? 'Live now' : 'Upcoming'}
          </div>
          <h1
            style={{
              fontSize: 'clamp(2rem, 5vw, 3.25rem)',
              fontWeight: 900,
              letterSpacing: -1.5,
              lineHeight: 1.1,
              marginBottom: '0.75rem',
            }}
          >
            {auction.title}
          </h1>
          {operator?.businessName && (
            <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
              Run by <strong>{operator.businessName}</strong>
            </div>
          )}
          <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
            {lots.length} lot{lots.length === 1 ? '' : 's'}
            {closeTime && (
              <>
                {' · '}
                {hasEnded ? 'Ended ' : isLive ? 'Ends ' : 'Opens '}
                {formatInTimeZone(
                  hasEnded ? closeTime : isLive ? closeTime : auction.starts_at ?? closeTime,
                  tz,
                )}
              </>
            )}
          </div>
          {auction.description && (
            <p
              style={{
                marginTop: '1.5rem',
                color: 'var(--fg-muted)',
                fontSize: 15,
                lineHeight: 1.6,
                maxWidth: 720,
              }}
            >
              {auction.description}
            </p>
          )}
        </div>
      </section>

      {pickupLoc.isOffsite && (
        <section style={{ padding: '1.25rem 1.5rem 0' }}>
          <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
            <AuctionOffsitePickupBanner pickupLoc={pickupLoc} />
          </div>
        </section>
      )}

      {/* About this operator */}
      {operator && <OperatorPoliciesSection operator={operator} pickupLoc={pickupLoc} />}

      {/* Lots grid */}
      <section style={{ padding: '3rem 1.5rem' }}>
        <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
          {/* Ended-auction banner. Closed auctions still render (shared links +
              results) but lead with a clear "this has ended" note; each lot
              card already shows its final price + a "Closed" countdown. */}
          {hasEnded && (
            <div
              style={{
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '1rem 1.25rem',
                marginBottom: '2rem',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 2 }}>
                  This auction has ended
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                  Bidding is closed. Lots below show their final results.
                </div>
              </div>
              <Link
                href="/browse"
                className="btn-primary"
                style={{ padding: '0.6rem 1.2rem', whiteSpace: 'nowrap' }}
              >
                Browse live auctions
              </Link>
            </div>
          )}

          {lots.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', textAlign: 'center', padding: '3rem 0' }}>
              No lots have been added to this auction yet.
            </div>
          ) : (
            <div
              className="lot-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: '1.25rem',
              }}
            >
              {lots.map((lot) => (
                <LotCard key={lot.id} lot={lot} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Operator policies section ───────────────────────────────────────────────
//
// Surfaces the operator's storefront-display policy snippets so bidders see
// the buyer's premium, pickup hours, dispute window, and any custom terms
// BEFORE they place a bid. Data comes from operators columns added in
// migration 0113.

function AuctionOffsitePickupBanner({ pickupLoc }: { pickupLoc: WarehousePickupDescribed }) {
  const hoursText =
    pickupLoc.hoursLines.length > 0 ? pickupLoc.hoursLines.join('\n') : null;

  return (
    <div
      style={{
        border: '1px solid var(--urgent-red)',
        background: 'rgba(255, 59, 59, 0.08)',
        borderRadius: 12,
        padding: '1.1rem 1.35rem',
      }}
    >
      {pickupLoc.notice && (
        <p style={{ margin: '0 0 0.65rem', fontSize: 15, fontWeight: 800, lineHeight: 1.45 }}>
          {pickupLoc.notice}
        </p>
      )}
      {pickupLoc.fullAddress && (
        <p style={{ margin: '0 0 0.5rem', fontSize: 14, color: 'var(--fg)', lineHeight: 1.5 }}>
          {pickupLoc.fullAddress}
        </p>
      )}
      {pickupLoc.directionsUrl && (
        <p style={{ margin: '0 0 0.65rem' }}>
          <a
            href={pickupLoc.directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}
          >
            Get directions
          </a>
        </p>
      )}
      {hoursText && (
        <p style={{ margin: '0 0 0.5rem', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--fg)' }}>Pickup hours: </strong>
          {pickupLoc.hoursLines.join(' · ')}
        </p>
      )}
      {pickupLoc.instructions && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          {pickupLoc.instructions}
        </p>
      )}
    </div>
  );
}

function OperatorPoliciesSection({
  operator,
  pickupLoc,
}: {
  operator: OperatorPolicySummary;
  pickupLoc: WarehousePickupDescribed;
}) {
  const pickupHoursDisplay =
    pickupLoc.isOffsite && pickupLoc.hoursLines.length > 0
      ? pickupLoc.hoursLines.join('\n')
      : operator.pickupHoursText;

  const hasAnyPolicy =
    operator.buyerPremiumPct > 0 ||
    pickupHoursDisplay ||
    operator.disputeWindowDays !== 0 ||
    operator.customTermsMd;
  if (!hasAnyPolicy) return null;

  return (
    <section
      style={{
        padding: '2rem 1.5rem 0',
      }}
    >
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <div
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            borderRadius: 12,
            padding: '1.25rem 1.5rem',
          }}
        >
          <h2
            style={{
              fontSize: 14,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--fg-dim)',
              margin: 0,
              marginBottom: '0.85rem',
              fontWeight: 800,
            }}
          >
            About {operator.businessName ?? 'this operator'}
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '1rem',
              marginBottom: operator.customTermsMd ? '1.25rem' : 0,
            }}
          >
            {operator.buyerPremiumPct > 0 && (
              <PolicyCell
                label="Buyer's premium"
                value={`${operator.buyerPremiumPct}%`}
                hint="Added to every winning bid"
              />
            )}
            {pickupHoursDisplay && (
              <PolicyCell label="Pickup hours" value={pickupHoursDisplay} />
            )}
            {operator.disputeWindowDays > 0 && (
              <PolicyCell
                label="Dispute window"
                value={`${operator.disputeWindowDays}-day${operator.disputeWindowDays === 1 ? '' : 's'}`}
                hint="After pickup"
              />
            )}
          </div>
          {operator.customTermsMd && (
            <details
              style={{
                marginTop: '0.25rem',
                borderTop: '1px solid var(--border)',
                paddingTop: '1rem',
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 14,
                  color: 'var(--fg)',
                  marginBottom: '0.5rem',
                }}
              >
                Read full policy
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--fg-muted)',
                  marginTop: '0.5rem',
                  marginBottom: 0,
                  background: 'transparent',
                }}
              >
                {operator.customTermsMd}
              </pre>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

function PolicyCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 1.4,
          color: 'var(--fg-dim)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 15, color: 'var(--fg)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}

