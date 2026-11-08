// Auction performance — the auctioneer's core report: for each recent
// auction, sell-through, gross, bids, unique bidders, and MSRP recovery.
// Answers "how did last night's auction do?" and drives relist/buying
// decisions. Data via operator_auction_performance() (mig 0225) — one
// staff-gated SECURITY DEFINER RPC, one round-trip.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatInTimeZone, dayRangeInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { ReportDateRange } from '@/components/ReportDateRange';
import { parseReportRange } from '@/lib/report-range';
import { AuctionPerfTable, type AuctionPerfRow } from './AuctionPerfTable';

export const dynamic = 'force-dynamic';

type AuctionPerf = {
  id: string;
  title: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  lots_total: number;
  sold: number;
  unsold: number;
  still_open: number;
  gross_cents: number;
  /** 0287: paid lots whose item came back (no-show / forfeit / carried over). */
  returned_lots: number;
  /** 0287: paid lots whose invoice line was refunded. */
  refunded_lots: number;
  /** 0287: hammer on refunded lines — money returned, excluded from gross. */
  refunded_cents: number;
  /** 0240: running hammer on still-open lots with ≥1 bid. */
  open_hammer_cents: number;
  /** 0240: count of those lots — AUR denominator alongside sold. */
  open_bid_lots: number;
  bids: number;
  unique_bidders: number;
  msrp_sold_cents: number;
};

export default async function AuctionPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { from, to } = parseReportRange(sp);
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  const operatorId = (me as { operator_id: string }).operator_id;

  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  // 0289: honours the shared date filter, anchored on the auction's close.
  // No range = last 30 auctions (unchanged default).
  const range = from && to ? dayRangeInTimeZone(from, to, tz) : null;
  const { data, error } = await supabase.rpc('operator_auction_performance', {
    p_from: range?.startISO ?? null,
    p_to: range?.endISO ?? null,
  });
  const perf = ((data as AuctionPerf[] | null) ?? []).filter(Boolean);

  const rows: AuctionPerfRow[] = perf.map((a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    endsLabel: formatInTimeZone(a.ends_at, tz, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    endsAt: a.ends_at,
    lots: a.lots_total,
    sold: a.sold,
    unsold: a.unsold,
    open: a.still_open,
    bids: a.bids,
    bidders: a.unique_bidders,
    grossCents: a.gross_cents,
    returnedLots: a.returned_lots ?? 0,
    refundedLots: a.refunded_lots ?? 0,
    refundedCents: a.refunded_cents ?? 0,
    liveHammerCents: a.open_hammer_cents ?? 0,
    openBidLots: a.open_bid_lots ?? 0,
    msrpSoldCents: a.msrp_sold_cents,
  }));

  return (
    <div>
      <PageHeader title="Auction performance" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 880 }}>
        {from && to ? `Auctions closing ${from} → ${to}. ` : 'Last 30 auctions, newest first. '}
        <strong>Gross is hammer actually paid,
        net of refunds</strong> — it excludes buyer&apos;s premium and sales tax,
        so it will read lower than a Square total. Sell-through counts only
        decided lots (sold vs. never-sold); recovery is gross ÷ MSRP of sold
        lots. For the full money picture — premium, tax, refunds, Square fees and
        deposits — see{' '}
        <Link href="/reports/money" style={{ color: 'var(--accent)' }}>
          Money &amp; Square reconciliation
        </Link>
        . Live pipeline health is on{' '}
        <Link href="/reports/health" style={{ color: 'var(--accent)' }}>
          Operations health
        </Link>
        .
      </p>
      <div
        style={{
          padding: '0.7rem 0.9rem',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          maxWidth: 880,
          marginBottom: '1rem',
          fontSize: 12.5,
          color: 'var(--fg-muted)',
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>Changed 2026-07-24:</strong> these
        figures used to be derived from each lot&apos;s <em>current</em> status,
        so a closed auction&apos;s revenue moved for days afterward — refunds were
        never subtracted, unpaid winners still counted, and a no-show quietly
        erased a paid sale. Gross now comes from paid invoice lines, so a closed
        auction stops changing. <strong style={{ color: 'var(--fg)' }}>Returned</strong>{' '}
        and <strong style={{ color: 'var(--fg)' }}>Refunded</strong> below show
        the movement that used to be hidden.
      </div>

      {error && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Couldn&apos;t load auction performance: {error.message}
        </div>
      )}

      <ReportDateRange
        from={from}
        to={to}
        hint="Filters by when each auction closed (ends_at), in your warehouse timezone."
      />

      <AuctionPerfTable rows={rows} />
    </div>
  );
}
