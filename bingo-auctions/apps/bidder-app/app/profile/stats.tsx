// My Stats — bidder dashboard.
//
// Added 2026-05-24 (Sprint 1 OTA v1.0.1) per POST-V1-PLAN.md row
// "Bidder-side ('My Stats' screen on mobile + web)". Pure read-only
// view of the bidder's own activity. Every query is scoped to the
// caller through RLS (bidder_id = auth.uid()), so we don't pass the
// bidder id explicitly — the RLS policies on `invoices` / `bids` /
// `invoice_lots` / `bin_assignments` enforce that.
//
// Metrics shown (matches POST-V1-PLAN.md):
//   - Total won (count + dollar)              — invoices.status='paid'
//   - Total saved (sum of MSRP - winning bid) — lots.msrp_cents minus invoice_lots.winning_bid_cents
//   - Top 3 categories by spend                — lots.category × invoice_lots.winning_bid_cents
//   - Win rate (last 30d)                       — bids on winning lots / bids placed (manual only)
//   - Pickup history (last 10)                  — bin_assignments.status='picked_up'
//   - Avg time-to-pickup (last 30d)             — picked_up_at - paid_at
//
// Note on schema:
//   - The `invoices` table has invoice_status enum (pending, paid,
//     refunded, partially_refunded, canceled, unpaid_no_show,
//     payment_failed_grace, payment_failed_relisted). There is NO
//     'picked_up' status on invoices — `picked_up` lives on
//     bin_assignments. The task spec referred to a 'picked_up' invoice
//     status; we treat 'paid' as the canonical "won + paid" indicator
//     and use bin_assignments.picked_up_at for actual pickup history.
//
// Loading state: skeleton tiles. The design-system package doesn't ship
// a Skeleton primitive yet, so we render dim placeholder Views that
// match each card's silhouette. No animation library needed (keeps the
// bundle slim and OTA-safe).
//
// Empty state (0 wins): friendly card "Win your first auction to see
// your stats" + Browse CTA. Mirrors the web RecentWins component's
// tone — encouraging, not nagging.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { BrandedButton, colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';

// Surfaces match the rebuilt profile screen.
const SCREEN_BG = colors.bg;
const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const TEXT_DIM = '#5a6276';
const BRAND_GREEN = '#5FE065';
const SUCCESS_DIM = 'rgba(95, 224, 101, 0.10)';

interface CategorySpend {
  category: string;
  totalCents: number;
}

interface PickupRow {
  invoiceId: string;
  lotTitle: string;
  lotPhoto: string | null;
  pickedUpAt: string;
  totalCents: number;
}

interface Stats {
  loading: boolean;
  empty: boolean;
  totalWonCount: number;
  totalWonCents: number;
  totalSavedCents: number;
  topCategories: CategorySpend[];
  winRatePct: number | null; // null = no bids in last 30d
  winsLast30d: number;
  bidsLast30d: number;
  pickups: PickupRow[];
  avgTimeToPickupHours: number | null; // null = no pickups in last 30d
}

const EMPTY_STATS: Stats = {
  loading: true,
  empty: false,
  totalWonCount: 0,
  totalWonCents: 0,
  totalSavedCents: 0,
  topCategories: [],
  winRatePct: null,
  winsLast30d: 0,
  bidsLast30d: 0,
  pickups: [],
  avgTimeToPickupHours: null,
};

type PaidInvoiceRow = {
  id: string;
  subtotal_cents: number;
  total_cents: number;
  paid_at: string;
  invoice_lots: Array<{
    winning_bid_cents: number;
    lots: {
      id: string;
      title: string | null;
      category: string | null;
      msrp_cents: number | null;
      photo_urls: string[] | null;
    } | null;
  }>;
};

type WinningBidRow = {
  lot_id: string;
  lots: {
    id: string;
    winner_bidder_id: string | null;
  } | null;
};

