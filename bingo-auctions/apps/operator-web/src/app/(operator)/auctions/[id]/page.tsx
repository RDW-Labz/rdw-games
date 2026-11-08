import Link from 'next/link';
import Image from 'next/image';
import QRCode from 'qrcode';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { isPaymentsDisabled } from '@/lib/payments-mode';
import { formatInTimeZone, formatDateInTimeZone, warehouseTimezone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { PageHeader, buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { ScheduleAuctionButton } from './ScheduleAuctionButton';
import { CancelAuctionButton } from './CancelAuctionButton';
import { FeaturedImagesCurator } from './FeaturedImagesCurator';
import { RedistributeButton } from './RedistributeButton';
import { LotReorderTable, type ReorderableLot } from './LotReorderTable';
import { AuctionDetailV2 } from './v2/AuctionDetailV2';

export default async function AuctionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  // Scope to the caller's operator. Staff users who also have a
  // bidders row would otherwise see foreign auctions (via the
  // auctions_bidder_read_published RLS policy) which then 404 inside
  // the builder, because the builder query IS operator-scoped.
  const { data: { user } } = await supabase.auth.getUser();
  let operatorId: string | null = null;
  if (user) {
    const { data: me } = await supabase
      .from('operator_users')
      .select('operator_id')
      .eq('user_id', user.id)
      .single();
    operatorId = (me?.operator_id as string | null) ?? null;
  }

  // S13-F1: fetch stripe_charges_enabled so the checklist can warn before schedule.
  let stripeChargesEnabled = false;
  if (operatorId) {
    const { data: opRow } = await supabase
      .from('operators')
      .select('stripe_charges_enabled')
      .eq('id', operatorId)
      .single();
    stripeChargesEnabled = (opRow as { stripe_charges_enabled?: boolean } | null)?.stripe_charges_enabled === true;
  }

  // AUCT-1: no-Stripe test-mode (platform_settings.payments_disabled, migration
  // 0198). When payments are disabled platform-wide, the Connect onboarding
  // schedule gate is bypassed server-side (see scheduleAuction). Mirror that here
  // so the checklist shows "ready to schedule" instead of a red blocked Stripe
  // step. effectiveChargesReady is the flag the schedule step reasons about:
  // either charges are really enabled, or we're in test-mode where they're moot.
  const paymentsDisabled = await isPaymentsDisabled();
  const effectiveChargesReady = stripeChargesEnabled || paymentsDisabled;

  let auctionQ = supabase
    .from('auctions')
    .select(
      // warehouses(timezone) embeds the auction's warehouse IANA zone so all
      // absolute date/time labels render in the warehouse's local time rather
      // than the SSR runtime zone (UTC on Cloudflare Workers).
      'id, title, description, status, starts_at, ends_at, last_lot_ends_at, pickup_starts_at, pickup_ends_at, soft_close_minutes, buyer_premium_bps, warehouse_id, featured_image_urls, warehouses(timezone)',
    )
    .eq('id', id);
  if (operatorId) auctionQ = auctionQ.eq('operator_id', operatorId);
  const { data: auction } = await auctionQ.single();

  if (!auction) notFound();

  // Warehouse timezone for all absolute-time renders on this page.
  // warehouse_id is NOT NULL and warehouses.timezone is NOT NULL, so the
  // fallback only guards an unexpected null shape. The supabase-js generated
  // types infer an embedded to-one relation as an array, so normalize both
  // shapes (array | object) before reading .timezone.
  const tz = warehouseTimezone(auction.warehouses) ?? DEFAULT_TIME_ZONE;

  // Option C (Issue 3): per-auction "Preview QR" the operator prints/displays
  // at the warehouse door. A bidder scans it ONCE in the BinGo Auctions app to set
  // their preview check-in (set_bidder_preview_operator, 0150) → they can then
  // scan this operator's physical lot stickers. Encodes the public
  // /preview/{auction_id} URL; rendered server-side as a PNG data URL. A plain
  // camera that opens the URL 302s to the public auction page (see the route).
  const previewUrl = `https://bingoauctions.com/preview/${auction.id as string}`;
  const previewQrDataUrl = await QRCode.toDataURL(previewUrl, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  const { data: lots } = await supabase
    .from('lots')
    .select(
      'id, lot_number, lot_code, sticker_code, display_code, title, status, starting_bid_cents, current_bid_cents, close_at, bid_count, msrp_cents',
    )
    .eq('auction_id', id)
    .order('lot_number');

  // ── Lot-status / bid-count summary tiles (launch-blocker L0 item #2) ──
  //
  // During a live auction the operator otherwise has no glance-view of how
  // many lots are open vs won vs unsold or where the bidding pressure
  // sits. Six counts in parallel + one bid-sum query — same parallel-HEAD
  // pattern as /lotting. RLS already scopes via operator_users.
  //
  // Phase choice for the "active" tile: if the auction itself is still
  // 'scheduled' or 'draft', we count lots in status 'scheduled' (waiting
  // to open). Once the auction is 'live' / 'closed' / 'canceled' we
  // count lots in status 'live'. Whichever phase we're in is the highest-
  // priority active status to surface.
  const activeStatus: 'scheduled' | 'live' =
    auction.status === 'draft' || auction.status === 'scheduled' ? 'scheduled' : 'live';

  // M8 provenance (live-test feedback 2026-06-03): split the flat lot total
  // into where these lots came from, so a "100 → 107" jump between refreshes
  // is explained rather than alarming.
  //   • Newly-added     → relisted_from_lot_id IS NULL (first-time lots).
  //   • Carried-over    → relisted_from_lot_id IS NOT NULL (relisted in from a
  //                       prior auction, manual or auto).
  //   • Forfeited-return→ a winning bidder no-showed/forfeited pickup. Same
  //                       lot ← invoice_lots ← invoices ← pickups inner-join as
  //                       /worklist + the inventory Unpicked-up bucket. This is
  //                       an overlapping lens (a forfeited-return lot is also
  //                       counted under newly/carried by lineage), surfaced so
  //                       the operator sees the no-show contribution explicitly.
  const [
    totalLotsQ,
    activeLotsQ,
    wonLotsQ,
    unsoldLotsQ,
    bidCountRowsQ,
    noBidLotsQ,
    newlyAddedLotsQ,
    carriedOverLotsQ,
    forfeitedReturnLotsQ,
  ] = await Promise.all([
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .eq('status', activeStatus)
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .eq('status', 'won')
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .eq('status', 'unsold')
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('bid_count')
      .eq('auction_id', id)
      .is('deleted_at', null),
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .eq('bid_count', 0)
      .in('status', ['live', 'scheduled'])
      .is('deleted_at', null),
    // M8: newly-added (no relist lineage)
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .is('relisted_from_lot_id', null)
      .is('deleted_at', null),
    // M8: carried-over (relisted in from a prior lot)
    supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('auction_id', id)
      .not('relisted_from_lot_id', 'is', null)
      .is('deleted_at', null),
    // M8: forfeited-return (winning bidder no-showed / forfeited pickup) —
    // same forfeited-returns inner-join as /worklist + inventory Unpicked-up.
    supabase
      .from('lots')
      .select('id, invoice_lots!inner(invoices!inner(pickups!inner(status)))', {
        count: 'exact',
        head: true,
      })
      .eq('auction_id', id)
      .is('deleted_at', null)
      .in('invoice_lots.invoices.pickups.status', ['no_show', 'forfeited']),
  ]);

  const totalLots = totalLotsQ.count ?? 0;
  const activeLots = activeLotsQ.count ?? 0;
  const wonLots = wonLotsQ.count ?? 0;
  const unsoldLots = unsoldLotsQ.count ?? 0;
  const noBidLots = noBidLotsQ.count ?? 0;
  const newlyAddedLots = newlyAddedLotsQ.count ?? 0;
  const carriedOverLots = carriedOverLotsQ.count ?? 0;
  const forfeitedReturnLots = forfeitedReturnLotsQ.count ?? 0;
  const totalBids = (bidCountRowsQ.data ?? []).reduce(
    (sum: number, r) => sum + (((r as { bid_count: number | null }).bid_count) ?? 0),
    0,
  );

  const canEdit = !['live', 'closed', 'canceled'].includes(auction.status as string);
  const canCancel =
    ['draft', 'scheduled'].includes(auction.status as string) &&
    !(lots ?? []).some((l) => ((l.bid_count as number | null) ?? 0) > 0);

  // ── Auction launch checklist (docs/auction-lot-audit-plan.md redesign) ──
  //
  // Five-step hub mirroring the warehouse setup hub pattern. Shows
  // completion state per step so the operator can see at a glance
  // what's missing before scheduling. Click any step to jump to its
  // editor / control.
  type StepState = 'done' | 'partial' | 'todo' | 'na';
  type Step = {
    title: string;
    detail: string;
    state: StepState;
    href?: string; // anchor or sub-route
    /** Inline button label override; default uses state */
    cta?: string;
  };

  const lotCount = lots?.length ?? 0;
  const featuredCount = ((auction.featured_image_urls as string[] | null) ?? []).length;
  const isWindowed = !!auction.last_lot_ends_at;
  // "Needs redistribute" heuristic: in a windowed-close auction, if there
  // are 2+ lots and any two share the exact same close_at value, they
  // were probably added after the last Redistribute (intake or relist
  // inserts use ends_at as placeholder until redistribute is called).
  const closeAtCounts = new Map<string, number>();
  for (const l of lots ?? []) {
    const k = String(l.close_at);
    closeAtCounts.set(k, (closeAtCounts.get(k) ?? 0) + 1);
  }
  const needsRedistribute =
    isWindowed && lotCount > 1 && [...closeAtCounts.values()].some((c) => c > 1);

  const stepConfig: Step = {
    title: 'Configure',
    detail: `${auction.title as string} · closes ${formatInTimeZone(auction.ends_at as string, tz)} · premium ${(((auction.buyer_premium_bps as number) ?? 0) / 100).toFixed(1)}%`,
    state: 'done',
    href: `/auctions/${auction.id}/edit`,
    cta: canEdit ? 'Edit' : 'View',
  };
  const stepLots: Step = {
    title: 'Add lots',
    detail:
      lotCount === 0
        ? 'No lots yet — auction can\'t go live without at least one.'
        : `${lotCount} lot${lotCount === 1 ? '' : 's'} attached`,
    state: lotCount > 0 ? 'done' : 'todo',
    href: `/auctions/${auction.id}/builder`,
    cta: canEdit ? (lotCount === 0 ? 'Add from inventory →' : 'Add more →') : 'View',
  };
  const stepRedistribute: Step = {
    title: 'Distribute close times',
    detail: !isWindowed
      ? 'Fixed-stagger close mode — no distribution needed.'
      : lotCount === 0
        ? 'Add lots first.'
        : needsRedistribute
          ? 'Multiple lots share the same close time. Click Redistribute below.'
          : 'Looks distributed across the close window.',
    state: !isWindowed
      ? 'na'
      : lotCount === 0
        ? 'todo'
        : needsRedistribute
          ? 'partial'
          : 'done',
    // No href — operator scrolls down to the Redistribute button section
    // which is rendered conditionally below.
  };
  const stepFeatured: Step = {
    title: 'Featured images (optional)',
    detail:
      featuredCount === 0
        ? 'No featured images — bidders see a default gallery cover.'
        : `${featuredCount} featured image${featuredCount === 1 ? '' : 's'} set`,
    state: featuredCount > 0 ? 'done' : 'partial',
    // No href — section below.
  };
  const stepSchedule: Step = {
    title: 'Schedule auction',
    detail:
      auction.status === 'scheduled' || auction.status === 'live'
        ? `Already ${auction.status}.`
        : auction.status === 'closed'
          ? 'Auction has closed.'
          : auction.status === 'canceled'
            ? 'Canceled.'
            : !effectiveChargesReady
              ? 'Card charges not yet enabled — finish payment setup before scheduling.'
              : lotCount === 0
                ? 'Add at least one lot before scheduling.'
                : needsRedistribute
                  ? 'Click Redistribute close times first.'
                  : 'Ready to schedule. Bidders see it the moment you click below.',
    state:
      ['scheduled', 'live'].includes(auction.status as string)
        ? 'done'
        : auction.status === 'closed' || auction.status === 'canceled'
          ? 'na'
          : !effectiveChargesReady
            ? 'todo' // blocked: must complete Stripe onboarding
            : lotCount > 0 && !needsRedistribute
              ? 'partial' // ready, awaiting click
              : 'todo',
    // Stripe Connect onboarding CTA removed in the Square cutover (single-
    // account: charges are always ready, no per-operator onboarding).
    href: undefined,
    cta: undefined,
  };

  const checklist: Step[] = [
    stepConfig,
    stepLots,
    stepRedistribute,
    stepFeatured,
    stepSchedule,
  ];
  const completed = checklist.filter((s) => s.state === 'done').length;
  const totalApplicable = checklist.filter((s) => s.state !== 'na').length;
  const todoCount = checklist.filter((s) => s.state === 'todo').length;

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    let warehouseLabel = '—';
    if (auction.warehouse_id) {
      const { data: whRow } = await supabase
        .from('warehouses')
        .select('name, city, state')
        .eq('id', auction.warehouse_id as string)
        .single();
      if (whRow) {
        warehouseLabel = `${whRow.name as string} · ${whRow.city as string}, ${whRow.state as string}`;
      }
    }

    const closingWindowNode = auction.last_lot_ends_at
      ? (
          <div className="console-v2-auction-closing-window">
            <div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
                Closing window
              </div>
              <div style={{ fontSize: 14, marginTop: 2 }}>
                {formatInTimeZone(auction.ends_at as string, tz)} →{' '}
                {formatInTimeZone(auction.last_lot_ends_at as string, tz)}
                {(() => {
                  const n = lots?.length ?? 0;
                  if (n < 2) return null;
                  const win =
                    new Date(auction.last_lot_ends_at as string).getTime() -
                    new Date(auction.ends_at as string).getTime();
                  const stepSec = win / 1000 / (n - 1);
                  const stepStr =
                    stepSec < 60
                      ? `${Math.round(stepSec)}s/lot`
                      : `${(stepSec / 60).toFixed(1)}min/lot`;
                  return (
                    <span style={{ color: 'var(--fg-muted)', fontSize: 12, marginLeft: 8 }}>
                      · {n} lots · {stepStr}
                    </span>
                  );
                })()}
              </div>
            </div>
            <RedistributeButton
              auctionId={auction.id as string}
              hasWindow={true}
              canEdit={canEdit}
              lotCount={lots?.length ?? 0}
            />
          </div>
        )
      : null;

    const lotsTableNode = !lots?.length
      ? (
          <p style={{ color: 'var(--fg-muted)' }}>
            No lots yet.{' '}
            <Link href={`/auctions/${auction.id}/builder`}>Add from inventory</Link>.
          </p>
        )
      : (
          <LotReorderTable
            auctionId={auction.id as string}
            initial={(lots as unknown as ReorderableLot[]) ?? []}
            canEdit={canEdit}
            warehouseTimezone={tz}
          />
        );

    return (
      <AuctionDetailV2
        auctionId={auction.id as string}
        title={auction.title as string}
        status={auction.status as string}
        warehouseLabel={warehouseLabel}
        startsLabel={formatInTimeZone(auction.starts_at as string, tz)}
        biddingEndsLabel={formatInTimeZone(auction.ends_at as string, tz)}
        pickupWindowLabel={`${formatDateInTimeZone(auction.pickup_starts_at as string, tz)} – ${formatDateInTimeZone(auction.pickup_ends_at as string, tz)}`}
        buyerPremiumLabel={`${(((auction.buyer_premium_bps as number) ?? 0) / 100).toFixed(1)}%`}
        checklist={checklist}
        completedSteps={completed}
        totalApplicableSteps={totalApplicable}
        todoSteps={todoCount}
        canEdit={canEdit}
        canCancel={canCancel}
        showSchedule={auction.status === 'draft'}
        hasLots={(lots?.length ?? 0) > 0}
        activeStatus={activeStatus}
        totalLots={totalLots}
        activeLots={activeLots}
        wonLots={wonLots}
        unsoldLots={unsoldLots}
        totalBids={totalBids}
        noBidLots={noBidLots}
        newlyAddedLots={newlyAddedLots}
        carriedOverLots={carriedOverLots}
        forfeitedReturnLots={forfeitedReturnLots}
        previewQrDataUrl={previewQrDataUrl}
        closingWindow={closingWindowNode}
        featuredCurator={
          <FeaturedImagesCurator
            auctionId={auction.id as string}
            initial={(auction.featured_image_urls as string[]) ?? []}
            canEdit={canEdit}
          />
        }
        lotsTable={lotsTableNode}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title={auction.title as string}
        action={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {canEdit && (
              <Link
                href={`/auctions/${auction.id}/builder`}
                style={{ ...buttonStyle, color: '#000', textDecoration: 'none' }}
              >
                + Add from inventory
              </Link>
            )}
            {canEdit && (
              <Link
                href={`/lots/new?auctionId=${auction.id}`}
                style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
              >
                Add lot manually
              </Link>
            )}
            {canEdit && (
              <Link
                href={`/auctions/${auction.id}/edit`}
                style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
              >
                Edit
              </Link>
            )}
            {canCancel && <CancelAuctionButton auctionId={auction.id as string} />}
            {auction.status === 'draft' && lots && lots.length > 0 && (
              <ScheduleAuctionButton auctionId={auction.id as string} />
            )}
          </div>
        }
      />

      {/* Launch checklist (audit redesign). Sticky-top summary of where
          this auction is in its lifecycle. Operators land on this page
          after creating an auction (per the fix in auctions/new) and
          should see the next required action without scrolling. */}
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: 12 }}>
        Status: <strong style={{ color: 'var(--fg)' }}>{auction.status as string}</strong>
        {' · '}
        <strong
          style={{
            color: completed === totalApplicable ? 'var(--success, #4ade80)' : 'var(--fg)',
          }}
        >
          {completed}/{totalApplicable} steps complete
        </strong>
        {todoCount > 0 ? ` · ${todoCount} required remaining` : ''}
      </p>

      {/* Lot-status / bid-count summary (L0 launch-blocker #2).
          Glance-view of "open vs won vs unsold" and where the bidding
          pressure is during a live auction. Sits above the launch
          checklist so the operator sees real-time state first. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <SummaryTile
          label="Total lots"
          value={totalLots}
          hint="all lots in this auction"
          accent="muted"
        />
        <SummaryTile
          label={activeStatus === 'live' ? 'Live now' : 'Opening'}
          value={activeLots}
          hint={
            activeStatus === 'live'
              ? 'status = live'
              : 'status = scheduled (not yet open)'
          }
          accent="accent"
        />
        <SummaryTile
          label="Won"
          value={wonLots}
          hint="status = won"
          accent="success"
        />
        <SummaryTile
          label="Unsold"
          value={unsoldLots}
          hint="status = unsold"
          accent={unsoldLots > 0 ? 'warning' : 'muted'}
        />
        <SummaryTile
          label="Total bids"
          value={totalBids}
          hint="sum across all lots"
          accent="muted"
        />
        <SummaryTile
          label="No-bid lots"
          value={noBidLots}
          hint="open with 0 bids — needs push"
          accent={noBidLots > 0 ? 'danger' : 'muted'}
        />
      </div>

      {/* M8 provenance breakdown — explains where the lot total came from so a
          "100 → 107" jump between refreshes reads as carried-over / forfeited
          returns rather than a surprise. Newly-added + Carried-over partition
          the total by relist lineage; Forfeited-return is an overlapping lens
          (no-show pickups) shown for visibility. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
          padding: '10px 14px',
          marginBottom: 24,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Provenance of {totalLots} lot{totalLots === 1 ? '' : 's'}:
        </span>
        <ProvenanceStat label="Newly-added" value={newlyAddedLots} hint="first-time lots" />
        <ProvenanceStat
          label="Carried-over"
          value={carriedOverLots}
          hint="relisted from a prior auction"
        />
        <ProvenanceStat
          label="Forfeited-return"
          value={forfeitedReturnLots}
          hint="bidder no-showed / forfeited pickup"
        />
      </div>

      <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {checklist.map((step, idx) => (
          <li
            key={step.title}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '0.75rem 1rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderLeft: `4px solid ${stepColor(step.state)}`,
              borderRadius: 6,
              opacity: step.state === 'na' ? 0.55 : 1,
            }}
          >
            <StepIcon state={step.state} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Step {idx + 1} — {step.title}
              </div>
              <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>
                {step.detail}
              </div>
            </div>
            {step.href && step.state !== 'na' && (
              <Link
                href={step.href}
                style={{ ...secondaryButtonStyle, textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                {step.cta ?? (step.state === 'done' ? 'Edit →' : step.state === 'partial' ? 'Continue →' : 'Start →')}
              </Link>
            )}
          </li>
        ))}
      </ol>

      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          marginBottom: '2rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '1rem',
        }}
      >
        <Stat label="Status" value={auction.status as string} />
        <Stat label="Bidding ends" value={formatInTimeZone(auction.ends_at as string, tz)} />
        <Stat
          label="Pickup window"
          value={`${formatDateInTimeZone(auction.pickup_starts_at as string, tz)} – ${formatDateInTimeZone(auction.pickup_ends_at as string, tz)}`}
        />
        <Stat label="Buyer premium" value={`${(((auction.buyer_premium_bps as number) ?? 0) / 100).toFixed(1)}%`} />
      </section>

      <FeaturedImagesCurator
        auctionId={auction.id as string}
        initial={(auction.featured_image_urls as string[]) ?? []}
        canEdit={canEdit}
      />

      {/* Preview QR (Option C) — print/display at the warehouse door so
          bidders can check in and scan your lot stickers in the app. */}
      <section
        style={{
          marginTop: '1.5rem',
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'flex',
          gap: 20,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            background: '#fff',
            padding: 8,
            borderRadius: 8,
            lineHeight: 0,
            flexShrink: 0,
          }}
        >
          <Image
            src={previewQrDataUrl}
            alt={`Preview QR for ${auction.title as string}`}
            width={180}
            height={180}
            unoptimized
          />
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Preview QR</h2>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.5, marginTop: 6 }}>
            Print or display this at your warehouse door. A bidder scans it once
            in the <strong>BinGo Auctions app</strong> to start previewing this
            auction — after that they can scan the stickers on your lots to open
            or watchlist them. Scanning with a plain phone camera just opens the
            public auction page.
          </p>
          <a
            href={previewQrDataUrl}
            download={`preview-qr-${auction.id as string}.png`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none', display: 'inline-block', marginTop: 4 }}
          >
            ⬇ Download PNG
          </a>
        </div>
      </section>

      {/* Close-time window summary + redistribute action. Only renders
          when the auction has the new last_lot_ends_at endpoint set. */}
      {auction.last_lot_ends_at && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '0.75rem 1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <div
              style={{
                color: 'var(--fg-muted)',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Closing window
            </div>
            <div style={{ fontSize: 14, marginTop: 2 }}>
              {formatInTimeZone(auction.ends_at as string, tz)} →{' '}
              {formatInTimeZone(auction.last_lot_ends_at as string, tz)}
              {(() => {
                const n = lots?.length ?? 0;
                if (n < 2) return null;
                const win =
                  new Date(auction.last_lot_ends_at as string).getTime() -
                  new Date(auction.ends_at as string).getTime();
                const stepSec = win / 1000 / (n - 1);
                const stepStr =
                  stepSec < 60
                    ? `${Math.round(stepSec)}s/lot`
                    : `${(stepSec / 60).toFixed(1)}min/lot`;
                return (
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12, marginLeft: 8 }}>
                    · {n} lots · {stepStr}
                  </span>
                );
              })()}
            </div>
          </div>
          <RedistributeButton
            auctionId={auction.id as string}
            hasWindow={true}
            canEdit={canEdit}
            lotCount={lots?.length ?? 0}
          />
        </section>
      )}

      {!lots?.length ? (
        <div>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Lots (0)</h2>
          <p style={{ color: 'var(--fg-muted)' }}>
            No lots yet.{' '}
            <Link href={`/auctions/${auction.id}/builder`}>Add from inventory</Link>.
          </p>
        </div>
      ) : (
        <LotReorderTable
          auctionId={auction.id as string}
          initial={(lots as unknown as ReorderableLot[]) ?? []}
          canEdit={canEdit}
          warehouseTimezone={tz}
        />
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint: string;
  accent: 'accent' | 'success' | 'warning' | 'danger' | 'muted';
}) {
  const accentColor =
    accent === 'accent'
      ? 'var(--accent)'
      : accent === 'success'
        ? 'var(--success, #4ade80)'
        : accent === 'warning'
          ? 'var(--warning, #fbbf24)'
          : accent === 'danger'
            ? 'var(--danger, #f87171)'
            : 'var(--fg-muted)';
  return (
    <div
      style={{
        padding: 12,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 900, color: accentColor, lineHeight: 1 }}>
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 14 }}>{value}</div>
    </div>
  );
}

// M8: inline provenance stat — a labeled count chip for the provenance strip.
function ProvenanceStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}
      title={hint}
    >
      <strong style={{ fontSize: 16, fontWeight: 900, color: 'var(--fg)' }}>
        {value.toLocaleString()}
      </strong>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
    </span>
  );
}

function stepColor(s: 'done' | 'partial' | 'todo' | 'na'): string {
  if (s === 'done') return 'var(--success, #4ade80)';
  if (s === 'partial') return 'var(--warning, #fbbf24)';
  if (s === 'na') return 'var(--border)';
  return 'var(--danger, #f87171)'; // todo (required, not done)
}

function StepIcon({ state }: { state: 'done' | 'partial' | 'todo' | 'na' }) {
  const color = stepColor(state);
  if (state === 'done') {
    return (
      <span
        aria-label="complete"
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: color,
          color: '#0b0d12',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );
  }
  if (state === 'partial') {
    return (
      <span
        aria-label="in progress"
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ◐
      </span>
    );
  }
  if (state === 'na') {
    return (
      <span
        aria-label="not applicable"
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: `1.5px dashed ${color}`,
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      aria-label="not started"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        flexShrink: 0,
      }}
    />
  );
}
