/**
 * RecentWins — horizontally-scrolling row of anonymized recent winning
 * invoices, MAC.BID-style social proof.
 *
 * Renders nothing when there is no qualifying data; we never show a
 * "no wins yet" empty state — that's bad social proof.
 *
 * Privacy contract (ENFORCED in loadRecentWins):
 *   - Never select bidder email, display_name, phone, or any free-form
 *     user-provided text.
 *   - Never select bidder_id (could be correlated with public lot bid
 *     history to deanonymize).
 *   - Lot title IS public (visible on /lot/[code] anyway), so showing it
 *     here doesn't leak anything new.
 *   - No bidder state — `bidders` has no state/address column, so we
 *     don't fake one. The card just says "Verified bidder" + savings.
 *
 * Service role is required because the (public) homepage is unauth and
 * `invoices` RLS limits reads to operator_users or bidder_self
 * (migration 0002). Service role is constrained by selecting ONLY the
 * columns we surface; nothing in this function returns email-equivalent
 * data to the client.
 *
 * Performance: one round-trip pulls 200 paid invoices joined with a
 * lightweight invoice_lots->lots projection. We then aggregate in JS
 * (no N+1) and cap at 12 cards. With the existing
 * invoices_status_idx + invoice_lots_lot_idx + invoices_bidder_idx
 * this runs in well under 100ms against typical volumes; on an empty
 * table it returns instantly.
 */

import Link from 'next/link';
import type React from 'react';
import { formatCents } from '@auction-platform/shared/money';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds } from '@/lib/demo-operators';

// ── Types ────────────────────────────────────────────────────────────────────

/** Shape returned by the Supabase select — the join brings invoice_lots
 *  back as a nested array per invoice, and each invoice_lot brings its lot
 *  back as a nested object. */
interface InvoiceWithLotsRow {
  id: string;
  paid_at: string | null;
  invoice_lots: Array<{
    winning_bid_cents: number;
    lots: {
      lot_code: string | null;
      title: string | null;
      msrp_cents: number | null;
      // auction_id is public (on every public lot) and carries no bidder
      // identity — used only to drop demo-operator wins from this rail (H4-c).
      auction_id: string | null;
    } | null;
  }> | null;
}

/** The presentational shape consumed by the card. Intentionally narrow —
 *  nothing here can identify the bidder. */
