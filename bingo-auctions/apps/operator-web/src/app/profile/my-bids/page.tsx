// /profile/my-bids — the bidder's full bid history (browser parity with the
// mobile app's My Bids tab).
//
// The embedded "My bids" section on /profile is capped at the last 30 days
// + 20 rows. This dedicated page lifts both caps (all-time, up to 200 rows
// like the bidder app) and adds filter chips: All / Won / Leading / Outbid /
// Lost, driven by the URL search param ?f= — the SAME server-side pattern as
// /profile/past-wins.
//
// "Winning Items" is NOT a separate page: it is this page filtered to the
// live high-bidder subset, i.e. /profile/my-bids?f=leading (the same set the
// mobile app surfaces under its "Leading" pill). The nav links straight there.
//
// Classification reuse: each bid is run through classifyBid() from ../_lib/bids
// — the exact algorithm lifted from the old inline profile/page.tsx BidItem.
// The embed and this page therefore agree on leading/outbid/won/lost. Each
// row is rendered with the shared BidItem component.
//
// Server component + force-dynamic + nodejs runtime, matching the sibling
// /profile/* pages.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { describeAutoRaise, type AutoRaiseStatus } from '@auction-platform/shared';
import {
  type BidRow,
  type BidTone,
  classifyBid,
  BidItem,
} from '../_lib/bids';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Match the bidder app's my-bids.tsx cap (200). Lifts the embed's 20-row +
// 30-day window.
const PAGE_SIZE = 200;

// 'all' + the four tones. Kept as a const tuple so the URL param validation
// and the chip list stay in sync.
type FilterChip = 'all' | BidTone;
const FILTER_CHIPS: readonly FilterChip[] = ['all', 'won', 'leading', 'outbid', 'lost'];

