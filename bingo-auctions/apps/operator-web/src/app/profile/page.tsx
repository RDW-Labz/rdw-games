// Bidder profile — bingoauctions.com/profile.
//
// The signed-in bidder's home: payment method, fees, watchlist, recent bids,
// receipts, pickup, and sign-out. Operators have their own /dashboard.
//
// Auth: middleware redirects anonymous visitors to /login. Server-component
// re-checks defensively.
//
// Card-on-file (Square): read directly from the bidders row — default_payment_
// method_id holds the Square card id, and card_brand/card_last4 are the display
// crumbs stored at save time (migration 0211). No processor round-trip needed.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { SignOutButton } from './SignOutButton';
import { ReferralCard } from './ReferralCard';
import { ResaleCertCard } from './ResaleCertCard';
import { LoyaltyCard } from './LoyaltyCard';
import {
  type WatchlistRow,
  sortWatchlistRows,
  type BidRow,
  formatMoney,
  WatchlistItem,
  BidItem,
} from './_lib/bids';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CardInfo {
  has_card: boolean;
  last4: string | null;
  brand: string | null;
}

function formatBrand(brand: string | null): string {
  if (!brand) return 'Card';
  const map: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    american_express: 'American Express',
    discover: 'Discover',
    jcb: 'JCB',
    diners: 'Diners',
    discover_diners: 'Diners',
    unionpay: 'UnionPay',
    china_unionpay: 'UnionPay',
  };
  return map[brand.toLowerCase()] ?? brand;
}

// Card-on-file state straight from the bidders row (Square). No processor call:
// default_payment_method_id present ⇒ a card is vaulted; brand/last4 are the
// display crumbs stored by /api/bidder/square/save-card.
async function loadCardInfo(userId: string): Promise<CardInfo> {
  const admin = getSupabaseAdmin();
  const { data: row, error } = await admin
    .from('bidders')
    .select('default_payment_method_id, card_brand, card_last4')
    .eq('id', userId)
    .maybeSingle();
  if (error || !row || !row.default_payment_method_id) {
    return { has_card: false, last4: null, brand: null };
  }
  return {
    has_card: true,
    brand: (row.card_brand as string | null) ?? null,
    last4: (row.card_last4 as string | null) ?? null,
  };
}