type PickupAssignmentRow = {
  lot_id: string;
  picked_up_at: string;
  lots: {
    id: string;
    title: string | null;
    photo_urls: string[] | null;
  } | null;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function loadStats(): Promise<Stats> {
  const { data: u } = await supabase.auth.getUser();
  const user = u.user;
  if (!user) {
    return { ...EMPTY_STATS, loading: false, empty: true };
  }
  const bidderId = user.id;

  const sinceIso = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  // Parallel reads — RLS scopes each to the bidder.
  // 1. Paid invoices + lots (drives Total won, Total saved, Top categories).
  // 2. Manual bids in last 30d (drives Win rate denominator).
  // 3. Picked-up bin_assignments joined to lots (drives Pickup history
  //    + Avg time-to-pickup). bin_assignments rows have RLS scoped via
  //    `invoice_lots → invoices` so this filter goes through correctly.
  const [
    paidInvoicesQ,
    bidsQ,
  ] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        `id, subtotal_cents, total_cents, paid_at,
         invoice_lots (
           winning_bid_cents,
           lots ( id, title, category, msrp_cents, photo_urls )
         )`,
      )
      .eq('bidder_id', bidderId)
      .eq('status', 'paid')
      .order('paid_at', { ascending: false }),
    supabase
      .from('bids')
      .select('lot_id, lots!lot_id ( id, winner_bidder_id )')
      .eq('bidder_id', bidderId)
      .eq('is_auto', false)
      .gte('placed_at', sinceIso),
  ]);

  const paidInvoices = (paidInvoicesQ.data as unknown as PaidInvoiceRow[] | null) ?? [];
  const recentBids = (bidsQ.data as unknown as WinningBidRow[] | null) ?? [];

  // Coerce nullable bigint columns. Postgres returns numbers for bigint
  // but a null value (e.g. an in-flight invoice) becomes NaN once it hits
  // a + operator, then formatCents(NaN) blanks the hero card and the
  // ErrorBoundary catches the downstream render fault.
  const safeNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const totalWonCount = paidInvoices.length;
  const totalWonCents = paidInvoices.reduce((acc, inv) => acc + safeNum(inv.total_cents), 0);

  let totalSavedCents = 0;
  const categorySpend = new Map<string, number>();

  for (const inv of paidInvoices) {
    for (const il of inv.invoice_lots ?? []) {
      const lot = il.lots;
      if (!lot) continue;
      const msrp = safeNum(lot.msrp_cents);
      const winningBid = safeNum(il.winning_bid_cents);
      if (msrp > 0) {
        const lotSavings = msrp - winningBid;
        if (lotSavings > 0) totalSavedCents += lotSavings;
      }
      const cat = lot.category && lot.category.trim().length > 0 ? lot.category : 'Uncategorized';
      categorySpend.set(cat, (categorySpend.get(cat) ?? 0) + winningBid);
    }
  }

  const topCategories: CategorySpend[] = Array.from(categorySpend.entries())
    .map(([category, totalCents]) => ({ category, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 3);

  // Win rate (last 30d) — count distinct lot_ids where the bidder won
  // versus total distinct lot_ids bid on. Using a Set guards against the
  // bidder having stacked many manual bids on one lot (which would
  // distort the ratio if we counted raw bid rows).
  const lotIdsBid = new Set<string>();
  const lotIdsWon = new Set<string>();
  for (const b of recentBids) {
    lotIdsBid.add(b.lot_id);
    if (b.lots && b.lots.winner_bidder_id === bidderId) {
      lotIdsWon.add(b.lot_id);
    }
  }
  const bidsLast30d = lotIdsBid.size;
  const winsLast30d = lotIdsWon.size;
  const winRatePct =
    bidsLast30d > 0 ? Math.round((winsLast30d / bidsLast30d) * 100) : null;

  // Pickup history. RLS on bin_assignments routes through the lot →
  // invoice_lots → invoices chain; only rows for this bidder's invoices
  // come back. We join lots for the title + photo.
  // Avg time-to-pickup: for assignments in the last 30d, compute
  // (picked_up_at - invoices.paid_at) for the matching invoice. Two-pass
  // because PostgREST doesn't synthesize this delta server-side.
  const pickupQ = await supabase
    .from('bin_assignments')
    .select(
      `lot_id, picked_up_at,
       lots ( id, title, photo_urls )`,
    )
    .eq('status', 'picked_up')
    .not('picked_up_at', 'is', null)
    .order('picked_up_at', { ascending: false })
    .limit(50);

  const pickupRows = (pickupQ.data as unknown as PickupAssignmentRow[] | null) ?? [];

  // Walk paid invoices to find the (lot_id → invoice) map so each pickup
  // row can reference back to its invoice for the photo + total.
  const lotIdToInvoice = new Map<string, { invoiceId: string; paidAt: string; totalCents: number }>();
  for (const inv of paidInvoices) {
    for (const il of inv.invoice_lots ?? []) {
      if (il.lots?.id) {
        lotIdToInvoice.set(il.lots.id, {
          invoiceId: inv.id,
          paidAt: inv.paid_at,
          totalCents: safeNum(inv.total_cents),
        });
      }
    }
  }

  const pickups: PickupRow[] = [];
  let pickupDurationMsSum = 0;
  let pickupDurationCount = 0;
  for (const pa of pickupRows) {
    const lot = pa.lots;
    const inv = lotIdToInvoice.get(pa.lot_id);
    if (!lot || !inv) continue;
    pickups.push({
      invoiceId: inv.invoiceId,
      lotTitle: lot.title ?? '(no title)',
      lotPhoto: lot.photo_urls?.[0] ?? null,
      pickedUpAt: pa.picked_up_at,
      totalCents: inv.totalCents,
    });
    const pickedAtMs = new Date(pa.picked_up_at).getTime();
    const paidAtMs = new Date(inv.paidAt).getTime();
    if (pickedAtMs >= paidAtMs && pickedAtMs - new Date(sinceIso).getTime() >= 0) {
      pickupDurationMsSum += pickedAtMs - paidAtMs;
      pickupDurationCount++;
    }
    if (pickups.length >= 10) break;
  }

  const avgTimeToPickupHours =
    pickupDurationCount > 0
      ? Math.round((pickupDurationMsSum / pickupDurationCount / (60 * 60 * 1000)) * 10) / 10
      : null;

  const empty =
    totalWonCount === 0 &&
    bidsLast30d === 0 &&
    pickups.length === 0 &&
    topCategories.length === 0;

  return {
    loading: false,
    empty,
    totalWonCount,
    totalWonCents,
    totalSavedCents,
    topCategories,
    winRatePct,
    winsLast30d,
    bidsLast30d,
    pickups,
    avgTimeToPickupHours,
  };
}

// Default export wraps the screen body in an ErrorBoundary so a
// render-time throw (typically from formatCents on a malformed value,
// or a null deref inside the pickup rows) lands on a copyable error
// screen instead of silently killing the JS bundle.
export default function StatsScreen() {
  return (
    <ErrorBoundary label="Stats screen">
      <StatsScreenInner />
    </ErrorBoundary>
  );
}

function StatsScreenInner() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  const load = useCallback(async () => {
    try {
      const next = await loadStats();
      setStats(next);
    } catch (err) {

      console.warn('[stats] load failed:', (err as Error).message);
      setStats({ ...EMPTY_STATS, loading: false, empty: true });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (stats.loading) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: SCREEN_BG }}
        contentContainerStyle={{ padding: 16, gap: 12 }}
      >
        <Skeleton height={120} />
        <Skeleton height={88} />
        <Skeleton height={64} />
        <Skeleton height={88} />
        <Skeleton height={88} />
      </ScrollView>
    );
  }

  if (stats.empty) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: SCREEN_BG,
          padding: 16,
          alignItems: 'stretch',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            backgroundColor: CARD_BG,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: CARD_BORDER,
            padding: 20,
            gap: 16,
          }}
        >
          <Text
            style={{
              color: TEXT_PRIMARY,
              fontSize: 18,
              fontWeight: '800',
              textAlign: 'center',
            }}
          >
            Win your first auction to see your stats.
          </Text>
          <Text
            style={{
              color: TEXT_MUTED,
              fontSize: 14,
              textAlign: 'center',
              lineHeight: 20,
            }}
          >
            Your wins, savings, top categories, and pickup history
            will live here.
          </Text>
          <BrandedButton
            variant="primary"
            size="md"
            onPress={() => router.push('/(tabs)/' as never)}
          >
            Browse auctions
          </BrandedButton>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: SCREEN_BG }}
      contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}
    >
      {/* Hero — Total won. Brightest card; the bidder's headline number. */}
      <View
        style={{
          backgroundColor: SUCCESS_DIM,
          borderRadius: 12,
          padding: 20,
          borderWidth: 1,
          borderColor: BRAND_GREEN,
        }}
      >
        <Text
          style={{
            color: BRAND_GREEN,
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Total won
        </Text>
        <Text
          style={{
            color: TEXT_PRIMARY,
            fontSize: 32,
            fontWeight: '900',
            letterSpacing: -1,
          }}
        >
          {formatCents(stats.totalWonCents)}
        </Text>
        <Text
          style={{
            color: TEXT_MUTED,
            fontSize: 14,
            marginTop: 4,
          }}
        >
          across {stats.totalWonCount} lot{stats.totalWonCount === 1 ? '' : 's'}
        </Text>
      </View>

      {/* Total saved. Brag-worthy stat — only meaningful when MSRP > 0. */}
      <StatCard
        label="Total saved"
        primary={formatCents(stats.totalSavedCents)}
        hint={
          stats.totalSavedCents > 0
            ? 'Difference between MSRP and winning bid.'
            : 'Saved totals show up once we have lots with MSRP data.'
        }
      />

      {/* Top categories. Horizontal pill row. Only renders when there's
          at least one category — empty otherwise (the hero already
          shows the bidder has won SOMETHING). */}
      {stats.topCategories.length > 0 && (
        <View
          style={{
            backgroundColor: CARD_BG,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: CARD_BORDER,
          }}
        >
          <Text
            style={{
              color: TEXT_MUTED,
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Top categories
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {stats.topCategories.map((c) => (
              <CategoryPill key={c.category} category={c.category} totalCents={c.totalCents} />
            ))}
          </View>
        </View>
      )}

      {/* Win rate (last 30d). Confidence metric — proxy bids are
          excluded from the denominator so a power-bidder with 200 auto-
          bids doesn't see a misleadingly low win rate. */}
      {stats.winRatePct != null && (
        <StatCard
          label="Win rate (last 30 days)"
          primary={`${stats.winRatePct}%`}
          hint={`${stats.winsLast30d} of ${stats.bidsLast30d} lot${stats.bidsLast30d === 1 ? '' : 's'} bid on.`}
        />
      )}

      {/* Avg time-to-pickup. Operator-side signal masquerading as a
          bidder stat ("do you actually pick stuff up?"). Only renders
          when there's data — otherwise the empty card adds noise. */}
      {stats.avgTimeToPickupHours != null && (
        <StatCard
          label="Avg time to pickup"
          primary={`${stats.avgTimeToPickupHours}h`}
          hint="Time between charge and pickup, last 30 days."
        />
      )}

      {/* Pickup history. Last 10 picked-up lots. Each row tapable into
          the invoice screen so the bidder can pull the receipt. */}
      {stats.pickups.length > 0 && (
        <View
          style={{
            backgroundColor: CARD_BG,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: CARD_BORDER,
          }}
        >
          <Text
            style={{
              color: TEXT_MUTED,
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Recent pickups
          </Text>
          <View style={{ gap: 10 }}>
            {stats.pickups.map((p, idx) => (
              <PickupRowView
                key={`${p.invoiceId}-${p.pickedUpAt}-${idx}`}
                row={p}
                onPress={() =>
                  router.push({
                    pathname: '/invoice/[id]',
                    params: { id: p.invoiceId },
                  })
                }
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function Skeleton({ height }: { height: number }) {
  return (
    <View
      style={{
        height,
        backgroundColor: CARD_BG,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: CARD_BORDER,
      }}
    />
  );
}

function StatCard({
  label,
  primary,
  hint,
}: {
  label: string;
  primary: string;
  hint?: string;
}) {
  return (
    <View
      style={{
        backgroundColor: CARD_BG,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: CARD_BORDER,
      }}
    >
      <Text
        style={{
          color: TEXT_MUTED,
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: TEXT_PRIMARY,
          fontSize: 24,
          fontWeight: '800',
          letterSpacing: -0.5,
        }}
      >
        {primary}
      </Text>
      {hint && (
        <Text
          style={{
            color: TEXT_DIM,
            fontSize: 12,
            marginTop: 4,
            lineHeight: 16,
          }}
        >
          {hint}
        </Text>
      )}
    </View>
  );
}

function CategoryPill({ category, totalCents }: { category: string; totalCents: number }) {
  return (
    <View
      style={{
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: SCREEN_BG,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: BRAND_GREEN,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text
        style={{
          color: TEXT_PRIMARY,
          fontSize: 12,
          fontWeight: '700',
        }}
      >
        {category}
      </Text>
      <Text
        style={{
          color: BRAND_GREEN,
          fontSize: 12,
          fontWeight: '800',
        }}
      >
        {formatCents(totalCents)}
      </Text>
    </View>
  );
}

function PickupRowView({
  row,
  onPress,
}: {
  row: PickupRow;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 8,
        borderRadius: 8,
        backgroundColor: SCREEN_BG,
        opacity: pressed ? 0.7 : 1,
        minHeight: 48, // a11y tap target
      })}
    >
      {row.lotPhoto ? (
        <Image
          source={{ uri: row.lotPhoto }}
          style={{ width: 32, height: 32, borderRadius: 6, backgroundColor: CARD_BG }}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            backgroundColor: CARD_BG,
          }}
        />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{ color: TEXT_PRIMARY, fontSize: 13, fontWeight: '600' }}
          numberOfLines={1}
        >
          {row.lotTitle}
        </Text>
        <Text style={{ color: TEXT_MUTED, fontSize: 11, marginTop: 2 }}>
          {formatRelative(row.pickedUpAt)} · {formatCents(row.totalCents)}
        </Text>
      </View>
    </Pressable>
  );
}

// Tiny relative-time helper. Days for everything > 24h, hours for
// shorter spans, "Just now" for sub-hour. No date-fns dep needed.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 60 * 60 * 1000) return 'Just now';
  if (diffMs < 24 * 60 * 60 * 1000) {
    const hours = Math.round(diffMs / (60 * 60 * 1000));
    return `${hours}h ago`;
  }
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
