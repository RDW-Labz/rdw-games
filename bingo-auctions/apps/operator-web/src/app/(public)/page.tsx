/**
 * BinGo Auctions bidder homepage — bingoauctions.com/
 *
 * Rewritten 2026-05-22 to use the new CDN asset pack.
 * Renders inside (public)/layout.tsx which provides the sticky nav (logo +
 * city picker + sign-in/up) and footer. This page owns only the content
 * between those two.
 *
 * Section order:
 *   1. HomeHero           — full-bleed CDN banner with CTA
 *   2. Category grid      — 16 DB-driven image cards, 4-col desktop / 2-col mobile
 *   3. Section banner     — How it works
 *   4. Section banner     — Daily deals / ending soon
 *   5. Section banner     — Local pickup
 *   6. App promo strip    — copy + CDN vertical art + store badges
 *
 * The ending-soon lot rail, featured-auctions grid, trust strip, and the old
 * text-only "How it works" cards from the prior page.tsx have been retired —
 * the new section banners replace them with real imagery.
 *
 * Data: categories are server-fetched from DB (migration 0114 populates CDN
 * image_url). Other sections are fully static; no extra DB queries needed.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { publicAuctionState } from '@/lib/auction-status';
import { HomeHero } from './_components/HomeHero';
import { AppPromoBanner } from './_components/AppPromoBanner';
import { RecentWins, loadRecentWins } from './_components/RecentWins';
import { getFinalCallCount } from './final-call/live-count';
import { EndingSoonRail, type HomeLotCard } from '../home-client';
import { BrowseAutoRefresh } from './_components/BrowseAutoRefresh';
import { OffsiteSaleButtons } from './_components/OffsiteSaleButtons';
import {
  JsonLd,
  organizationJsonLd,
  webSiteJsonLd,
  localBusinessJsonLd,
  loadPrimaryBusiness,
} from '@/lib/seo';
import { lotDisplayCode } from '@auction-platform/shared';

const MAX_W = 1100;

// ── Rendering + caching config ────────────────────────────────────────────────

export const runtime = 'nodejs';
// Lowered from 600 → 60: the homepage now renders a live ending-soon lot rail
// (D-C / W4), and a 10-minute ISR window would show stale prices, stale
// countdowns, and lots that have already closed. 60s keeps the rail fresh
// enough for "ending soon" while still collapsing the category/banner work
// (which changes infrequently) onto the same cheap revalidation. Picking a
// page-level revalidate over a separate cached segment is the least invasive
// change — every section already fetches inside one Promise.all below.
export const revalidate = 60;

// ── Metadata ─────────────────────────────────────────────────────────────────

// Dynamic so the title/description carry the warehouse city — that's the
// phrase local bidders actually search ("online auctions {city}", "auctions
// near me"). Falls back to the region-free copy when the lookup fails.
export async function generateMetadata(): Promise<Metadata> {
  const biz = await loadPrimaryBusiness();
  const place = biz?.address ? ` in ${biz.address.city}, ${biz.address.state}` : '';
  const title = `BinGo Auctions — Online auctions for home goods, electronics, furniture, and tools${place}`;
  const description = `Better deals. Better bids. Bid online on home goods, electronics, furniture, and tools — local pickup${place}.`;
  return {
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      url: 'https://bingoauctions.com',
      siteName: 'BinGo Auctions',
      images: [
        {
          url: '/og-default.png',
          width: 1200,
          height: 628,
          alt: 'BinGo Auctions — Online auctions',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/og-default.png'],
    },
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

type DbCategory = {
  slug: string;
  name: string;
  /** Card with the category name baked into the image (v3 dark-green pill). */
  image_url: string | null;
  /** Card WITHOUT the baked label — used when the frontend renders the name itself. */
  image_url_clean: string | null;
  icon_url: string | null;
};

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadCategories(): Promise<DbCategory[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('categories')
      .select('slug,name,image_url,image_url_clean,icon_url')
      .is('parent_id', null)
      .order('sort_order')
      .limit(16);
    if (error) return [];
    // Prefer the no-text variant for the homepage grid — the grid renders its
    // own label overlay, so the v3 card's baked-in green pill would double up.
    return ((data ?? []) as DbCategory[]).filter(
      (c) => c.image_url_clean !== null || c.image_url !== null,
    );
  } catch {
    return [];
  }
}

