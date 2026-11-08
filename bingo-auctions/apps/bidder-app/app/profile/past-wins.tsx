// /profile/past-wins — every lot the bidder has ever won across closed auctions.
//
// Query path: lots where winner_bidder_id = me, joined to the invoice that
// covers the lot (via invoice_lots) plus the lot's pickup row, then to
// auctions for the auction title. All three joins are optional so a won lot
// with no invoice yet (debounce window) or no pickup row still surfaces.
//
// Status is computed client-side from invoice.status + pickup.status:
//   paid_pickedup        invoice='paid' + pickup='completed'
//   paid_awaiting        invoice='paid' + pickup IN ('pending','scheduled')
//   paid_no_show         invoice='paid' + pickup='no_show'
//   unpaid_card_declined invoice IN ('payment_failed_grace','payment_failed_relisted','unpaid_no_show')
//   unpaid_pending       invoice='pending' (or no invoice row yet)
//   refunded             invoice IN ('refunded','partially_refunded')
//   forfeited            pickup='forfeited' (defensive — enum value exists in mig 0001)
//
// RLS notes:
//   lots — public read (open auction browsing)
//   invoice_lots — invoices_self_read scopes via invoices.bidder_id = auth.uid()
//   pickups — pickups_self_read scopes via the same invoices chain
//   refund_jobs — operator-only read; status surfaced via invoice.status instead
//
// Filter chips: All / Picked up / Awaiting pickup / Issues
// Sort: most recent win first (lots.close_at DESC). Paginate at 50.

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase, getCurrentUserId } from '@auction-platform/supabase-client';
import { formatCents, lotDisplayCode } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';

// ─── constants ────────────────────────────────────────────────────────────────

const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const TEXT_DIM = '#5a6276';
const BRAND_GREEN = '#5FE065';
const BRAND_AMBER = '#FFB800';
const BRAND_RED = '#FF3B3B';
const BRAND_BLUE = '#6390FF';
const PAGE_SIZE = 50;
const DEFAULT_WINS_TZ = 'America/Chicago';

/** Format a lot close_at in the auction's warehouse timezone (date only). */
function fmtCloseDate(iso: string, tz: string | null | undefined): string {
  const resolvedTz = tz && tz.length > 0 ? tz : DEFAULT_WINS_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: resolvedTz,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: DEFAULT_WINS_TZ,
    }).format(new Date(iso));
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

type WinStatus =
  | 'paid_pickedup'
  | 'paid_awaiting'
  | 'paid_no_show'
  | 'unpaid_card_declined'
  | 'unpaid_pending'
  | 'refunded'
  | 'forfeited';

type FilterChip = 'all' | 'paid' | 'awaiting' | 'issues';

interface WinRow {
  lot_id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  lot_title: string;
  auction_title: string | null;
  close_at: string | null;
  /** IANA timezone of the auction's warehouse; null when unavailable. */
  warehouse_tz: string | null;
  winning_bid_cents: number | null;
  invoice_id: string | null;
  invoice_status: string | null;
  pickup_id: string | null;
  pickup_status: string | null;
  status: WinStatus;
}

// Raw shape returned from Supabase before we compute status.
interface RawLot {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  close_at: string | null;
  auction_id: string | null;
  auctions: { id: string; title: string | null; warehouses: { timezone: string | null } | null } | null;
  invoice_lots: Array<{
    winning_bid_cents: number;
    invoices: {
      id: string;
      status: string;
      pickups: Array<{ id: string; status: string }> | { id: string; status: string } | null;
    } | null;
  }> | null;
}

// ─── status helpers ───────────────────────────────────────────────────────────

function computeStatus(
  invoiceStatus: string | null,
  pickupStatus: string | null,
): WinStatus {
  // Forfeit takes priority — pickup status overrides invoice state.
  if (pickupStatus === 'forfeited') return 'forfeited';

  if (invoiceStatus === 'refunded' || invoiceStatus === 'partially_refunded') {
    return 'refunded';
  }
  if (
    invoiceStatus === 'payment_failed_grace' ||
    invoiceStatus === 'payment_failed_relisted' ||
    invoiceStatus === 'unpaid_no_show'
  ) {
    return 'unpaid_card_declined';
  }
  if (invoiceStatus === 'paid') {
    if (pickupStatus === 'completed') return 'paid_pickedup';
    if (pickupStatus === 'no_show') return 'paid_no_show';
    // pending, scheduled, or no pickup row yet → awaiting
    return 'paid_awaiting';
  }
  // pending or no invoice yet
  return 'unpaid_pending';
}

