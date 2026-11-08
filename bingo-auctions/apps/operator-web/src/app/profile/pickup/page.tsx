// /profile/pickup — bidder-facing pickup list (browser parity with mobile app).
//
// Why this exists:
//   User report 2026-06-01: "browser needs to be almost like the app on being
//   able to pick up through it as well, a lot of customers use the browser side
//   instead of apps and vice versa."
//
//   The bidder mobile app has a full /pickup/* surface (apps/bidder-app/app/
//   pickup/[id].tsx with QR check-in, address, and map). Browser bidders had
//   NO pickup surface — only /profile/invoices showed receipts with a tiny
//   embedded pickup block. This page is the browser pickup hub: list of
//   paid pickup-method invoices, each linking to its detail card with the
//   QR + directions.
//
// Auth: middleware gates /profile* (not in PUBLIC_ROUTE_PREFIXES); server
// component re-checks defensively.
//
// Data scope:
//   Invoices where fulfillment_method = 'pickup' (or NULL) AND status is
//   'paid' OR 'partially_refunded'. Shipping invoices don't need a pickup
//   surface; unpaid invoices don't yield a QR. RLS auto-restricts via
//   invoices_self_read; explicit bidder_id filter is belt-and-braces (matches
//   the invoices_bidder_idx index so the planner still chooses the cheap path).
//
//   Report 2026-08-25 (a resale buyer with 120 pickup
//   invoices): "can not see all his invoices to be able to pick up his items."
//   This page showed him 39 of 120. Two causes, both here:
//     • status = 'paid' dropped all 42 of his 'partially_refunded' invoices —
//       refunding ONE lot hid the whole invoice, including an item he had
//       still not collected. The mobile app has always used
//       .in('status', ['paid','partially_refunded']); the browser never
//       caught up.
//     • .limit(50) silently truncated the rest, with nothing on screen saying
//       so — an invoice past the cap is indistinguishable from one that
//       doesn't exist.
//   Collected pickups now fold into a second group so a long history stays
//   scannable instead of burying what's actually ready (mobile parity).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatInTimeZone } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PickupInvoiceRow {
  id: string;
  paid_at: string | null;
  auction_id: string;
  operator_id: string;
  auctions: {
    title: string | null;
    pickup_starts_at: string | null;
    pickup_ends_at: string | null;
    warehouses: {
      name: string | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      timezone: string | null;
    } | null;
  } | null;
  operators: { business_name: string | null } | null;
  pickups: Array<{ status: string | null }> | { status: string | null } | null;
}

export default async function ProfilePickupListPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/pickup');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/pickup');
  }

  const { data: invoicesData } = await supabase
    .from('invoices')
    .select(
      `id, paid_at, auction_id, operator_id,
       auctions(title, pickup_starts_at, pickup_ends_at,
         warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
       operators:operators_public(business_name),
       pickups(status)`,
    )
    .eq('bidder_id', user.id)
    // Include NULL fulfillment_method: a won lot's off-session auto-charge pays
    // the invoice without ever running the checkout method-picker, so a real
    // pickup invoice usually sits at NULL. NULL = pickup by default (matches the
    // Stripe webhook's `method !== 'ship'`). Excluding it left the list empty and
    // showed the "Browse auctions" empty-state instead of the bidder's pickup.
    .or('fulfillment_method.eq.pickup,fulfillment_method.is.null')
    // 'partially_refunded' belongs here: refunding one lot off a ten-lot
    // invoice leaves nine to collect. Excluding it hid whole pickups.
    .in('status', ['paid', 'partially_refunded'])
    .order('paid_at', { ascending: false })
    // High enough that no real buyer is truncated (the worst case in prod is
    // 120). Kept as a sanity bound rather than an unbounded scan.
    .limit(500);

  const invoices = (invoicesData as unknown as PickupInvoiceRow[] | null) ?? [];

  // Split the same way the mobile app does: a completed / no-show / forfeited
  // pickup has nothing left to hand over, so it drops below the fold instead
  // of pushing a live pickup off the top of a 120-row list.
  const isDone = (inv: PickupInvoiceRow) => {
    const p = Array.isArray(inv.pickups) ? inv.pickups[0] : inv.pickups;
    const st = p?.status ?? null;
    return st === 'completed' || st === 'no_show' || st === 'forfeited';
  };
  const ready = invoices.filter((inv) => !isDone(inv));
  const collected = invoices.filter(isDone);

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 900, margin: '0 auto' }}>
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
          Your pickups
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          QR codes, addresses, and pickup windows for everything you&apos;ve won.
        </div>
      </header>

      {invoices.length === 0 ? (
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
          <div style={{ marginBottom: '0.75rem' }}>
            No pickups scheduled. Pickup info will appear here after you win a
            pickup-method auction.
          </div>
          <Link href="/browse" className="btn-primary" style={{ padding: '0.6rem 1.25rem' }}>
            Browse auctions
          </Link>
        </section>
      ) : (
        <>
          {ready.length > 0 ? (
            <section style={{ marginBottom: collected.length > 0 ? '2.5rem' : 0 }}>
              <GroupHeading
                label="Ready to collect"
                count={ready.length}
              />
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {ready.map((inv) => (
                  <PickupCard key={inv.id} invoice={inv} />
                ))}
              </div>
            </section>
          ) : null}

          {collected.length > 0 ? (
            <section>
              <GroupHeading label="Already collected" count={collected.length} />
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {collected.map((inv) => (
                  <PickupCard key={inv.id} invoice={inv} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        marginBottom: '0.75rem',
      }}
    >
      <h2
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
          margin: 0,
        }}
      >
        {label}
      </h2>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{count}</span>
    </div>
  );
}

function PickupCard({ invoice }: { invoice: PickupInvoiceRow }) {
  const operatorName = invoice.operators?.business_name ?? '—';
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const wh = invoice.auctions?.warehouses ?? null;
  const pickupStart = invoice.auctions?.pickup_starts_at ?? null;
  const pickupEnd = invoice.auctions?.pickup_ends_at ?? null;
  const pickupTz = wh?.timezone ?? 'America/New_York';

  // Window via the shared runtime-hardened formatter (lib/datetime.ts). The
  // previous inline dateStyle/timeStyle formatter threw on the Cloudflare
  // Worker runtime (CLOVRBID-WEB-8 class) and silently dropped the window.
  // Compact list range omits the tz abbreviation; the detail screen shows it.
  const windowLabel =
    pickupStart && pickupEnd
      ? `${formatInTimeZone(pickupStart, pickupTz, { timeZoneName: undefined })} – ${formatInTimeZone(pickupEnd, pickupTz, { timeZoneName: undefined })}`
      : null;

  const cityLine = [wh?.city, wh?.state].filter(Boolean).join(', ');

  return (
    <Link
      href={`/profile/pickup/${invoice.id}`}
      style={{
        display: 'block',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              marginBottom: 4,
            }}
          >
            {operatorName}
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
            {auctionTitle}
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 6, lineHeight: 1.5 }}>
            {wh?.name ? <div>{wh.name}</div> : null}
            {cityLine ? <div>{cityLine}</div> : null}
            {windowLabel ? (
              <div style={{ marginTop: 4 }}>
                <strong style={{ color: 'var(--fg)' }}>Window:</strong> {windowLabel}
              </div>
            ) : null}
          </div>
        </div>
        <div
          style={{
            textAlign: 'right',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: 'var(--accent)',
              fontWeight: 600,
            }}
          >
            View QR &rarr;
          </div>
        </div>
      </div>
    </Link>
  );
}