// ── Ending-soon lot rail data (D-C / W4) ───────────────────────────────────────
//
// Mirrors the lot query shape used by `loadLots` in (public)/browse/page.tsx —
// resolve active auction IDs first (auction status IN scheduled/live), then pull
// the storefront-visible lots in those auctions, ordered by close_at ascending so
// the soonest-closing inventory leads. We cap at 8 cards (the rail is a teaser
// row above the category fold, not a full grid — mac.bid / nellis pattern).
//
// Columns selected match the `HomeLotCard` shape that EndingSoonRail/LotCardSmall
// consume (home-client.tsx): id, lot_code, title, photo_urls, current_bid_cents,
// starting_bid_cents, msrp_cents, bid_count, close_at, condition.

const ENDING_SOON_RAIL_LIMIT = 8;

async function loadEndingSoonLots(): Promise<HomeLotCard[]> {
  try {
    const supabase = getSupabaseAdmin();

    // Active-auction gate — same gate every storefront lot query uses.
    // The bare `status IN ('scheduled','live')` is only a coarse prefilter:
    // the lifecycle cron can flip status to 'live' BEFORE starts_at passes, so
    // a lot's open-state is decided by publicAuctionState (status 'live' AND
    // starts_at elapsed), not the raw enum. We select starts_at + status here
    // so each lot can be classified live vs upcoming below.
    // H4-c: exclude demo-operator auctions so demo lots never feed the
    // ending-soon rail (mirrors (public)/browse/page.tsx).
    const demoExclude = demoExclusionList(await getDemoOperatorIds());
    let activeAuctionQuery = supabase
      .from('auctions')
      .select('id, status, starts_at')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false);
    if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
    const { data: activeAuctions } = await activeAuctionQuery;

    const activeAuctionRows = (activeAuctions ?? []) as Array<{
      id: string;
      status: string;
      starts_at: string | null;
    }>;
    const activeAuctionIds = activeAuctionRows.map((a) => a.id);
    if (activeAuctionIds.length === 0) return [];

    // Per-auction clock-gated open-state: true only when the auction reads as
    // 'live' via publicAuctionState (status 'live' AND starts_at has passed).
    const nowMs = Date.now();
    const auctionOpenById = new Map<string, boolean>(
      activeAuctionRows.map((a) => [a.id, publicAuctionState(a, nowMs) === 'live']),
    );

    const { data, error } = await supabase
      .from('lots')
      .select(
        'id, lot_code, sticker_code, display_code, title, photo_urls, current_bid_cents, starting_bid_cents, msrp_cents, bid_count, close_at, condition, status, auction_id',
      )
      .in('auction_id', activeAuctionIds)
      .in('status', ['scheduled', 'live'])
      .is('deleted_at', null)
      // Drop lots that have already closed; keep open lots + any with no
      // close_at set yet. (close_at IS NULL rows are filtered out in the
      // map below since the countdown card needs a concrete timestamp.)
      .or(`close_at.gt.${new Date().toISOString()},close_at.is.null`)
      .order('close_at', { ascending: true, nullsFirst: false })
      .limit(ENDING_SOON_RAIL_LIMIT);

    if (error) {
      console.error('[home] ending-soon rail query failed', error.message);
      return [];
    }

    type Row = {
      id: string;
      lot_code: string;
      sticker_code: string | null;
      display_code: string | null;
      title: string;
      photo_urls: string[] | null;
      current_bid_cents: number | null;
      starting_bid_cents: number | null;
      msrp_cents: number | null;
      bid_count: number | null;
      close_at: string | null;
      condition: string | null;
      status: string | null;
      auction_id: string;
    };

    const rows = (data ?? []) as Row[];

    // Map to the HomeLotCard shape. The rail's countdown needs a non-null
    // close_at, so rows without one are dropped here (they can't render a
    // meaningful "ending soon" badge). `status` + `auctionOpen` are threaded
    // through so a not-yet-open lot renders the static "Upcoming" treatment
    // (and suppresses its close_at countdown) instead of a false "Live" badge.
    return rows
      .filter((r): r is Row & { close_at: string } => r.close_at !== null)
      .map((r) => ({
        id: r.id,
        lot_code: r.lot_code,
        // Pre-stickered label wins over the internal BIN code (carryover lots
        // keep their physical sticker; tester round-7, 2026-07-04).
        display_code: lotDisplayCode(r) ?? r.lot_code,
        title: r.title,
        photo_urls: r.photo_urls,
        current_bid_cents: r.current_bid_cents,
        starting_bid_cents: r.starting_bid_cents ?? 0,
        msrp_cents: r.msrp_cents,
        bid_count: r.bid_count ?? 0,
        close_at: r.close_at,
        condition: r.condition,
        status: r.status,
        auctionOpen: auctionOpenById.get(r.auction_id) ?? false,
      }));
  } catch {
    return [];
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function BidderHomePage() {
  // Categories + ending-soon lots + recent wins + final-call count are
  // independent — fetch in parallel so the slowest one doesn't block any of
  // the others. The Final Call count is internally wrapped in `unstable_cache`
  // (15s TTL) so it's cheap regardless of how often this page revalidates.
  const [categories, endingSoonLots, recentWins, finalCallCount, biz] = await Promise.all([
    loadCategories(),
    loadEndingSoonLots(),
    loadRecentWins(),
    getFinalCallCount(),
    loadPrimaryBusiness(),
  ]);

  // Auto-refresh the ending-soon rail without a manual reload: re-render at each
  // lot's close time (a closed lot drops off precisely) plus a 60s poll for
  // price/bid freshness and the Upcoming->Live flip. RSC on CF Workers is
  // otherwise frozen at request time (reported 2026-06-19).
  const railBoundaries = endingSoonLots.map((l) =>
    l.close_at ? new Date(l.close_at).getTime() : null,
  );

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* schema.org identity block — Organization, WebSite (sitelinks
          search box), and LocalBusiness with the real warehouse address +
          pickup hours for local search ("auctions near me"). */}
      <JsonLd data={organizationJsonLd(biz)} />
      <JsonLd data={webSiteJsonLd()} />
      {biz && <JsonLd data={localBusinessJsonLd(biz)} />}
      <BrowseAutoRefresh intervalMs={60_000} boundaries={railBoundaries} />
      {/* 0. App promo banner — homepage-only, dismissible for 7 days
              (client component handles localStorage). Sits directly
              under the global sticky nav for high visibility. */}
      <AppPromoBanner />

      {/* 1. Hero */}
      <HomeHero
        title="Better Deals. Better Bids."
        subtitle="Online auctions, run by the people who run them. Treasure hunting, on a timer."
        ctaLabel="Browse Auctions"
        // WEB-01: must carry ?view=auctions. Bare /browse resolves to the
        // lots firehose (browse/page.tsx isLotsMode), so a button that says
        // "Browse Auctions" landed the customer on a flat lot grid with no
        // auction in sight. The lots-first default is deliberate and stays —
        // only links that promise auctions are pinned to the auctions view.
        ctaHref="/browse?view=auctions"
      />

      <OffsiteSaleButtons />

      {/* 1a. Final Call callout — only shown when there's at least one lot
              currently inside the 2-min window. The count here is best-effort
              (page ISR window may make it stale by minutes); the destination
              page is fully realtime. */}
      {finalCallCount > 0 && <FinalCallCallout count={finalCallCount} />}

      {/* 1a-2. Ending-soon lot rail (D-C / W4). Sits between the hero and the
              category grid so buyable inventory is above the category fold
              (mac.bid / nellis pattern). Self-hides entirely when there's no
              open inventory — an empty marketplace shows no rail, not an
              empty-state box. */}
      {endingSoonLots.length > 0 && <EndingSoonSection lots={endingSoonLots} />}

      {/* 1b. Recent wins social proof (omitted when empty). */}
      <RecentWins wins={recentWins} />

      {/* 2. Category grid */}
      {categories.length > 0 && <CategoryGrid categories={categories} />}

      {/* Section banners (mobile-bidding / ending-soon / pickup / trusted)
          removed in the BinGo rebrand — they were full-bleed BinGo CDN
          photography that doesn't exist on BinGo infra. A clean re-do with
          real BinGo imagery is a follow-up. */}

      {/* App promo strip */}
      <AppPromoStrip />
    </div>
  );
}

