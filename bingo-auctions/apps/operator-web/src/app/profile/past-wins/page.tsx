// /profile/past-wins — bidder's wins across all closed auctions.
//
// Server component: reads lots.winner_bidder_id = me, joined via
// invoice_lots → invoices (status + pickups). Status is computed from
// those two fields — no migration needed.
//
// Status enum (computed):
//   paid_pickedup        invoice='paid' + pickup='completed'
//   paid_awaiting        invoice='paid' + pickup IN ('pending','scheduled')
//   paid_no_show         invoice='paid' + pickup='no_show'
//   unpaid_card_declined invoice IN ('payment_failed_grace','payment_failed_relisted','unpaid_no_show')
//   unpaid_pending       invoice='pending' or no invoice yet
//   refunded             invoice IN ('refunded','partially_refunded')
//   forfeited            pickup='forfeited'
//
// RLS note: refund_jobs has no bidder-read policy — refunded state is
// surfaced via invoice.status ('refunded'/'partially_refunded') instead.
//
// Filter chips: All / Picked up / Awaiting pickup / Issues (URL search param ?f=)
// Sort: most recent win first (close_at DESC). Page size 50.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { lotDisplayCode } from '@auction-platform/shared';
import { formatDateInTimeZone, DEFAULT_TIME_ZONE } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type WinStatus =
  | 'paid_pickedup'
  | 'paid_awaiting'
  | 'paid_no_show'
  | 'unpaid_card_declined'
  | 'unpaid_pending'
  | 'refunded'
  | 'forfeited';

type FilterChip = 'all' | 'paid' | 'awaiting' | 'issues';

interface WinRow {
  lot_id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  lot_title: string;
  auction_title: string | null;
  close_at: string | null;
  /** IANA timezone of the auction's warehouse; null when unavailable. */
  warehouse_tz: string | null;
  winning_bid_cents: number | null;
  invoice_id: string | null;
  invoice_status: string | null;
  pickup_id: string | null;
  pickup_status: string | null;
  status: WinStatus;
}

