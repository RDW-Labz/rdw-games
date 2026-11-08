// /profile/watchlist — the bidder's full Watch List (browser parity with
// the mobile app's Watchlist tab).
//
// The embedded "Watchlist" section on /profile is capped at 10 rows; this
// dedicated page lifts that cap and shows every lot the bidder is still
// tracking. We mirror the /profile/past-wins skeleton (back-link, header,
// card grid, force-dynamic + nodejs runtime).
//
// Sectioning (customer report 2026-07-09, mobile browser): ended/expired
// lots used to be filtered OUT entirely, which meant there was nothing to
// remove them from — the watch list silently accumulated dead rows forever.
// Now the page shows two sections: live lots on top, then an "Ended" section
// where every row carries an explicit Remove button plus a bulk
// "Remove all" clear. We LEFT-join lots (not lots!inner) so a watchlist row
// whose lot is RLS-hidden still comes back (lots=null) and renders the
// "Lot no longer available" placeholder with a Remove button — otherwise a
// legacy/stuck lot is invisible and the bidder can't clear it.
//
// Reuses the shared WatchlistItem render component + the ended classifier
// from ../_lib/bids (same source the /profile embed uses).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import {
  type WatchlistRow,
  type WatchlistSort,
  WatchlistItem,
  isWatchlistRowEnded,
  sortWatchlistRows,
  parseWatchlistSort,
  WATCHLIST_SORTS,
} from '../_lib/bids';
import { RemoveAllEndedButton } from '../_lib/RemoveAllEndedButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Match the bidder app's my-bids cap (200) for a sane upper bound. A bidder
// with >200 active watched lots is well past any realistic UI; the embed
// already shows the most-recent 10 and this is the "everything" view.
const PAGE_SIZE = 200;

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[] }>;
}) {
  // Sort lives in the URL rather than client state: this is a server
  // component, so a ?sort= round-trip keeps it one (no client bundle just to
  // reorder a list), and the choice stays put on refresh and can be shared.
  const sort: WatchlistSort = parseWatchlistSort((await searchParams).sort);
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/watchlist');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/watchlist');
  }

  // Same query shape as the /profile embed, just without the .limit(10).
  // LEFT join (lots, not lots!inner): rows whose lot can't be joined
  // (RLS-hidden / closed-to-this-bidder) are STILL returned with lots=null,
  // so the WatchlistItem placeholder can surface them with a Remove button.
  // Using lots!inner here previously dropped those rows entirely, leaving a
  // stuck legacy item the bidder couldn't see or remove (browser-watchlist
  // bug). The visibility filter below drops ended auctions (CLOSED_STATUSES)
  // but deliberately keeps null-lot rows so they remain removable.
  const { data } = await supabase
    .from('watchlist')
    .select(
      'lot_id, created_at, lots(id, lot_code, title, status, current_bid_cents, starting_bid_cents, close_at, photo_urls)',
    )
    .eq('bidder_id', user.id)
    // Ordered by star date at the database, then re-sorted below. close_at
    // lives on the EMBEDDED lots row, and ordering an embedded column is not
    // something PostgREST does reliably across versions — but the result set is
    // capped at PAGE_SIZE and sorting it in memory is free at that size.
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  const all = (data as unknown as WatchlistRow[] | null) ?? [];
  // Ended = closed-ish status OR close time passed. Null-lot rows classify
  // as NOT ended so they land in the live section, where their placeholder
  // row already carries its own Remove button.
  const ended = all.filter(isWatchlistRowEnded);
  // Live lots honour the chosen sort. The Ended section stays newest-first:
  // "which of my dead rows closes soonest" is not a question anyone has, and
  // that section exists to be cleared, not browsed.
  const visible = sortWatchlistRows(
    all.filter((row) => !isWatchlistRowEnded(row)),
    sort,
  );
  const endedLotIds = ended.map((row) => row.lot_id);

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
          Watch list
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          {visible.length === 0
            ? 'Lots you star show up here while their auctions are live.'
            : `${visible.length} lot${visible.length === 1 ? '' : 's'} you’re tracking right now.`}
        </div>
      </header>

      {/* Sort control. Plain links, so it works before any JS loads and each
          order is its own URL. Only earns its space once there are two lots to
          put in an order. */}
      {visible.length > 1 ? (
        <nav
          aria-label="Sort watch list"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginBottom: '1rem',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-dim)', marginRight: 2 }}>Sort</span>
          {WATCHLIST_SORTS.map((opt) => {
            const active = opt.value === sort;
            return (
              <Link
                key={opt.value}
                href={`/profile/watchlist?sort=${opt.value}`}
                aria-current={active ? 'true' : undefined}
                style={{
                  fontSize: 13,
                  fontWeight: active ? 800 : 500,
                  padding: '0.35rem 0.75rem',
                  borderRadius: 999,
                  textDecoration: 'none',
                  border: '1px solid var(--border)',
                  background: active ? 'var(--accent)' : 'var(--bg-elev-2)',
                  color: active ? '#000' : 'var(--fg-muted)',
                }}
              >
                {opt.label}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {/* Watchlist grid */}
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
          {ended.length > 0
            ? 'No live lots on your watch list right now.'
            : "You haven't added any lots to your watchlist yet."}{' '}
          <Link href="/browse" style={{ color: 'var(--accent)' }}>
            Browse auctions
          </Link>{' '}
          and tap the star on any lot.
        </section>
      ) : (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {visible.map((row) => (
            <WatchlistItem key={row.lot_id} row={row} />
          ))}
        </div>
      )}

      {/* Ended auctions — removable rows + bulk clear */}
      {ended.length > 0 ? (
        <section style={{ marginTop: '2.5rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              marginBottom: '0.75rem',
            }}
          >
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Ended</h2>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                {ended.length} lot{ended.length === 1 ? '' : 's'} whose auction is over.
              </div>
            </div>
            <RemoveAllEndedButton lotIds={endedLotIds} />
          </div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {ended.map((row) => (
              <WatchlistItem key={row.lot_id} row={row} withRemove />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