// ── Ending-soon rail section (D-C / W4) ────────────────────────────────────────
//
// Section chrome (heading + "See all" link + max-width container) around the
// reused EndingSoonRail client island from home-client.tsx. The rail itself
// owns the horizontal-snap scroller (.hsnap) and the per-second countdown
// ticking; this wrapper only supplies the homepage section styling so it
// matches the CategoryGrid header below. The host page guards on
// `lots.length > 0`, so this component is never rendered with an empty rail.

function EndingSoonSection({ lots }: { lots: HomeLotCard[] }) {
  return (
    <section style={{ padding: '3rem 1.25rem 1rem', background: 'var(--bg)' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '1.25rem',
          }}
        >
          <h2
            style={{
              fontSize: 'clamp(1.35rem, 3vw, 1.85rem)',
              fontWeight: 600,
              letterSpacing: -0.3,
              margin: 0,
            }}
          >
            Ending soon
          </h2>
          <Link
            href="/browse?sort=ending-soon"
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            See all ending soon →
          </Link>
        </div>

        <EndingSoonRail lots={lots} />
      </div>
    </section>
  );
}

// ── Category grid ─────────────────────────────────────────────────────────────

function CategoryGrid({ categories }: { categories: DbCategory[] }) {
  return (
    <section style={{ padding: '3rem 1.25rem', background: 'var(--bg)' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '1.5rem',
          }}
        >
          <h2
            style={{
              fontSize: 'clamp(1.35rem, 3vw, 1.85rem)',
              fontWeight: 600,
              letterSpacing: -0.3,
              margin: 0,
            }}
          >
            Shop by category
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
            See all auctions →
          </Link>
        </div>

        <div className="cat-grid">
          {categories.slice(0, 16).map((cat) => (
            <Link
              key={cat.slug}
              href={`/category/${cat.slug}`}
              className="cat-card"
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'flex-end',
                minHeight: 110,
                borderRadius: 12,
                overflow: 'hidden',
                textDecoration: 'none',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                transition: 'border-color 120ms ease, transform 120ms ease',
              }}
            >
              {/* Photographic tile — bright product-staging photo per slug
                  (gen-brand-art.mjs `photos` stage, vision-judge validated;
                  owner direction 2026-07-03: photography over illustration).
                  Self-hosted; a missing slug degrades to the navy card. */}
              <img
                src={`/art/photo/categories/${cat.slug}.webp`}
                alt=""
                loading="lazy"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
              {/* Legibility scrim under the name. */}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(180deg, rgba(21,35,58,0) 45%, rgba(13,22,38,0.85) 100%)',
                }}
              />
              <span
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '10px 12px',
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--ink-2)',
                  lineHeight: 1.25,
                }}
              >
                {cat.name}
                <span aria-hidden style={{ color: 'var(--accent)', fontWeight: 800, flexShrink: 0 }}>
                  &rarr;
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>

      <style>{`
        .cat-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .cat-card:hover {
          border-color: var(--accent);
          transform: translateY(-1px);
        }
        @media (min-width: 480px) {
          .cat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        }
        @media (min-width: 768px) {
          .cat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
        }
      `}</style>
    </section>
  );
}

