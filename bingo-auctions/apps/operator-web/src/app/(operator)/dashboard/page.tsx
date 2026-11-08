// Operator dashboard — landing page after sign-in. Snapshot KPIs + the few
// rows of activity an operator wants every morning.
//
// Data fetched in parallel; counts use HEAD for cheap row-counting.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatCents } from '@auction-platform/shared/money';
import {
  DEFAULT_TIME_ZONE,
  dayRangeInTimeZone,
  formatInTimeZone,
  warehouseTimezone,
} from '@/lib/datetime';
import { addDaysYMD, fetchMoneyDaily, todayInTimeZone } from '@/lib/money-daily';
import { PageHeader } from '@/components/Form';
import { KpiCard, MonoText } from '@/components/console';
import { WelcomeBanner } from './WelcomeBanner';
import { AppsCard } from './AppsCard';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { DashboardV2 } from './v2/DashboardV2';
import { buildFloorStages } from './v2/build-floor-stages';
import { formatCount } from './v2/floor-story';

export default async function DashboardPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Pull operator status to drive the test-mode banner. We fetch in
  // parallel with the rest below to avoid an extra round-trip.
  const operatorStatusP = supabase
    .from('operator_users')
    .select(
      'role, operators(id, business_name, stripe_onboarding_skipped, stripe_onboarding_complete, stripe_charges_enabled, stripe_account_id, stripe_tax_acknowledged_at)',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).toISOString();
  // The money tiles cover the last 7 Chicago calendar days (today + 6), the
  // same days operator_money_daily reports — not a rolling 168 hours.
  const moneyTz = DEFAULT_TIME_ZONE;
  const weekTo = todayInTimeZone(moneyTz, now);
  const weekFrom = addDaysYMD(weekTo, -6);
  const weekStartISO =
    dayRangeInTimeZone(weekFrom, weekTo, moneyTz)?.startISO ??
    new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [
    { count: liveLotCount },
    { count: scheduledAuctionCount },
    { count: todayPickupCount },
    { count: openDisputeCount },
    { data: weekInvoices },
    weekMoney,
    { data: recentLive },
    { data: opStatus },
    // First-run checklist counts. All HEAD queries so they're cheap.
    { count: warehouseCount },
    { count: warehouseWithFloorPlanCount },
    { count: binCount },
    { count: anyLotCount },
    { count: scheduledOrLiveAuctionCount },
    { count: resaleCertPendingCount },
    { count: unpaidInvoiceCount },
  ] = await Promise.all([
    supabase.from('lots').select('id', { count: 'exact', head: true }).eq('status', 'live'),
    supabase
      .from('auctions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'scheduled'),
    supabase
      .from('pickups')
      .select('id', { count: 'exact', head: true })
      .gte('scheduled_at', startOfDay)
      .lt('scheduled_at', endOfDay)
      .in('status', ['pending', 'scheduled']),
    supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    // Platform fees on invoices charged in the window (paid / refunded states,
    // as the money below). Fees only — the money comes from operator_money_daily.
    supabase
      .from('invoices')
      .select('application_fee_cents')
      .in('status', ['paid', 'partially_refunded', 'refunded'])
      .gte('paid_at', weekStartISO),
    // Money for the last 7 Chicago days (mig 0417) — the Money page's
    // calculation: gross charged on the day charged, refunds on the day
    // issued. History: status='paid' dropped refunded invoices whole
    // (2026-07-24); the 0270 fix then subtracted refunds against the sale
    // day, so the week still moved as refunds landed later.
    fetchMoneyDaily(supabase, weekFrom, weekTo, moneyTz),
    supabase
      .from('lots')
      .select('id, title, current_bid_cents, bid_count, close_at, status, warehouses(timezone)')
      .in('status', ['live', 'scheduled'])
      .not('close_at', 'is', null)
      .order('close_at', { ascending: true })
      .limit(8),
    operatorStatusP,
    supabase.from('warehouses').select('id', { count: 'exact', head: true }),
    supabase
      .from('warehouses')
      .select('id', { count: 'exact', head: true })
      .not('floor_plan_url', 'is', null),
    supabase.from('bins').select('id', { count: 'exact', head: true }),
    supabase.from('lots').select('id', { count: 'exact', head: true }),
    supabase
      .from('auctions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['scheduled', 'live', 'closed']),
    // Pending resale-cert (tax-exempt) requests. Read via ADMIN: operator
    // staff have no RLS SELECT on bidders, so an RLS-client count returns 0.
    // Single-operator platform → a global pending count is this operator's.
    getSupabaseAdmin()
      .from('bidders')
      .select('id', { count: 'exact', head: true })
      .eq('resale_cert_status', 'pending'),
    // Invoices that still owe money (2026-07-08 recap: declined invoices in
    // payment_failed_grace were invisible — staff couldn't find unpaid
    // customers). Owed = pending + the payment-failed/no-show states.
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'payment_failed_grace', 'payment_failed_relisted', 'unpaid_no_show']),
  ]);

  // Banner state for test-mode operators (Stripe skipped). Read defensively
  // because old DBs without migration 0035 won't have the column.
  const opStatusTyped = opStatus as unknown as {
    role?: string;
    operators?: {
      id?: string;
      business_name?: string;
      stripe_onboarding_skipped?: boolean | null;
      stripe_account_id?: string | null;
      stripe_onboarding_complete?: boolean | null;
      stripe_charges_enabled?: boolean | null;
      stripe_tax_acknowledged_at?: string | null;
    };
  } | null;
  const operators = opStatusTyped?.operators;
  const stripeSkipped = operators?.stripe_onboarding_skipped === true;
  const stripeConnected = operators?.stripe_onboarding_complete === true;
  // True once Stripe has fully approved the account for live charges.
  // May be false for a window after onboarding_complete=true while Stripe
  // reviews the new account (details submitted but not yet approved).
  const stripeChargesEnabled = operators?.stripe_charges_enabled === true;
  const stripeTaxAcknowledged = operators?.stripe_tax_acknowledged_at != null;
  const isAdmin = opStatusTyped?.role === 'admin';

  // App links — env-driven so we don't hardcode TestFlight URLs that
  // rotate. The operator-web URL is derived from the incoming request
  // host so it works in both prod (bingoauctions.com) and local dev.
  const reqHeaders = await headers();
  const host = reqHeaders.get('host') ?? 'bingoauctions.com';
  const proto = reqHeaders.get('x-forwarded-proto') ?? 'https';
  const operatorWebUrl = `${proto}://${host}`;
  const fieldAppUrl = process.env['TESTFLIGHT_FIELD_URL'] || null;
  const bidderAppUrl = process.env['TESTFLIGHT_BIDDER_URL'] || null;

  // operator_money_daily totals (mig 0417). weekCollected = net collected
  // (incl. tax, after refunds issued in the window); weekNetRevenue strips
  // sales tax, which is collected for the state. null RPC → 0 with a "—".
  const weekCollectedCents = weekMoney?.totals.net_collected_cents ?? 0;
  const weekNetRevenueCents = weekMoney?.totals.net_revenue_cents ?? 0;
  const weekRows = (weekInvoices ?? []) as unknown as Array<{
    application_fee_cents: number | null;
  }>;
  const weekFeeCents = weekRows.reduce(
    (s, i) => s + (i.application_fee_cents ?? 0),
    0,
  );

  // First-run checklist: 6 setup steps. Render only when at least one is
  // incomplete; once everything's set up, hide it so a returning operator's
  // dashboard isn't cluttered.
  //
  // The Stripe Tax step is only relevant for operators with a live Stripe
  // Connect account. For operators in skipped-Stripe test mode, hide the
  // tax step — they have no connected account to enable Stripe Tax on.
  const setupSteps = [
    {
      key: 'warehouse',
      done: (warehouseCount ?? 0) > 0,
      label: 'Create your first warehouse',
      href: '/warehouses/new',
    },
    {
      key: 'floorplan',
      done: (warehouseWithFloorPlanCount ?? 0) > 0,
      label: 'Publish floor plan from scanned bins',
      href: '/warehouses',
    },
    {
      key: 'bins',
      done: (binCount ?? 0) > 0,
      label: 'Add bins to a warehouse',
      href: '/warehouses',
    },
    {
      key: 'inventory',
      done: (anyLotCount ?? 0) > 0,
      label: 'Import inventory (CSV) or create a lot',
      href: '/imports/new',
    },
    {
      key: 'auction',
      done: (scheduledOrLiveAuctionCount ?? 0) > 0,
      label: 'Schedule your first auction',
      href: '/auctions/new',
    },
    // Stripe Tax acknowledgement — only relevant once Stripe Connect is
    // live. Under Path A (LAUNCH_PLAN §2.1) the operator is the merchant
    // of record and responsible for collecting + remitting sales tax in
    // their bidders' jurisdictions. Enabling Stripe Tax on their
    // connected account is the easiest path.
    ...(stripeConnected
      ? [
          {
            key: 'stripe-tax' as const,
            done: stripeTaxAcknowledged,
            label: 'Enable sales tax collection',
            href: '/settings/stripe-tax',
          },
        ]
      : []),
  ];
  const showChecklist = setupSteps.some((s) => !s.done);

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    // Floor-story counts are actionable TODAY, not totals (Braden 2026-10-13).
    // Intake has no reliable count (loads carry no received/processed marker),
    // so it is link-only and runs no query.
    const nowIso = now.toISOString();
    const in2hIso = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    const in24hIso = new Date(now.getTime() + 24 * 3_600_000).toISOString();
    const [
      { count: atCounterPickupCount },
      { count: noStickerLotCount },
      { count: closingWithin2hCount },
      { count: paidPickupEndingCount },
      { data: closingLotsRaw },
    ] = await Promise.all([
      supabase
        .from('pickups')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'checked_in')
        .is('completed_at', null),
      // Lotting: active lots with no sticker code (the BIN-only problem).
      supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .is('sticker_code', null)
        .in('status', ['pending_intake', 'in_inventory', 'scheduled', 'live']),
      // Auction: live lots closing within the next 2 hours.
      supabase
        .from('lots')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .eq('status', 'live')
        .gte('close_at', nowIso)
        .lt('close_at', in2hIso),
      // Paid: paid invoices still awaiting pickup whose pickup window ends < 24 h.
      supabase
        .from('invoices')
        .select('id, auctions!inner(pickup_ends_at), pickups!inner(status)', {
          count: 'exact',
          head: true,
        })
        .eq('status', 'paid')
        .in('pickups.status', ['pending', 'scheduled'])
        .gte('auctions.pickup_ends_at', nowIso)
        .lt('auctions.pickup_ends_at', in24hIso),
      supabase
        .from('lots')
        .select(
          'id, title, lot_code, sticker_code, display_code, current_bid_cents, bid_count, close_at, status, warehouses(timezone)',
        )
        .in('status', ['live', 'scheduled'])
        .not('close_at', 'is', null)
        .order('close_at', { ascending: true })
        .limit(8),
    ]);

    const stages = buildFloorStages({
      atCounter: atCounterPickupCount,
      closingWithin2h: closingWithin2hCount,
      paidPickupEndingWithin24h: paidPickupEndingCount,
      noSticker: noStickerLotCount,
    });

    const eyebrowDate = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const closingLots = (closingLotsRaw ?? []).map((l) => ({
      id: l.id as string,
      title: l.title as string,
      lot_code: (l.lot_code as string | null) ?? null,
      sticker_code: (l.sticker_code as string | null) ?? null,
      display_code: (l.display_code as string | null) ?? null,
      current_bid_cents: l.current_bid_cents as number | null,
      bid_count: (l.bid_count as number) ?? 0,
      close_at: (l.close_at as string | null) ?? null,
      close_label: l.close_at
        ? formatInTimeZone(
            l.close_at as string,
            warehouseTimezone((l as { warehouses?: unknown }).warehouses),
          )
        : '—',
      status: l.status as string,
    }));

    return (
      <DashboardV2
        eyebrow={`Dashboard · ${eyebrowDate}`}
        stages={stages}
        stats={[
          {
            id: 'live-lots',
            label: 'Live lots',
            value: formatCount(liveLotCount ?? 0),
            definition: 'Currently live',
            href: '/lotting/inventory',
            stageHue: 'auction',
          },
          {
            id: 'scheduled-auctions',
            label: 'Scheduled auctions',
            value: formatCount(scheduledAuctionCount ?? 0),
            href: '/auctions',
            stageHue: 'auction',
          },
          {
            id: 'today-pickups',
            label: "Today's pickups",
            value: formatCount(todayPickupCount ?? 0),
            definition: "Pending or scheduled appointments in today's server-local day",
            href: '/pickups',
            stageHue: 'pickup',
          },
        ]}
        decisions={[
          {
            id: 'disputes',
            label: 'Open disputes',
            count: openDisputeCount ?? 0,
            href: '/disputes',
          },
          {
            id: 'resale-certs',
            label: 'Resale certs pending',
            count: resaleCertPendingCount ?? 0,
            href: '/bidders?filter=resale_pending',
          },
          {
            id: 'unpaid-invoices',
            label: 'Unpaid invoices',
            count: unpaidInvoiceCount ?? 0,
            href: '/invoices?status=unpaid',
          },
        ]}
        closingLots={closingLots}
        weekCollectedCents={weekCollectedCents}
        weekNetRevenueCents={weekNetRevenueCents}
        weekPlatformFeesCents={weekFeeCents}
      />
    );
  }

  return (
    <div>
      <PageHeader title="Dashboard" />

      {operators?.id && operators.business_name && (
        <WelcomeBanner
          operatorId={operators.id}
          businessName={operators.business_name}
          fieldAppUrl={fieldAppUrl}
          bidderAppUrl={bidderAppUrl}
        />
      )}

      {stripeSkipped && (
        <div
          style={{
            marginBottom: '1.25rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255, 165, 0, 0.08)',
            border: '1px solid rgba(255, 165, 0, 0.4)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--fg)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong style={{ color: 'orange' }}>Test mode</strong> — payment processing
            isn&apos;t set up. You can build and run auctions, but bidders won&apos;t
            be able to pay for what they win until you finish onboarding.
          </div>
          <Link
            href="/onboarding"
            style={{
              padding: '0.4rem 0.9rem',
              background: 'var(--accent)',
              // Dark navy ink on orange — white-on-orange fails contrast.
              color: '#15233a',
              borderRadius: 4,
              textDecoration: 'none',
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: 'nowrap',
            }}
          >
            Finish setup →
          </Link>
        </div>
      )}

      {/* Shown when the operator submitted Stripe details but Stripe hasn't
          yet approved the account for live charges. Distinct from the
          stripeSkipped banner — this operator DID go through onboarding;
          they're just waiting on Stripe's review (can be minutes to hours). */}
      {stripeConnected && !stripeSkipped && !stripeChargesEnabled && (
        <div
          style={{
            marginBottom: '1.25rem',
            padding: '0.75rem 1rem',
            background: 'rgba(79, 140, 255, 0.07)',
            border: '1px solid rgba(79, 140, 255, 0.35)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--fg)',
          }}
        >
          <strong style={{ color: 'var(--accent)' }}>Payment account review in progress</strong> —
          Your onboarding details have been submitted and the payment processor
          is reviewing the account. Bidder payments will activate automatically
          once approved (typically within 1–2 business days).
        </div>
      )}

      {showChecklist && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Get set up</h2>
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
              {setupSteps.filter((s) => s.done).length} of {setupSteps.length} done
            </span>
          </div>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
            {setupSteps.map((step) => (
              <li
                key={step.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 4,
                  background: step.done ? 'rgba(0, 192, 90, 0.06)' : 'transparent',
                  border: `1px solid ${step.done ? 'rgba(0, 192, 90, 0.25)' : 'var(--border)'}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: step.done ? 'rgba(0, 192, 90, 0.85)' : 'var(--bg)',
                    color: step.done ? '#fff' : 'var(--fg-muted)',
                    border: step.done ? 'none' : '1px solid var(--border)',
                    fontSize: 13,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {step.done ? '✓' : ''}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: step.done ? 'var(--fg-muted)' : 'var(--fg)',
                    textDecoration: step.done ? 'line-through' : 'none',
                  }}
                >
                  {step.label}
                </span>
                {!step.done && (
                  <Link
                    href={step.href}
                    style={{
                      padding: '0.3rem 0.7rem',
                      background: 'var(--accent)',
                      // Dark navy ink on orange — white-on-orange fails contrast.
                      color: '#15233a',
                      borderRadius: 4,
                      textDecoration: 'none',
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Start →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        {/* TODO (Wave B3): /lotting/inventory only shows status='in_inventory' lots
            (the pre-auction holding state). "Live lots" here counts status='live'
            (actively in an auction). A dedicated /auctions?status=live or a live-
            lots sub-view is needed before this link is semantically accurate. For
            now, /lotting/inventory is the closest operator-facing lot list. */}
        <KpiCard label="Live lots" value={String(liveLotCount ?? 0)} href="/lotting/inventory" />
        <KpiCard
          label="Scheduled auctions"
          value={String(scheduledAuctionCount ?? 0)}
          href="/auctions"
        />
        <KpiCard
          label="Today's pickups"
          value={String(todayPickupCount ?? 0)}
          href="/pickups"
          tone={(todayPickupCount ?? 0) > 0 ? 'accent' : 'default'}
        />
        <KpiCard
          label="Open disputes"
          value={String(openDisputeCount ?? 0)}
          href="/disputes"
          tone={(openDisputeCount ?? 0) > 0 ? 'danger' : 'default'}
        />
        <KpiCard
          label="Resale certs pending"
          value={String(resaleCertPendingCount ?? 0)}
          href="/bidders?filter=resale_pending"
          tone={(resaleCertPendingCount ?? 0) > 0 ? 'accent' : 'default'}
        />
        <KpiCard
          label="Unpaid invoices"
          value={String(unpaidInvoiceCount ?? 0)}
          href="/invoices?status=unpaid"
          tone={(unpaidInvoiceCount ?? 0) > 0 ? 'danger' : 'default'}
        />
        <KpiCard
          label="Net collected · 7 days (incl. tax)"
          value={weekMoney ? formatCents(weekCollectedCents) : '—'}
          href="/reports/money"
        />
        <KpiCard
          label="Net revenue · 7 days (excl. tax)"
          value={weekMoney ? formatCents(weekNetRevenueCents) : '—'}
          href="/reports/money"
          tone="accent"
        />
        <KpiCard
          label="Platform fees (7 days)"
          value={formatCents(weekFeeCents)}
          href="/invoices"
          muted
        />
        {isAdmin && (
          <KpiCard
            label="Worker productivity"
            value="View report"
            href="/dashboard/workers"
            muted
          />
        )}
      </section>

      <section>
        <h2 style={{ fontSize: '1.05rem' }}>Closing soon</h2>
        {!recentLive?.length ? (
          <p style={{ color: 'var(--fg-muted)' }}>No live or scheduled lots.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
            {recentLive.map((l) => (
              <li
                key={l.id as string}
                style={{
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    <Link href={`/lots/${l.id}`}>{l.title}</Link>
                  </div>
                  <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                    {l.bid_count as number} bids · closes{' '}
                    {l.close_at
                      ? formatInTimeZone(
                          l.close_at as string,
                          warehouseTimezone((l as { warehouses?: unknown }).warehouses),
                        )
                      : '—'}
                  </div>
                </div>
                <MonoText style={{ fontSize: 14, color: 'var(--fg)', textAlign: 'right' }}>
                  {l.current_bid_cents != null
                    ? formatCents(l.current_bid_cents as number)
                    : '—'}
                </MonoText>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AppsCard
        operatorWebUrl={operatorWebUrl}
        fieldAppUrl={fieldAppUrl}
        bidderAppUrl={bidderAppUrl}
      />
    </div>
  );
}