interface StatusPill {
  label: string;
  bg: string;
  fg: string;
}

function statusPill(s: WinStatus): StatusPill {
  switch (s) {
    case 'paid_pickedup':
      return { label: 'Paid · Picked up', bg: 'rgba(95,224,101,0.12)', fg: BRAND_GREEN };
    case 'paid_awaiting':
      return { label: 'Paid · Awaiting pickup', bg: 'rgba(255,184,0,0.12)', fg: BRAND_AMBER };
    case 'paid_no_show':
      return { label: 'Paid · No-show', bg: 'rgba(255,184,0,0.15)', fg: BRAND_AMBER };
    case 'unpaid_card_declined':
      return { label: 'Unpaid · Card declined', bg: 'rgba(255,59,59,0.12)', fg: BRAND_RED };
    case 'unpaid_pending':
      return { label: 'Unpaid · Pending', bg: 'rgba(255,184,0,0.12)', fg: BRAND_AMBER };
    case 'refunded':
      return { label: 'Refunded', bg: 'rgba(99,144,255,0.12)', fg: BRAND_BLUE };
    case 'forfeited':
      return { label: 'Forfeited', bg: 'rgba(255,59,59,0.08)', fg: BRAND_RED };
  }
}

// Whether a status belongs to each filter chip.
function matchesChip(s: WinStatus, chip: FilterChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'paid') return s === 'paid_pickedup';
  if (chip === 'awaiting') return s === 'paid_awaiting' || s === 'paid_no_show';
  if (chip === 'issues') {
    return (
      s === 'unpaid_card_declined' ||
      s === 'unpaid_pending' ||
      s === 'refunded' ||
      s === 'forfeited'
    );
  }
  return true;
}

// ─── data loading ─────────────────────────────────────────────────────────────