// ── App promo strip ───────────────────────────────────────────────────────────

function AppPromoStrip() {
  return (
    <section
      style={{
        padding: '4rem 1.25rem',
        background: 'var(--bg-elev)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: '2.5rem',
          alignItems: 'center',
        }}
        className="app-promo-grid"
      >
        {/* Copy side */}
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 2,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              marginBottom: '0.75rem',
            }}
          >
            Bidding on the go
          </div>
          <h2
            style={{
              fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
              fontWeight: 600,
              letterSpacing: -0.4,
              lineHeight: 1.08,
              margin: '0 0 1.1rem',
            }}
          >
            Bid from anywhere with the BinGo Auctions app.
          </h2>
          <p
            style={{
              color: 'var(--fg-muted)',
              fontSize: '1rem',
              lineHeight: 1.65,
              maxWidth: 480,
              margin: '0 0 1.75rem',
            }}
          >
            Push notifications when you&apos;re outbid, scan-to-bid via QR, and a
            warehouse walking map on pickup day — one login for every BinGo
            Auctions auction.
          </p>

          {/* Store badges */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <Link
              href="/download"
              aria-label="Download on the App Store"
              style={{ display: 'inline-block' }}
            >
              <AppStoreBadgeSvg />
            </Link>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 40,
                padding: '0 14px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--fg-muted)',
                fontWeight: 700,
                letterSpacing: 0.3,
                whiteSpace: 'nowrap',
              }}
            >
              Google Play — coming soon
            </span>
          </div>
        </div>

        {/* App promo art — generated in-house (design/generated/promo-app.webp,
            see scripts/gen-brand-art.mjs). Hidden on mobile via the media query
            below so the copy + badges stay above the fold. */}
        <img
          src="/art/photo/banner-mobile-bidding.webp"
          alt=""
          width={480}
          height={150}
          className="app-promo-art"
          style={{
            display: 'none',
            width: '100%',
            maxWidth: 420,
            height: 'auto',
            borderRadius: 16,
            justifySelf: 'center',
          }}
        />
      </div>

      <style>{`
        @media (min-width: 768px) {
          .app-promo-grid {
            grid-template-columns: 1fr 1fr !important;
          }
          .app-promo-art {
            display: block !important;
          }
        }
      `}</style>
    </section>
  );
}

// ── Final Call callout ─────────────────────────────────────────────────────────
//
// Single-column hero card (~1100×120) sitting just under the homepage hero.
// Red gradient background reinforces the urgency, mirrors the wordmark
// treatment used on /final-call. Count is best-effort from the homepage's
// 10-min ISR window; the destination page is fully realtime.