interface RawLot {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  close_at: string | null;
  auction_id: string | null;
  auctions: { id: string; title: string | null; warehouses: { timezone: string | null } | null } | null;
  invoice_lots: Array<{
    winning_bid_cents: number;
    invoices: {
      id: string;
      status: string;
      pickups: Array<{ id: string; status: string }> | { id: string; status: string } | null;
    } | null;
  }> | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function computeStatus(
  invoiceStatus: string | null,
  pickupStatus: string | null,
): WinStatus {
  if (pickupStatus === 'forfeited') return 'forfeited';
  if (invoiceStatus === 'refunded' || invoiceStatus === 'partially_refunded') return 'refunded';
  if (
    invoiceStatus === 'payment_failed_grace' ||
    invoiceStatus === 'payment_failed_relisted' ||
    invoiceStatus === 'unpaid_no_show'
  ) {
    return 'unpaid_card_declined';
  }
  if (invoiceStatus === 'paid') {
    if (pickupStatus === 'completed') return 'paid_pickedup';
    if (pickupStatus === 'no_show') return 'paid_no_show';
    return 'paid_awaiting';
  }
  return 'unpaid_pending';
}

interface PillStyle {
  label: string;
  bg: string;
  fg: string;
}

function statusPill(s: WinStatus): PillStyle {
  switch (s) {
    case 'paid_pickedup':
      return {
        label: 'Paid · Picked up',
        bg: 'var(--success-dim)',
        fg: 'var(--success)',
      };
    case 'paid_awaiting':
      return {
        label: 'Paid · Awaiting pickup',
        bg: 'var(--warning-dim)',
        fg: 'var(--warning)',
      };
    case 'paid_no_show':
      return {
        label: 'Paid · No-show',
        bg: 'var(--warning-dim)',
        fg: 'var(--warning)',
      };
    case 'unpaid_card_declined':
      return {
        label: 'Unpaid · Card declined',
        bg: 'rgba(255, 59, 59, 0.12)',
        fg: 'var(--danger)',
      };
    case 'unpaid_pending':
      return {
        label: 'Unpaid · Pending',
        bg: 'var(--warning-dim)',
        fg: 'var(--warning)',
      };
    case 'refunded':
      return {
        label: 'Refunded',
        bg: 'var(--accent-dim)',
        fg: 'var(--accent)',
      };
    case 'forfeited':
      return {
        label: 'Forfeited',
        bg: 'rgba(255, 59, 59, 0.08)',
        fg: 'var(--danger)',
      };
  }
}

function matchesChip(s: WinStatus, chip: FilterChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'paid') return s === 'paid_pickedup';
  if (chip === 'awaiting') return s === 'paid_awaiting' || s === 'paid_no_show';
  if (chip === 'issues') {
    return (
      s === 'unpaid_card_declined' ||
      s === 'unpaid_pending' ||
      s === 'refunded' ||
      s === 'forfeited'
    );
  }
  return true;
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function PastWinsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/past-wins');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/past-wins');
  }

  // Fetch won lots joined to invoice_lots → invoices → pickups.
  // winner_bidder_id = me filters to only won lots.
  // RLS on invoice_lots/invoices/pickups auto-scopes to the caller.
  const { data: rawData } = await supabase
    .from('lots')
    .select(
      `id, lot_code, sticker_code, display_code, title, close_at, auction_id,
       auctions(id, title, warehouses(timezone)),
       invoice_lots(
         winning_bid_cents,
         invoices(
           id, status,
           pickups(id, status)
         )
       )`,
    )
    .eq('winner_bidder_id', user.id)
    .not('close_at', 'is', null)
    .order('close_at', { ascending: false })
    .limit(PAGE_SIZE);

  const now = Date.now();
  const allWins: WinRow[] = [];

  for (const raw of (rawData as unknown as RawLot[] | null) ?? []) {
    // Skip lots whose close_at is in the future (defensive).
    const closeAtMs = raw.close_at ? new Date(raw.close_at).getTime() : 0;
    if (closeAtMs > now) continue;

    const il = raw.invoice_lots?.[0] ?? null;
    const inv = il?.invoices ?? null;
    // pickups is UNIQUE on invoice_id → PostgREST returns it as a to-one
    // object, not an array. Reading [0] on the object yielded undefined →
    // null status → every completed pickup mis-showed as "Awaiting pickup"
    // (tester 2026-07-01). Normalize both shapes (matches my-bids.tsx / queue.tsx).
    const pickup = (Array.isArray(inv?.pickups) ? inv?.pickups[0] : inv?.pickups) ?? null;

    const invoiceStatus = inv?.status ?? null;
    const pickupStatus = pickup?.status ?? null;

    // Normalise warehouses embed (supabase-js may return array or object).
    const whEmbed = raw.auctions?.warehouses;
    const warehouseTz: string | null = Array.isArray(whEmbed)
      ? (whEmbed[0]?.timezone ?? null)
      : (whEmbed?.timezone ?? null);

    allWins.push({
      lot_id: raw.id,
      lot_code: raw.lot_code,
      sticker_code: raw.sticker_code,
      display_code: raw.display_code,
      lot_title: raw.title,
      auction_title: raw.auctions?.title ?? null,
      close_at: raw.close_at,
      warehouse_tz: warehouseTz,
      winning_bid_cents: il?.winning_bid_cents ?? null,
      invoice_id: inv?.id ?? null,
      invoice_status: invoiceStatus,
      pickup_id: pickup?.id ?? null,
      pickup_status: pickupStatus,
      status: computeStatus(invoiceStatus, pickupStatus),
    });
  }

  // Resolve active filter chip from URL param.
  const params = await searchParams;
  const chipParam = params.f ?? 'all';
  const activeChip: FilterChip = ['all', 'paid', 'awaiting', 'issues'].includes(chipParam)
    ? (chipParam as FilterChip)
    : 'all';

  const visible = allWins.filter((w) => matchesChip(w.status, activeChip));

  // Badge counts for chips.
  const countAll = allWins.length;
  const countPaid = allWins.filter((w) => w.status === 'paid_pickedup').length;
  const countAwaiting = allWins.filter(
    (w) => w.status === 'paid_awaiting' || w.status === 'paid_no_show',
  ).length;
  const countIssues = allWins.filter((w) => matchesChip(w.status, 'issues')).length;

  type ChipDef = { key: FilterChip; label: string; count: number };
  const chips: ChipDef[] = [
    { key: 'all', label: 'All', count: countAll },
    // "Picked up", NOT "Paid": counts paid_pickedup only. Labeling it "Paid"
    // made paid-but-not-picked-up customers see "Paid 0" and read it as "never
    // paid" (customer report, 2026-07-13). Paid-ness shows on each card +
    // the Awaiting chip, so it's never hidden.
    { key: 'paid', label: 'Picked up', count: countPaid },
    { key: 'awaiting', label: 'Awaiting pickup', count: countAwaiting },
    { key: 'issues', label: 'Issues', count: countIssues },
  ];

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 900, margin: '0 auto' }}>
      {/* Back link */}
      <Link
        href="/profile"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to profile
      </Link>

      {/* Page header */}
      <header style={{ marginBottom: '2rem' }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: 2,
            marginBottom: 4,
          }}
        >
          Account
        </div>
        <h1
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            fontWeight: 900,
            letterSpacing: -1,
            margin: 0,
          }}
        >
          Past wins
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          Every lot you&apos;ve won, sorted by most recent auction.
        </div>
      </header>

      {/* Filter chips */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '1.5rem',
        }}
      >
        {chips.map((c) => {
          const active = activeChip === c.key;
          const highlight = c.key === 'issues' && countIssues > 0;
          return (
            <Link
              key={c.key}
              href={c.key === 'all' ? '/profile/past-wins' : `/profile/past-wins?f=${c.key}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 999,
                border: `${active || highlight ? 2 : 1}px solid ${
                  active || highlight ? (c.key === 'issues' ? 'var(--danger)' : c.key === 'awaiting' ? 'var(--warning)' : c.key === 'paid' ? 'var(--success)' : 'var(--fg-muted)') : 'var(--border)'
                }`,
                background: active
                  ? c.key === 'issues'
                    ? 'rgba(255,59,59,0.1)'
                    : c.key === 'awaiting'
                      ? 'rgba(255,184,0,0.1)'
                      : c.key === 'paid'
                        ? 'rgba(95,224,101,0.1)'
                        : 'var(--bg-elev)'
                  : 'transparent',
                textDecoration: 'none',
                color: 'inherit',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '0.6px',
                textTransform: 'uppercase',
              }}
            >
              {c.label}
              <span
                style={{
                  display: 'inline-block',
                  minWidth: 20,
                  padding: '1px 7px',
                  borderRadius: 999,
                  background: c.count > 0 ? (
                    c.key === 'issues' ? 'var(--danger)' :
                    c.key === 'awaiting' ? 'var(--warning)' :
                    c.key === 'paid' ? 'var(--success)' :
                    'var(--fg-muted)'
                  ) : 'var(--bg-elev)',
                  color: c.count > 0 ? '#000' : 'var(--fg-dim)',
                  fontSize: 11,
                  fontWeight: 900,
                  textAlign: 'center',
                }}
              >
                {c.count}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Wins list */}
      {visible.length === 0 ? (
        <section
          style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '2rem 1.5rem',
            textAlign: 'center',
            color: 'var(--fg-muted)',
            fontSize: 14,
            lineHeight: 1.7,
          }}
        >
          {allWins.length === 0
            ? "You haven’t won any auctions yet. Win a lot and it’ll show up here."
            : activeChip === 'paid'
              ? 'No fully picked-up wins yet.'
              : activeChip === 'awaiting'
                ? 'Nothing awaiting pickup right now.'
                : 'No issues to resolve.'}
        </section>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {visible.map((win) => (
            <WinCard key={win.lot_id} win={win} />
          ))}
        </div>
      )}
    </main>
  );
}

// ─── WinCard ──────────────────────────────────────────────────────────────────

function WinCard({ win }: { win: WinRow }) {
  const pill = statusPill(win.status);

  const dateStr = win.close_at
    ? formatDateInTimeZone(win.close_at, win.warehouse_tz ?? DEFAULT_TIME_ZONE)
    : '';

  const priceLabel = win.winning_bid_cents != null
    ? formatCents(win.winning_bid_cents)
    : '—';

  const inner = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      {/* Left: lot info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            marginBottom: 2,
            fontFamily: 'monospace',
          }}
        >
          {lotDisplayCode(win) ?? win.lot_code}
        </div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {win.lot_title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
          {win.auction_title ?? 'Auction'}
          {dateStr ? ` · ${dateStr}` : ''}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 10,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              background: pill.bg,
              color: pill.fg,
              padding: '3px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {pill.label}
          </span>
        </div>
      </div>

      {/* Right: price + link hint */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--fg)' }}>
          {priceLabel}
        </div>
        {win.invoice_id && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--accent)',
              marginTop: 4,
              fontWeight: 600,
            }}
          >
            View receipt &rarr;
          </div>
        )}
      </div>
    </div>
  );

  const cardStyle: React.CSSProperties = {
    display: 'block',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '1rem 1.25rem',
    textDecoration: 'none',
    color: 'inherit',
  };

  if (win.invoice_id) {
    return (
      <Link href={`/profile/invoices/${win.invoice_id}`} style={cardStyle}>
        {inner}
      </Link>
    );
  }

  // No invoice yet — non-clickable card.
  return <div style={cardStyle}>{inner}</div>;
}