interface RecentWin {
  invoiceId: string;
  paidAt: string;
  savingsCents: number;
  representativeTitle: string;
  /** Code of the representative lot — links the card to its public
   *  /lot/[code] page. Public data (already in the sitemap + on every
   *  LotCard); carries no bidder identity. Null when the representative
   *  lot has no code, in which case the card renders unlinked. */
  representativeLotCode: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_W = 1100;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CARDS = 12;
const INVOICE_QUERY_LIMIT = 200;

// ── Data fetch ───────────────────────────────────────────────────────────────

/** Pulls up to 12 recent paid invoices in the last 7 days that have a
 *  positive aggregate savings (sum(msrp) > sum(winning_bid)). Returns
 *  the empty array on any error or absence of data — the consumer
 *  decides to omit the section. */
export async function loadRecentWins(): Promise<RecentWin[]> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  try {
    const supabase = getSupabaseAdmin();

    // H4-c: resolve the demo operators' auction IDs so demo wins never appear
    // as social proof on the public homepage. The invoices→invoice_lots→lots
    // chain has no operator_id, so we resolve demo operators → their auctions
    // and drop any invoice that references a lot from one of those auctions.
    // Mirrors the demo exclusion used across the public web loaders
    // ((public)/browse/page.tsx etc.); fail-safe — an empty set excludes
    // nothing, so the rail still renders.
    const demoOperatorIds = await getDemoOperatorIds();
    const demoAuctionIds = new Set<string>();
    if (demoOperatorIds.length > 0) {
      const { data: demoAuctions } = await supabase
        .from('auctions')
        .select('id')
        .in('operator_id', demoOperatorIds);
      for (const a of (demoAuctions ?? []) as Array<{ id: string }>) {
        demoAuctionIds.add(a.id);
      }
    }
    // 0242: unlisted (link-only) test auctions join the exclusion set — real
    // money, but deliberately invisible, so their wins are not social proof.
    {
      const { data: unlistedAuctions } = await supabase
        .from('auctions')
        .select('id')
        .eq('unlisted', true);
      for (const a of (unlistedAuctions ?? []) as Array<{ id: string }>) {
        demoAuctionIds.add(a.id);
      }
    }

    // IMPORTANT: column list is exhaustively explicit. Do not add
    // bidder_id, email, or any other identifiable column without
    // updating the privacy contract above.
    // lots.lot_code is public (sitemap + every LotCard already expose it)
    // and carries no bidder identity — it only links the card to the
    // representative lot's public /lot/[code] page. lots.auction_id is
    // likewise public and is used only to drop demo-operator wins (H4-c).
    const { data, error } = await supabase
      .from('invoices')
      .select(
        'id, paid_at, invoice_lots(winning_bid_cents, lots(lot_code, title, msrp_cents, auction_id))',
      )
      .eq('status', 'paid')
      .gte('paid_at', since)
      .order('paid_at', { ascending: false })
      .limit(INVOICE_QUERY_LIMIT);

    if (error || !data) return [];

    const rows = data as unknown as InvoiceWithLotsRow[];
    const wins: RecentWin[] = [];

    for (const row of rows) {
      if (!row.paid_at) continue;
      const lots = row.invoice_lots ?? [];
      if (lots.length === 0) continue;

      // Skip any invoice that references a demo-operator lot — the demo auction
      // carries paid fixtures so reviewers always have history, but they must
      // never surface as public "Recent wins" social proof.
      if (
        demoAuctionIds.size > 0 &&
        lots.some((il) => il.lots?.auction_id != null && demoAuctionIds.has(il.lots.auction_id))
      ) {
        continue;
      }

      let msrpSum = 0;
      let winSum = 0;
      // Pick a "representative" lot — the one with the largest absolute
      // savings, so the headline matches the dollar figure.
      let bestTitle: string | null = null;
      let bestLotCode: string | null = null;
      let bestLotSavings = -Infinity;

      for (const il of lots) {
        const win = il.winning_bid_cents ?? 0;
        const msrp = il.lots?.msrp_cents ?? 0;
        msrpSum += msrp;
        winSum += win;

        const lotSavings = msrp - win;
        if (
          il.lots?.title &&
          msrp > 0 &&
          lotSavings > 0 &&
          lotSavings > bestLotSavings
        ) {
          bestLotSavings = lotSavings;
          bestTitle = il.lots.title;
          bestLotCode = il.lots.lot_code ?? null;
        }
      }

      const savings = msrpSum - winSum;
      if (savings <= 0 || !bestTitle) continue;

      wins.push({
        invoiceId: row.id,
        paidAt: row.paid_at,
        savingsCents: savings,
        representativeTitle: bestTitle,
        representativeLotCode: bestLotCode,
      });
      if (wins.length >= MAX_CARDS) break;
    }

    return wins;
  } catch {
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Human-friendly "2h ago" / "3d ago" / "just now" style label. */
function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'recent';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Truncate the lot title to a single short line for the card. */
function truncateTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  return title.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// ── Component ────────────────────────────────────────────────────────────────

interface RecentWinsProps {
  wins: RecentWin[];
}

export function RecentWins({ wins }: RecentWinsProps) {
  if (wins.length === 0) return null;

  return (
    <section
      aria-label="Recent winning bidders"
      style={{
        padding: '3rem 1.25rem 2rem',
        background: 'var(--bg)',
      }}
    >
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '0.4rem',
          }}
        >
          <h2
            style={{
              fontSize: 'clamp(1.25rem, 3vw, 1.75rem)',
              fontWeight: 900,
              letterSpacing: -0.8,
              margin: 0,
            }}
          >
            Recent wins
          </h2>
          <Link
            href="/browse"
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            Browse all auctions &rarr;
          </Link>
        </div>

        <p
          style={{
            margin: '0 0 1.25rem',
            fontSize: 13,
            color: 'var(--fg-muted)',
          }}
        >
          Real bidders, real savings &mdash; last 7 days.
        </p>

        {/* Horizontal scroller. -mx to bleed to the section edge so cards
            scroll off-screen cleanly on mobile. */}
        <div
          className="recent-wins-row"
          style={{
            display: 'flex',
            gap: 12,
            overflowX: 'auto',
            scrollSnapType: 'x mandatory',
            paddingBottom: 8,
            // Hide the ugly default scrollbar on most browsers; touch
            // scroll on mobile is the primary interaction anyway.
            scrollbarWidth: 'thin',
          }}
        >
          {wins.map((w) => (
            <WinCard key={w.invoiceId} win={w} />
          ))}
        </div>
      </div>

      <style>{`
        .recent-wins-row::-webkit-scrollbar { height: 6px; }
        .recent-wins-row::-webkit-scrollbar-thumb {
          background: var(--border); border-radius: 3px;
        }
      `}</style>
    </section>
  );
}

// ── Win card ───────────────────────────────────────────────────────────────────
//
// One social-proof card. When the representative lot has a code we wrap the card
// in a Link to its public /lot/[code] page (the card was previously
// non-interactive); otherwise we render the same card as a plain <article> so we
// never emit a broken `/lot/null` link. The wrapper element carries the flex /
// scroll-snap positioning either way so the visual is byte-for-byte identical
// between the linked and unlinked variants.

const WIN_CARD_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  width: 200,
  height: 120,
  background: 'var(--accent-dim)',
  border: '1px solid var(--accent)',
  borderRadius: 10,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  scrollSnapAlign: 'start',
};

function WinCard({ win }: { win: RecentWin }) {
  const body = (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'var(--accent)',
        }}
      >
        <span aria-hidden style={{ fontSize: 14 }}>{'\u{1F3C6}'}</span>
        Verified bidder
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 900,
          letterSpacing: -0.8,
          color: 'var(--fg)',
          lineHeight: 1.1,
        }}
      >
        Saved {formatCents(win.savingsCents)}
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          lineHeight: 1.3,
          flex: 1,
          // Single-line clamp via overflow — keeps the 120px
          // card height predictable across long titles.
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={win.representativeTitle}
      >
        on {truncateTitle(win.representativeTitle, 40)}
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-dim)',
          fontStyle: 'italic',
        }}
      >
        {formatRelativeTime(win.paidAt)}
      </div>
    </>
  );

  if (win.representativeLotCode) {
    return (
      <Link
        href={`/lot/${win.representativeLotCode}`}
        aria-label={`View lot — saved ${formatCents(win.savingsCents)} on ${win.representativeTitle}`}
        style={{ ...WIN_CARD_STYLE, textDecoration: 'none', color: 'inherit' }}
      >
        {body}
      </Link>
    );
  }

  return <article style={WIN_CARD_STYLE}>{body}</article>;
}