function FinalCallCallout({ count }: { count: number }) {
  return (
    <section style={{ padding: '1.5rem 1.25rem 0' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <Link
          href="/final-call?from=homepage"
          aria-label={`Final Call — ${count} lots ending in under 2 minutes`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            padding: '1.1rem 1.4rem',
            minHeight: 96,
            background:
              'linear-gradient(90deg, rgba(255, 59, 59, 0.95) 0%, rgba(177, 30, 30, 0.95) 100%)',
            border: '1px solid rgba(255, 59, 59, 0.6)',
            borderRadius: 12,
            textDecoration: 'none',
            color: '#fff',
            boxShadow: '0 4px 24px rgba(255, 59, 59, 0.18)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            {/* Pulsing live dot */}
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#fff',
                animation: 'final-call-callout-pulse 1.5s ease-in-out infinite',
                flexShrink: 0,
                boxShadow: '0 0 12px rgba(255, 255, 255, 0.8)',
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  fontWeight: 900,
                  letterSpacing: -0.5,
                  fontSize: 'clamp(1.1rem, 3vw, 1.6rem)',
                  lineHeight: 1.1,
                  marginBottom: 2,
                }}
              >
                <span style={{ color: '#fff' }}>FINAL&nbsp;</span>
                <span style={{ color: 'rgba(255, 255, 255, 0.85)' }}>CALL</span>
                <span
                  style={{
                    marginLeft: 12,
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: 2,
                    textTransform: 'uppercase',
                    color: 'rgba(255, 255, 255, 0.85)',
                  }}
                >
                  Lots ending in &lt;2 min
                </span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'rgba(255, 255, 255, 0.9)',
                }}
              >
                <strong style={{ color: '#fff', fontWeight: 900 }}>
                  {count.toLocaleString('en-US')}
                </strong>{' '}
                lot{count === 1 ? '' : 's'} in the rush right now. Bid before it&apos;s gone.
              </div>
            </div>
          </div>

          <span
            aria-hidden
            style={{
              flexShrink: 0,
              padding: '0.55rem 1.15rem',
              borderRadius: 999,
              background: '#fff',
              color: 'var(--urgent-red)',
              fontWeight: 900,
              fontSize: 13,
              letterSpacing: 0.4,
              whiteSpace: 'nowrap',
            }}
          >
            Open Final Call →
          </span>
        </Link>
      </div>

      <style>{`
        @keyframes final-call-callout-pulse {
          0%   { opacity: 1; }
          50%  { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `}</style>
    </section>
  );
}

// ── App Store badge SVG (Apple dark variant) ──────────────────────────────────

function AppStoreBadgeSvg() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="135"
      height="40"
      viewBox="0 0 135 40"
      role="img"
      aria-label="Download on the App Store"
    >
      <rect width="135" height="40" rx="8" ry="8" fill="#000" />
      <rect
        x="0.5"
        y="0.5"
        width="134"
        height="39"
        rx="7.5"
        ry="7.5"
        fill="none"
        stroke="#a6a6a6"
        strokeWidth="1"
      />
      <path
        d="M24.77 20.3a5.2 5.2 0 0 1 2.48-4.37 5.33 5.33 0 0 0-4.2-2.27c-1.77-.18-3.48 1.06-4.38 1.06-.92 0-2.3-1.04-3.8-1.01a5.59 5.59 0 0 0-4.7 2.87c-2.03 3.52-.52 8.7 1.44 11.55.97 1.39 2.1 2.95 3.59 2.9 1.45-.06 2-.93 3.75-.93 1.74 0 2.25.93 3.77.9 1.56-.03 2.54-1.4 3.48-2.8a11.5 11.5 0 0 0 1.58-3.26 5.03 5.03 0 0 1-3.01-4.64z"
        fill="#fff"
      />
      <path
        d="M21.84 12.1a5.13 5.13 0 0 0 1.17-3.67 5.22 5.22 0 0 0-3.38 1.75 4.88 4.88 0 0 0-1.2 3.54 4.32 4.32 0 0 0 3.41-1.62z"
        fill="#fff"
      />
      <text
        x="38"
        y="14"
        fill="#fff"
        fontSize="9"
        fontFamily="-apple-system, Helvetica, Arial, sans-serif"
        letterSpacing="0.3"
      >
        Download on the
      </text>
      <text
        x="38"
        y="29"
        fill="#fff"
        fontSize="17"
        fontWeight="600"
        fontFamily="-apple-system, Helvetica, Arial, sans-serif"
        letterSpacing="-0.3"
      >
        App Store
      </text>
    </svg>
  );
}