export default async function ProfilePage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id, display_name, email, bidder_number, default_payment_method_id, unpaid_fees_cents, referral_code, resale_cert_status, resale_cert_permit, resale_cert_state, resale_cert_business, tax_exempt')
    .eq('id', user.id)
    .maybeSingle();

  if (!bidderRow) {
    // Signed-in user with no bidders row — finish onboarding.
    redirect('/bidder/onboarding?next=/profile');
  }

  // Run independent loads in parallel — payment method + watchlist + bids +
  // referral-credit balance (RLS own-read on bidder_credits, mig 0229).
  const [cardInfo, watchlistQ, bidsQ, creditsQ] = await Promise.all([
    loadCardInfo(user.id),
    // LEFT join (lots, not lots!inner): keep watchlist rows whose lot is
    // RLS-hidden / closed so the placeholder + Remove button can surface them.
    supabase
      .from('watchlist')
      .select(
        'lot_id, created_at, lots(id, lot_code, title, status, current_bid_cents, starting_bid_cents, close_at, photo_urls)',
      )
      .eq('bidder_id', user.id)
      // Fetch a window, then rank by close time below and take the top 10.
      // Ordering by created_at and limiting to 10 HERE would preview "the 10
      // most recently starred", so a lot closing within the hour could be
      // missing from a list whose whole job is to stop that happening.
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('bids')
      .select(
        'lot_id, amount_cents, max_amount_cents, placed_at, lots!lot_id(id, lot_code, title, status, current_bid_cents, close_at, winner_bidder_id)',
      )
      .eq('bidder_id', user.id)
      .eq('is_auto', false)
      .gte('placed_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('placed_at', { ascending: false })
      .limit(20),
    supabase.from('bidder_credits').select('amount_cents').eq('bidder_id', user.id),
  ]);

  // Preview the lots closing soonest, matching the app's watchlist tab and the
  // full list at /profile/watchlist (which lets the bidder change the order).
  const watchlist = sortWatchlistRows(
    (watchlistQ.data as unknown as WatchlistRow[] | null) ?? [],
    'ending_soon',
  ).slice(0, 10);
  const recentBids = (bidsQ.data as unknown as BidRow[] | null) ?? [];
  const creditBalanceCents = ((creditsQ.data as { amount_cents: number }[] | null) ?? []).reduce(
    (sum, r) => sum + r.amount_cents,
    0,
  );
  const referralCode = (bidderRow.referral_code as string | null) ?? null;

  // De-dupe bids by lot_id (multiple bids on the same lot collapse to the most
  // recent — matches the bidder-app behavior).
  const seenLots = new Set<string>();
  const uniqueBids: BidRow[] = [];
  for (const b of recentBids) {
    if (seenLots.has(b.lot_id)) continue;
    seenLots.add(b.lot_id);
    uniqueBids.push(b);
  }

  const displayName =
    (bidderRow.display_name as string | null) ?? user.email ?? 'Bidder';
  const unpaidFees = (bidderRow.unpaid_fees_cents as number | null) ?? 0;
  // bidder_number (mig 0254): the customer's permanent paddle number. Shown so
  // someone who reads "Bidder #369 is high bidder" can tell whether that's them,
  // and so they can identify themselves at the counter (support-ask 2026-07-17).
  // Absent from the generated database types, so the value is cast locally —
  // same as the bidder app's Profile tab does.
  const bidderNumber = (bidderRow.bidder_number as number | null) ?? null;

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 900, margin: '0 auto' }}>
      <header style={{ marginBottom: '2.5rem' }}>
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
          {displayName}
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 4 }}>
          {bidderRow.email ?? user.email}
        </div>
        {/* ACCT-01 — the same number the iOS/Android Profile tab shows. The
            column is nullable, so render nothing rather than "Bidder #null".
            Wording is verbatim from the apps so the surfaces read identically. */}
        {bidderNumber != null && (
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: 'var(--accent)',
              letterSpacing: 0.2,
              marginTop: 4,
            }}
          >
            Bidder #{bidderNumber}
          </div>
        )}
      </header>

      {/* Fees alert — shown at the top because it blocks bidding. */}
      {unpaidFees > 0 && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: 'rgba(255, 59, 59, 0.08)',
            border: '1px solid rgba(255, 59, 59, 0.4)',
            borderRadius: 10,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontWeight: 800, color: 'var(--danger)' }}>
              Outstanding fees: {formatMoney(unpaidFees)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
              You can&apos;t place new bids until this is paid.
            </div>
          </div>
          <Link
            href="/profile/pay-fees"
            className="btn-primary"
            style={{ padding: '0.6rem 1.25rem' }}
          >
            Pay {formatMoney(unpaidFees)}
          </Link>
        </section>
      )}

      {/* Give $5, get $5 (mig 0229) */}
      {referralCode && (
        <Section title="Give $5, get $5">
          <ReferralCard code={referralCode} balanceCents={creditBalanceCents} />
        </Section>
      )}

      {/* Payment method */}
      <Section title="Payment method">
        {cardInfo.has_card ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>
                {formatBrand(cardInfo.brand)} &middot; &middot; &middot; &middot;{' '}
                {cardInfo.last4 ?? '----'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
                We&apos;ll charge this card automatically when you win an auction.
              </div>
            </div>
            <Link
              href="/bidder/onboarding/payment-method"
              className="btn-secondary"
              style={{ padding: '0.55rem 1.1rem', fontSize: 13 }}
            >
              Update card
            </Link>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
              No card on file. You&apos;ll need one to bid.
            </div>
            <Link
              href="/bidder/onboarding/payment-method"
              className="btn-primary"
              style={{ padding: '0.6rem 1.2rem', fontSize: 14 }}
            >
              Add a card
            </Link>
          </div>
        )}
      </Section>

      {/* Square Loyalty (mig 0237) — self-contained section; renders nothing
          unless the feature is on and the bidder has a phone on file */}
      <LoyaltyCard />

      {/* Reseller tax exemption (mig 0233) */}
      <Section title="Tax exemption for resellers">
        <ResaleCertCard
          status={(bidderRow.resale_cert_status as string | null) ?? null}
          permit={(bidderRow.resale_cert_permit as string | null) ?? null}
          state={(bidderRow.resale_cert_state as string | null) ?? null}
          business={(bidderRow.resale_cert_business as string | null) ?? null}
          taxExempt={(bidderRow.tax_exempt as boolean | null) ?? false}
        />
      </Section>

      {/* Notifications — the /profile/notifications history page shipped in
          S14 but nothing ever linked to it (the planned follow-up nav link
          was dropped). Owner ask 2026-07-08: "somewhere for a notification
          button so people know they're outbid or won or lost items". */}
      <Section title="Notifications">
        <Link
          href="/profile/notifications"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 0.85rem',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>View your notifications</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              Outbid alerts, wins, payment and pickup updates.
            </div>
          </div>
          <div style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
            View &rarr;
          </div>
        </Link>
      </Section>

      {/* Receipts */}
      <Section title="Receipts">
        <Link
          href="/profile/invoices"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 0.85rem',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>View invoices and receipts</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              Receipts for every auction you&apos;ve won.
            </div>
          </div>
          <div style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
            View &rarr;
          </div>
        </Link>
      </Section>

      {/* Past wins */}
      <Section title="Past wins">
        <Link
          href="/profile/past-wins"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 0.85rem',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>View all auction wins</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              Paid, awaiting pickup, and outstanding items
            </div>
          </div>
          <div style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
            View &rarr;
          </div>
        </Link>
      </Section>

      {/* Pickup */}
      <Section title="Pickup">
        <Link
          href="/profile/pickup"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 0.85rem',
            borderRadius: 8,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>View pickup info</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              QR codes and locations
            </div>
          </div>
          <div style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
            View &rarr;
          </div>
        </Link>
      </Section>

      {/* Watchlist — preview (top 10). Full list lives at /profile/watchlist. */}
      <Section
        title="Watchlist"
        action={{ href: '/profile/watchlist', label: 'View all' }}
        empty={watchlist.length === 0}
        emptyCopy={
          <>
            You haven&apos;t added any lots to your watchlist yet.{' '}
            <Link href="/browse" style={{ color: 'var(--accent)' }}>
              Browse auctions
            </Link>
            .
          </>
        }
      >
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {watchlist.map((row) => (
            <WatchlistItem key={row.lot_id} row={row} />
          ))}
        </div>
      </Section>

      {/* My bids — preview (last 30 days, top 20). */}
      <Section
        title="My bids (last 30 days)"
        action={{ href: '/profile/my-bids', label: 'View all' }}
        empty={uniqueBids.length === 0}
        emptyCopy={
          <>
            You haven&apos;t placed any bids yet.{' '}
            <Link href="/browse" style={{ color: 'var(--accent)' }}>
              Find an auction
            </Link>
            .
          </>
        }
      >
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {uniqueBids.map((row) => (
            <BidItem key={row.lot_id} row={row} userId={user.id} />
          ))}
        </div>
      </Section>

      {/* Account actions — Delete account next to Sign out. */}
      <div
        style={{
          marginTop: '3rem',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <Link
          href="/profile/delete-account"
          style={{ fontSize: 13, color: 'var(--fg-dim)', textDecoration: 'none' }}
        >
          Delete account
        </Link>
        <SignOutButton />
      </div>
    </main>
  );
}

function Section({
  title,
  children,
  empty,
  emptyCopy,
  action,
}: {
  title: string;
  children: React.ReactNode;
  empty?: boolean;
  emptyCopy?: React.ReactNode;
  /** Optional header-right affordance — used by Watchlist / My bids to
   *  deep-link to the full dedicated pages (WEB-NAV). */
  action?: { href: string; label: string };
}) {
  return (
    <section
      style={{
        marginBottom: '2rem',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1.25rem 1.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '1rem',
          margin: '0 0 1rem',
        }}
      >
        <h2
          style={{
            fontSize: '0.9rem',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            color: 'var(--fg-dim)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        {action && (
          <Link
            href={action.href}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              flexShrink: 0,
            }}
          >
            {action.label} &rarr;
          </Link>
        )}
      </div>
      {empty ? (
        <div style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.6 }}>{emptyCopy}</div>
      ) : (
        children
      )}
    </section>
  );
}