async function fetchWins(userId: string): Promise<WinRow[]> {
  // lots where the bidder won, joining:
  //   auctions → for the title
  //   invoice_lots → winning_bid_cents + invoice (status + pickup)
  //
  // invoice_lots!inner would exclude lots without an invoice row.
  // We use the regular (LEFT) join so lots still in the build_invoice_jobs
  // debounce window (no invoice yet) still surface as 'unpaid_pending'.
  //
  // PostgREST limitation: we can only filter the root table, so
  // winner_bidder_id=userId is a direct column filter. RLS additionally
  // enforces invoices.bidder_id = auth.uid() on the embedded invoice rows.
  const { data, error } = await supabase
    .from('lots')
    .select(
      `id, lot_code, sticker_code, display_code, title, close_at, auction_id,
       auctions(id, title, warehouses(timezone)),
       invoice_lots(
         winning_bid_cents,
         invoices(
           id, status,
           pickups(id, status)
         )
       )`,
    )
    .eq('winner_bidder_id', userId)
    .not('close_at', 'is', null)
    .order('close_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (error || !data) return [];

  const rows: WinRow[] = [];
  for (const raw of data as unknown as RawLot[]) {
    // Pick the first invoice_lot (lots belong to one invoice per auction).
    const il = raw.invoice_lots?.[0] ?? null;
    const inv = il?.invoices ?? null;
    // Pick the first pickup row (one pickup per invoice).
    // pickups is UNIQUE on invoice_id → PostgREST returns a to-one object,
    // not an array. Normalize both shapes (matches my-bids.tsx / queue.tsx).
    const pickup = (Array.isArray(inv?.pickups) ? inv?.pickups[0] : inv?.pickups) ?? null;

    const invoiceStatus = inv?.status ?? null;
    const pickupStatus = pickup?.status ?? null;

    // Skip lots whose auction hasn't truly closed yet (defensive).
    const nowMs = Date.now();
    const closeAtMs = raw.close_at ? new Date(raw.close_at).getTime() : 0;
    if (closeAtMs > nowMs) continue;

    // Normalise the warehouses embed (supabase-js may return array or object).
    const whEmbed = raw.auctions?.warehouses;
    const warehouseTz: string | null = Array.isArray(whEmbed)
      ? (whEmbed[0]?.timezone ?? null)
      : (whEmbed?.timezone ?? null);

    rows.push({
      lot_id: raw.id,
      lot_code: raw.lot_code,
      sticker_code: raw.sticker_code,
      display_code: raw.display_code,
      lot_title: raw.title,
      auction_title: raw.auctions?.title ?? null,
      close_at: raw.close_at,
      warehouse_tz: warehouseTz,
      winning_bid_cents: il?.winning_bid_cents ?? null,
      invoice_id: inv?.id ?? null,
      invoice_status: invoiceStatus,
      pickup_id: pickup?.id ?? null,
      pickup_status: pickupStatus,
      status: computeStatus(invoiceStatus, pickupStatus),
    });
  }
  return rows;
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function PastWinsScreen() {
  return (
    <ErrorBoundary label="Past wins">
      <PastWinsInner />
    </ErrorBoundary>
  );
}

function PastWinsInner() {
  const router = useRouter();
  const [wins, setWins] = useState<WinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chip, setChip] = useState<FilterChip>('all');

  const load = useCallback(async (isRefresh = false) => {
    setError(null);
    if (!isRefresh) setLoading(true);
    const uid = await getCurrentUserId();
    if (!uid) {
      setWins([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const rows = await fetchWins(uid);
    setWins(rows);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const visible = wins.filter((w) => matchesChip(w.status, chip));

  // Count per chip label for badge display.
  const countAll = wins.length;
  const countPaid = wins.filter((w) => w.status === 'paid_pickedup').length;
  const countAwaiting = wins.filter(
    (w) => w.status === 'paid_awaiting' || w.status === 'paid_no_show',
  ).length;
  const countIssues = wins.filter((w) =>
    matchesChip(w.status, 'issues'),
  ).length;

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={BRAND_GREEN} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Filter chips */}
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: CARD_BORDER,
          paddingVertical: 12,
          paddingHorizontal: 12,
        }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          <Chip
            label="All"
            count={countAll}
            active={chip === 'all'}
            color={TEXT_PRIMARY}
            onPress={() => setChip('all')}
          />
          {/* Labeled "Picked up", NOT "Paid": this chip counts paid_pickedup
              (fully collected) only. Labeling it "Paid" made a customer who had
              paid every invoice but not yet picked up see "Paid 0" and read it
              as "the app thinks I never paid" (customer report, 2026-07-13).
              "Paid · Awaiting pickup" already lives on each card + the Awaiting
              chip, so paid-ness is never hidden. */}
          <Chip
            label="Picked up"
            count={countPaid}
            active={chip === 'paid'}
            color={BRAND_GREEN}
            onPress={() => setChip('paid')}
          />
          <Chip
            label="Awaiting pickup"
            count={countAwaiting}
            active={chip === 'awaiting'}
            color={BRAND_AMBER}
            onPress={() => setChip('awaiting')}
          />
          <Chip
            label="Issues"
            count={countIssues}
            active={chip === 'issues'}
            color={BRAND_RED}
            highlight={countIssues > 0}
            onPress={() => setChip('issues')}
          />
        </ScrollView>
      </View>

      {error && (
        <View
          style={{
            margin: 12,
            padding: 10,
            backgroundColor: 'rgba(255,59,59,0.08)',
            borderRadius: 8,
            borderWidth: 1,
            borderColor: BRAND_RED,
          }}
        >
          <Text style={{ color: BRAND_RED, fontSize: 12, fontWeight: '700' }}>
            Couldn&apos;t load wins
          </Text>
          <Text style={{ color: TEXT_PRIMARY, fontSize: 12, marginTop: 4 }}>{error}</Text>
        </View>
      )}

      <FlatList
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={TEXT_MUTED}
            onRefresh={() => {
              setRefreshing(true);
              load(true);
            }}
          />
        }
        data={visible}
        keyExtractor={(item) => item.lot_id}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 32 }}
        renderItem={({ item }) => (
          <WinCard
            win={item}
            onPress={() => {
              if (item.invoice_id) {
                router.push({ pathname: '/invoice/[id]', params: { id: item.invoice_id } });
              }
            }}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: 32, alignItems: 'center' }}>
            <Text
              style={{
                color: TEXT_MUTED,
                textAlign: 'center',
                lineHeight: 22,
                fontSize: 14,
              }}
            >
              {wins.length === 0
                ? "You haven't won any auctions yet. Win a lot and it'll show up here."
                : chip === 'paid'
                  ? 'No fully picked-up wins yet.'
                  : chip === 'awaiting'
                    ? 'Nothing awaiting pickup right now.'
                    : 'No issues to resolve.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function Chip({
  label,
  count,
  active,
  color,
  highlight,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  color: string;
  highlight?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Filter: ${label} (${count})`}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: active || highlight ? 2 : 1,
        borderColor: active ? color : highlight ? color : CARD_BORDER,
        backgroundColor: active ? color + '22' : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Text
        style={{
          color: active ? color : TEXT_MUTED,
          fontSize: 12,
          fontWeight: '900',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <View
        style={{
          paddingHorizontal: 8,
          paddingVertical: 1,
          backgroundColor: count > 0 ? color : CARD_BORDER,
          borderRadius: 999,
          minWidth: 20,
          alignItems: 'center',
        }}
      >
        <Text
          style={{
            color: count > 0 ? '#000' : TEXT_DIM,
            fontSize: 11,
            fontWeight: '900',
          }}
        >
          {count}
        </Text>
      </View>
    </Pressable>
  );
}

function WinCard({
  win,
  onPress,
}: {
  win: WinRow;
  onPress: () => void;
}) {
  const pill = statusPill(win.status);
  const hasInvoice = !!win.invoice_id;

  const dateStr = win.close_at ? fmtCloseDate(win.close_at, win.warehouse_tz) : '';

  const priceLabel = win.winning_bid_cents != null
    ? formatCents(win.winning_bid_cents)
    : '—';

  return (
    <Pressable
      onPress={hasInvoice ? onPress : undefined}
      accessibilityRole={hasInvoice ? 'button' : 'none'}
      accessibilityLabel={`${lotDisplayCode(win) ?? win.lot_code} — ${win.lot_title}, ${pill.label}, ${priceLabel}`}
      style={({ pressed }) => ({
        backgroundColor: CARD_BG,
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: CARD_BORDER,
        opacity: pressed && hasInvoice ? 0.8 : 1,
      })}
    >
      {/* Top row: lot code + price */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 4,
        }}
      >
        <Text
          style={{
            color: colors.primary,
            fontFamily: 'monospace',
            fontSize: 11,
            fontWeight: '900',
            letterSpacing: 0.4,
          }}
        >
          {lotDisplayCode(win) ?? win.lot_code}
        </Text>
        <Text style={{ color: TEXT_PRIMARY, fontSize: 15, fontWeight: '900' }}>
          {priceLabel}
        </Text>
      </View>

      {/* Lot title */}
      <Text
        style={{
          color: TEXT_PRIMARY,
          fontSize: 15,
          fontWeight: '700',
          marginBottom: 6,
        }}
        numberOfLines={2}
      >
        {win.lot_title}
      </Text>

      {/* Auction name + date */}
      <Text style={{ color: TEXT_MUTED, fontSize: 12, marginBottom: 10 }} numberOfLines={1}>
        {win.auction_title ?? 'Auction'}
        {dateStr ? ` · ${dateStr}` : ''}
      </Text>

      {/* Status pill + invoice link hint */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <View
          style={{
            backgroundColor: pill.bg,
            paddingVertical: 3,
            paddingHorizontal: 10,
            borderRadius: 6,
          }}
        >
          <Text
            style={{
              color: pill.fg,
              fontSize: 11,
              fontWeight: '800',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {pill.label}
          </Text>
        </View>
        {hasInvoice && (
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>
            View receipt →
          </Text>
        )}
      </View>
    </Pressable>
  );
}