export default async function MyBidsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/my-bids');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/my-bids');
  }

  // Same query shape as the /profile embed, minus the 30-day .gte() window
  // and with the cap raised to 200. is_auto=false keeps us to the bidder's
  // own manual bids (place_bid also inserts proxy auto-rows for the OTHER
  // bidder being raised — those aren't ours).
  const { data } = await supabase
    .from('bids')
    .select(
      'lot_id, amount_cents, max_amount_cents, placed_at, lots!lot_id(id, lot_code, title, status, current_bid_cents, close_at, winner_bidder_id)',
    )
    .eq('bidder_id', user.id)
    .eq('is_auto', false)
    .order('placed_at', { ascending: false })
    .limit(PAGE_SIZE);

  const rows = (data as unknown as BidRow[] | null) ?? [];

  // De-dupe by lot_id — multiple bids on the same lot collapse to the most
  // recent (rows are placed_at DESC, so the first seen wins). Identical to
  // the /profile embed + the bidder app.
  const seen = new Set<string>();
  const uniqueBids: BidRow[] = [];
  for (const b of rows) {
    if (seen.has(b.lot_id)) continue;
    seen.add(b.lot_id);
    uniqueBids.push(b);
  }

  // Classify each unique bid once. Rows whose joined lot is null (RLS denied
  // / deleted) are bucketed as 'lost' so the count is honest and the row
  // still renders a "Lot unavailable" placeholder — matches the bidder app.
  const classified: Array<{ row: BidRow; tone: BidTone }> = uniqueBids.map((row) => {
    const tone: BidTone = row.lots
      ? classifyBid(row.lots, row.max_amount_cents, user.id)
      : 'lost';
    return { row, tone };
  });

  const counts: Record<BidTone, number> = { leading: 0, outbid: 0, won: 0, lost: 0 };
  for (const c of classified) counts[c.tone]++;

  // BID-CONFIRM (2026-10): "We raised your bid to $X — your max is $Y" for
  // still-open lots (leading/outbid) — the customer report was "bids
  // happened on their own," which only makes sense while the lot is live.
  // Fetch her own is_auto rows for just those lots and pair each with the
  // manual representative row already in `classified` (describeAutoRaise
  // wants both — see packages/shared/src/auto-bid.ts).
  const openLotIds = classified
    .filter((c) => c.tone === 'leading' || c.tone === 'outbid')
    .map((c) => c.row.lot_id);
  const autoRaiseByLot: Record<string, AutoRaiseStatus> = {};
  if (openLotIds.length) {
    const { data: autoRows } = await supabase
      .from('bids')
      .select('lot_id, amount_cents, max_amount_cents, placed_at')
      .eq('bidder_id', user.id)
      .eq('is_auto', true)
      .in('lot_id', openLotIds);
    const autoByLotId = new Map<string, Array<{ amount_cents: number; max_amount_cents: number; placed_at: string }>>();
    for (const r of (autoRows ?? []) as Array<{
      lot_id: string;
      amount_cents: number;
      max_amount_cents: number;
      placed_at: string;
    }>) {
      const list = autoByLotId.get(r.lot_id) ?? [];
      list.push(r);
      autoByLotId.set(r.lot_id, list);
    }
    for (const c of classified) {
      if (c.tone !== 'leading' && c.tone !== 'outbid') continue;
      const autos = autoByLotId.get(c.row.lot_id) ?? [];
      autoRaiseByLot[c.row.lot_id] = describeAutoRaise([
        {
          amount_cents: c.row.amount_cents,
          max_amount_cents: c.row.max_amount_cents,
          is_auto: false,
          placed_at: c.row.placed_at,
        },
        ...autos.map((a) => ({ ...a, is_auto: true as const })),
      ]);
    }
  }

  // Resolve active chip from URL.
  const params = await searchParams;
  const chipParam = params.f ?? 'all';
  const activeChip: FilterChip = (FILTER_CHIPS as readonly string[]).includes(chipParam)
    ? (chipParam as FilterChip)
    : 'all';

  const visible =
    activeChip === 'all'
      ? classified
      : classified.filter((c) => c.tone === activeChip);

  // color  = border/badge fill when active; activeBg = panel tint when active.
  // Explicit rgba (not color-mix) to match the proven /profile/past-wins
  // chip styling and stay within the codebase's existing CSS surface.
  type ChipDef = {
    key: FilterChip;
    label: string;
    count: number;
    color: string;
    activeBg: string;
  };
  const chips: ChipDef[] = [
    { key: 'all', label: 'All', count: classified.length, color: 'var(--fg-muted)', activeBg: 'var(--bg-elev)' },
    { key: 'won', label: 'Won', count: counts.won, color: 'var(--success)', activeBg: 'rgba(34,197,94,0.1)' },
    { key: 'leading', label: 'Leading', count: counts.leading, color: 'var(--winning)', activeBg: 'rgba(255,214,10,0.1)' },
    { key: 'outbid', label: 'Outbid', count: counts.outbid, color: 'var(--danger)', activeBg: 'rgba(255,59,59,0.1)' },
    { key: 'lost', label: 'Lost', count: counts.lost, color: 'var(--fg-dim)', activeBg: 'var(--bg-elev)' },
  ];

  // The page header sub-copy adapts to the Winning (=leading) deep-link so
  // the nav entry "Winning" reads as a first-class destination, not a
  // surprise filter on "My bids".
  const isWinningView = activeChip === 'leading';

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
          {isWinningView ? 'Winning' : 'My bids'}
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          {isWinningView
            ? 'Live lots where you’re currently the high bidder.'
            : 'Every lot you’ve bid on, newest first.'}
        </div>
      </header>

      {/* Filter chips — mirrors /profile/past-wins. */}
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
          // Won + Leading draw extra attention when they have a count, so the
          // wins/live-leads pop on first paint (parity with the mobile pills).
          const highlight = (c.key === 'won' || c.key === 'leading') && c.count > 0;
          const accent = active || highlight ? c.color : 'var(--border)';
          return (
            <Link
              key={c.key}
              href={c.key === 'all' ? '/profile/my-bids' : `/profile/my-bids?f=${c.key}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 999,
                border: `${active || highlight ? 2 : 1}px solid ${accent}`,
                background: active ? c.activeBg : 'transparent',
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
                  background: c.count > 0 ? c.color : 'var(--bg-elev)',
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

      {/* Bids list */}
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
          {classified.length === 0 ? (
            <>
              You haven&apos;t placed any bids yet.{' '}
              <Link href="/browse" style={{ color: 'var(--accent)' }}>
                Find an auction
              </Link>
              .
            </>
          ) : activeChip === 'won' ? (
            'No wins yet. Lots you win show up here once their auctions close.'
          ) : activeChip === 'leading' ? (
            'No live lots where you’re the high bidder right now.'
          ) : activeChip === 'outbid' ? (
            "No live lots where you've been outbid right now."
          ) : (
            'No lost bids yet.'
          )}
        </section>
      ) : (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {visible.map((c) => (
            <BidItem
              key={c.row.lot_id}
              row={c.row}
              userId={user.id}
              autoRaise={autoRaiseByLot[c.row.lot_id]}
            />
          ))}
        </div>
      )}
    </main>
  );
}
