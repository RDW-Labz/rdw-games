// Lot detail — Realtime subscription + place-bid + watchlist.
// The Supabase Realtime channel pushes UPDATE events on the lots row, so
// current_bid_cents and close_at update live as other bidders bid.
//
// Wave 1C additions (2026-05-23):
//   - SavingsCallout    — SAVE % pill + strikethrough MSRP
//   - PickupInfoCard    — Auction ends / Pickup by / bin location + NOT TRANSFERRABLE
//   - AnonymizedBidHistory — stable Bidder #N map + YOU highlight + Show all expansion
//   - SimilarLotsRail   — 3-tier fallback horizontal FlatList using shared LotCard

import {
  Animated,
  View,
  Text,
  ScrollView,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Alert,
  AppState,
  Linking,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { supabase } from '@auction-platform/supabase-client';
import { bidCountLabel, lotOutcome, outbidMessage } from '../../lib/lot-outcome';
import { quickBidConfirmCopy } from '../../lib/quick-bid-confirm';
import { track } from '@auction-platform/supabase-client';
import {
  formatCents,
  lotDisplayCode,
  nextMinimumBidCents,
  IDENTITY_VERIFICATION_THRESHOLD_CENTS,
  describeAutoRaise,
  autoRaiseMessage,
  type PlaceBidResult,
  type BidIncrementTier,
  type AutoRaiseStatus,
} from '@auction-platform/shared';
// 2026-05-21 (migration 0105): the lot detail screen surfaces two new
// place_bid rejection reasons — 'no_payment_method' and 'unpaid_fees'.
// Both route the bidder to a fix-it screen via inline banners below
// the title; the one-tap counter button also routes through the same
// dispatcher so an outbid → counter → rejected flow lands the user in
// the right place.
import { addRecentlyViewed } from '@auction-platform/domain-bidding';
import { PlaceBidSheet } from '@auction-platform/domain-bidding';
import { BuyNowSheet } from '@auction-platform/domain-bidding';
import { WatchlistToggle } from '@auction-platform/domain-bidding';
import { PhotoCarousel } from '@auction-platform/domain-bidding';
import { LiveBidTicker } from '@auction-platform/domain-bidding';
import { LotCard } from '@auction-platform/domain-bidding';
import type { LotCardData } from '@auction-platform/domain-bidding';
import {
  colors,
  type,
  formatCountdown,
  heatFromCloseAt,
  heatColor,
} from '@auction-platform/design-system';
import {
  OperatorPolicyModal,
  type OperatorPolicyForModal,
} from './_OperatorPolicyModal';
import { OffsiteNoticeModal } from './_OffsiteNoticeModal';
import {
  lookupOffsiteNoticeGateForLot,
  markOffsiteNoticeAckedInCache,
  type OffsiteNoticeGateLookup,
} from '@/lib/offsite-notice-gate';
import type { WarehousePickupDescribed as OffsiteNoticePickup } from '@/lib/warehouse-pickup';
import {
  captureLotViewed,
  captureBidOutbid,
  type LotViewSource,
} from '@/lib/analytics';
import { fetchDiscoverableAuctionIds } from '@/lib/discoverable-auctions';
import {
  describeWarehousePickup,
  fetchWarehousePickup,
  type WarehousePickupDescribed,
} from '@/lib/warehouse-pickup';
import { requireZip } from '@/lib/zip-gate';

// Soft-close popcorn extensions reset close_at to now()+soft_close_minutes.
// We treat any close_at that moved forward by ≥30s as "extension fired"
// for banner / haptic purposes. Smaller jumps (clock skew, retry races)
// are ignored. We additionally require bid_count to have incremented so
// a server-side retry that recomputes close_at without a new bid doesn't
// fire the banner twice.
const EXTENSION_THRESHOLD_MS = 30_000;
const EXTENSION_BANNER_MS = 4_000;

// Bid history: first 15 rows visible inline; rest behind "Show all" toggle.
const BID_HISTORY_INITIAL = 15;

// Similar lots carousel item width (px). Snap interval matches this.
const SIMILAR_ITEM_WIDTH = 200;
// Min results to accept from tier-1/2 similar-lots query before falling back.
const SIMILAR_MIN = 4;
const SIMILAR_LIMIT = 8;

// Friendly copy for place_bid RPC result.reason values. Mirrors the
// table in PlaceBidSheet so the one-tap counter speaks the same language.
const COUNTER_REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Please sign in to bid.',
  not_a_bidder: 'Your bidder account is missing. Try signing out and back in.',
  lot_not_found: 'This lot no longer exists.',
  lot_not_biddable: 'Bidding has ended or is paused on this lot.',
  lot_closed: 'This lot has closed.',
  below_starting_bid: 'Your bid is below the starting bid.',
  below_min_increment: 'The minimum just changed — try again.',
  // 0105: handled with a route instead of a plain alert — see
  // dispatchRejectionAction below.
  no_payment_method: 'Add a card to bid.',
  unpaid_fees: 'Pay outstanding fees to bid.',
  // 0176: bidder has an invoice in the payment_failed_grace window at THIS
  // operator. Routed to /profile/invoices (see dispatchRejectionAction) so
  // they can pay it and resume bidding here.
  unpaid_invoice: 'Settle your unpaid invoice to keep bidding with this seller.',
};

type Lot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  description: string | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string;
  status: string;
  msrp_cents: number | null;
  condition: string;
  bid_count: number;
  winner_bidder_id: string | null;
  flat_price_cents: number | null;
  dutch_start_cents: number | null;
  dutch_floor_cents: number | null;
  dutch_decline_per_minute_cents: number | null;
  photo_urls: string[];
  // operator_id is the foreign key we use to look up the per-operator
  // policy + acceptance row. It's redundant with operators.id (when the
  // join lands) but we need the column for the case where the joined
  // operators row hasn't loaded yet, and PostgREST cheerfully returns
  // both shapes from the same select.
  operator_id: string;
  // auction_id + category are needed for the similar-lots 3-tier fallback.
  auction_id: string | null;
  category: string | null;
  // Product identifiers (Stream C) — surfaced in the Identifiers block below.
  // All public-safe columns on lots; never cost_cents / return_reason / pallet_id.
  brand: string | null;
  model: string | null;
  upc: string | null;
  asin: string | null;
  fnsku: string | null;
  lpn: string | null;
  mpn: string | null;
  // Structured SKUs (Stream A, mig 0188) — round-tripped from import_rows.
  product_sku: string | null;
  site_sku: string | null;
  manufacture_sku: string | null;
  auctions: {
    warehouse_id?: string;
    format: 'standard' | 'dutch' | 'last_chance';
    starts_at: string;
    /** 0221: preview pre-bidding — bids allowed before starts_at. */
    prebid_enabled?: boolean | null;
    pickup_ends_at: string | null;
    // BID-3: per-auction increment override (wins over operator default).
    bid_increment_schedule: BidIncrementTier[] | null;
    // Effective buyer's premium for this auction (basis points). Surfaced at
    // the first-bid agreement gate + the anytime operator-terms card — never
    // on the always-visible lot face (per owner's fee-disclosure model).
    buyer_premium_bps: number;
    warehouses: { timezone: string | null } | null;
  } | null;
  operators: {
    business_name: string;
    logo_url: string | null;
    brand_color: string | null;
    // BID-3: operator default increment ladder (null = legacy ladder).
    bid_increment_schedule: BidIncrementTier[] | null;
    // offers_shipping is the SINGLE source of truth for shipping availability
    // (operators table). The checkout fulfillment chooser, set_invoice_fulfillment
    // RPC, and /api/shipping/quote all read this column — the lot page must too.
    // (Prior bug: this page read operator_policies.shipping_offered, a stale
    // duplicate flag that defaulted false → "Shipping: not available" even when
    // the operator had enabled shipping in Settings → Fulfillment.)
    offers_shipping: boolean | null;
    // Operator default buyer's premium (basis points) — fallback when the
    // auction carries no per-auction override. Display-only on this screen.
    default_buyer_premium_bps: number;
  } | null;
};

// Active per-operator policy shape. PR-A1 (2026-05-29, mig 0157) added 4
// structured fee/policy fields. PR-B (2026-05-29) reads them directly from
// the operator_policies table instead of through get_active_operator_policy()
// because that RPC's RETURNS TABLE signature pre-dates 0157 and would need
// a follow-up migration to add the new columns. Direct select is safe:
// operator_policies has `select_published_for_anon` RLS (mig 0088).
type OperatorPolicy = {
  operator_id: string;
  version: number;
  terms_md: string;
  refund_md: string;
  shipping_md: string;
  payment_window_hours: number;
  pickup_window_days: number;
  refund_window_post_pickup_hours: number;
  // PR-A1 (mig 0157) — bidder-facing forfeit / restock / relist disclosures.
  no_show_policy: 'full_forfeit' | 'refund_minus_restock';
  restock_fee_cents: number;
  relist_fee_cents: number;
  admin_can_refund_outside_window: boolean;
  effective_at: string;
};

// Raw bid row from Supabase — bidder_id is a UUID that equals auth.users.id
// (bidders.id is a FK to auth.users.id per migration 0001).
type BidRow = {
  id: string;
  bidder_id: string;
  amount_cents: number;
  is_auto: boolean;
  placed_at: string;
};

// Customer-facing item location, via the lot_public_location RPC (mig 0255).
// kind 'pickup' = staged for pickup; 'shelf' = intake shelf (preview/live —
// where a preview visitor finds the item on the warehouse floor).
type BinLocation = {
  aisle: string | null;
  bay: string | null;
  code: string | null;
  kind: 'pickup' | 'shelf';
};

// Similar lot — shape used for the carousel cards.
type SimilarLotRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string;
  status: string;
  bid_count: number;
  condition: string | null;
  msrp_cents: number | null;
};

type SimilarLotsMode =
  | 'same-auction-category'
  | 'same-auction'
  | 'same-category'
  | 'none';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_WAREHOUSE_TZ = 'America/Chicago';

function formatDateTime(iso: string, timeZone?: string | null): string {
  const d = new Date(iso);
  const tz = timeZone && timeZone.length > 0 ? timeZone : DEFAULT_WAREHOUSE_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(d);
  } catch {
    // Guard against an invalid IANA string slipping through.
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEFAULT_WAREHOUSE_TZ,
    }).format(d);
  }
}

function formatBinLocation(bin: BinLocation): string {
  const parts: string[] = [];
  if (bin.aisle) parts.push(`Aisle ${bin.aisle}`);
  if (bin.bay) parts.push(`Bay ${bin.bay}`);
  if (parts.length === 0) return bin.code ?? '';
  // Physical bins are labeled with the code — include it so a preview
  // customer can match the shelf tag, not just the aisle.
  return bin.code ? `${parts.join(', ')} · ${bin.code}` : parts.join(', ');
}

// Build a stable bidder-id → sequential number mapping for anonymization.
// Sorted alphabetically by bidder_id so the mapping is deterministic
// across renders. The viewer's own bids display as "YOU" and are excluded
// from the number sequence.
function buildAnonMap(
  bids: BidRow[],
  viewerBidderId: string | null,
  // mig 0254: permanent account numbers (via bidder_public_numbers RPC).
  // Preferred when present; the sequence only labels rows missing one.
  persistentNumbers?: Map<string, number>,
): Map<string, number> {
  const uniqueIds = Array.from(new Set(bids.map((b) => b.bidder_id)));
  uniqueIds.sort();
  const map = new Map<string, number>();
  let n = 1;
  for (const bid_id of uniqueIds) {
    if (bid_id === viewerBidderId) continue;
    const persistent = persistentNumbers?.get(bid_id);
    if (persistent !== undefined) {
      map.set(bid_id, persistent);
    } else {
      map.set(bid_id, n);
      n += 1;
    }
  }
  return map;
}

// Permanent "Bidder #N" lookup (customer request 2026-07-09: numbers that
// stay the same across every auction, like older platforms). Fetches once
// per distinct bidder-id set; failure just falls back to per-page numbers.
function usePersistentBidderNumbers(bids: BidRow[]): Map<string, number> {
  const [numbers, setNumbers] = useState<Map<string, number>>(new Map());
  const idsKey = useMemo(
    () => Array.from(new Set(bids.map((b) => b.bidder_id))).sort().join(','),
    [bids],
  );
  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.rpc('bidder_public_numbers', {
        p_bidder_ids: idsKey.split(','),
      });
      if (cancelled || !Array.isArray(data)) return;
      setNumbers(
        new Map(
          (data as Array<{ bidder_id: string; bidder_number: number | null }>)
            .filter((r) => r.bidder_number !== null)
            .map((r) => [r.bidder_id, r.bidder_number as number]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey]);
  return numbers;
}

// ─── Similar lots loader ──────────────────────────────────────────────────────
//
// Three-tier fallback so the carousel always has something to show on an
// active auction page. Order: same auction + same category → same auction
// (any category) → any open, LISTED auction + same category. Tiers 1-2 stay
// inside the viewed lot's own auction, so a tester on an unlisted test lot
// still sees its siblings; tier 3 reaches other auctions, so it must skip
// unlisted test auctions (mig 0242) or they leak onto real customers' pages.

const SIMILAR_COLS =
  'id, lot_code, sticker_code, display_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, status, bid_count, condition, msrp_cents';

async function loadSimilarLots(lot: Lot): Promise<{
  lots: SimilarLotRow[];
  mode: SimilarLotsMode;
}> {
  // Tier 1: same auction + same category.
  if (lot.auction_id && lot.category) {
    const { data } = await supabase
      .from('lots')
      .select(SIMILAR_COLS)
      .eq('auction_id', lot.auction_id)
      .eq('category', lot.category)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(SIMILAR_LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length >= SIMILAR_MIN) {
      return { lots, mode: 'same-auction-category' };
    }
  }

  // Tier 2: same auction, any category.
  if (lot.auction_id) {
    const { data } = await supabase
      .from('lots')
      .select(SIMILAR_COLS)
      .eq('auction_id', lot.auction_id)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(SIMILAR_LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length >= SIMILAR_MIN) {
      return { lots, mode: 'same-auction' };
    }
  }

  // Tier 3: any open, listed auction, same category.
  const discoverableAuctionIds = lot.category
    ? await fetchDiscoverableAuctionIds(supabase)
    : [];
  if (lot.category && discoverableAuctionIds.length > 0) {
    const { data } = await supabase
      .from('lots')
      .select(SIMILAR_COLS)
      .eq('category', lot.category)
      .in('auction_id', discoverableAuctionIds)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(SIMILAR_LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length > 0) {
      return { lots, mode: 'same-category' };
    }
  }

  return { lots: [], mode: 'none' };
}

// ─── SavingsCallout ───────────────────────────────────────────────────────────

function SavingsCallout({
  msrpCents,
  displayPriceCents,
}: {
  msrpCents: number | null;
  displayPriceCents: number;
}) {
  if (!msrpCents || msrpCents <= 0 || msrpCents <= displayPriceCents) {
    return null;
  }
  const savingsPct = Math.round((1 - displayPriceCents / msrpCents) * 100);
  if (savingsPct < 10) return null;

  return (
    <View
      testID="savings-callout"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 12,
        marginBottom: 4,
      }}
    >
      <View
        style={{
          backgroundColor: colors.danger,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
        }}
        accessibilityLabel={`Save ${savingsPct} percent off retail`}
      >
        <Text
          style={{
            color: '#fff',
            fontWeight: '800',
            fontSize: 12,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}
        >
          SAVE {savingsPct}%
        </Text>
      </View>
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 14,
          textDecorationLine: 'line-through',
        }}
      >
        {formatCents(msrpCents)}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 11, opacity: 0.7 }}>
        retail
      </Text>
    </View>
  );
}

// ─── PickupInfoCard ───────────────────────────────────────────────────────────

function PickupInfoCard({
  closeAt,
  pickupEndsAt,
  binLocation,
  warehouseTz,
  pickupLoc,
}: {
  closeAt: string;
  pickupEndsAt: string | null;
  binLocation: BinLocation | null;
  warehouseTz: string | null;
  pickupLoc: WarehousePickupDescribed;
}) {
  const aisleBay = binLocation ? formatBinLocation(binLocation) : null;

  return (
    <View
      testID="pickup-info-card"
      style={{
        marginTop: 14,
        padding: 14,
        backgroundColor: colors.surfaceAlt,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 8,
      }}
    >
      {pickupLoc.isOffsite && (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.danger,
            backgroundColor: 'rgba(255, 59, 59, 0.08)',
            borderRadius: 10,
            padding: 12,
            gap: 8,
            marginBottom: 4,
          }}
        >
          {pickupLoc.notice ? (
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800', lineHeight: 20 }}>
              {pickupLoc.notice}
            </Text>
          ) : null}
          {pickupLoc.addressLines.length > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>
                Pickup location
              </Text>
              <Text
                style={{ color: colors.text, fontSize: 12, flex: 1, textAlign: 'right' }}
              >
                {pickupLoc.addressLines.join('\n')}
              </Text>
            </View>
          )}
          {pickupLoc.directionsUrl ? (
            <Pressable
              onPress={() => void Linking.openURL(pickupLoc.directionsUrl!)}
              accessibilityRole="link"
            >
              <Text style={{ color: colors.cyan, fontSize: 13, fontWeight: '700' }}>
                Get directions
              </Text>
            </Pressable>
          ) : null}
          {pickupLoc.hoursLines.length > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>
                Pickup hours
              </Text>
              <Text
                style={{ color: colors.text, fontSize: 12, flex: 1, textAlign: 'right' }}
              >
                {pickupLoc.hoursLines.join('\n')}
              </Text>
            </View>
          )}
          {pickupLoc.instructions ? (
            <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
              {pickupLoc.instructions}
            </Text>
          ) : null}
        </View>
      )}
      {/* Auction ends row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text
          style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700', flex: 0 }}
          numberOfLines={1}
        >
          Auction ends
        </Text>
        <Text
          style={{ color: colors.text, fontSize: 12, flex: 1, textAlign: 'right' }}
          numberOfLines={1}
        >
          {formatDateTime(closeAt, warehouseTz)}
        </Text>
      </View>

      {/* Pickup by row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text
          style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700', flex: 0 }}
          numberOfLines={1}
        >
          Pickup by
        </Text>
        <Text
          style={{ color: colors.text, fontSize: 12, flex: 1, textAlign: 'right' }}
          numberOfLines={1}
        >
          {pickupEndsAt ? formatDateTime(pickupEndsAt, warehouseTz) : '—'}
        </Text>
      </View>

      {/* Item location row — staged pickup bin, or the preview shelf */}
      {aisleBay !== null && aisleBay.length > 0 && (
        <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text
              style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700', flex: 0 }}
              numberOfLines={1}
            >
              {binLocation?.kind === 'shelf' ? 'Item location' : 'Pick up from'}
            </Text>
            <Text
              style={{ color: colors.text, fontSize: 12, flex: 1, textAlign: 'right' }}
              numberOfLines={1}
            >
              {aisleBay}
            </Text>
          </View>
          {binLocation?.kind === 'shelf' && (
            <Text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16 }}>
              Previewing in person? Find this item at the location above — it
              updates automatically if staff move it.
            </Text>
          )}
        </>
      )}

      {/* NOT TRANSFERRABLE badge */}
      <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            backgroundColor: 'rgba(255, 59, 59, 0.12)',
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 4,
          }}
        >
          <Text
            style={{
              color: colors.danger,
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            NOT TRANSFERRABLE
          </Text>
        </View>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
        All items must be picked up in person. ID may be required.
      </Text>
    </View>
  );
}

// ─── AnonymizedBidHistory ─────────────────────────────────────────────────────

function BidHistoryRow({
  bid,
  anonMap,
  viewerBidderId,
  isFirst,
  tz,
}: {
  bid: BidRow;
  anonMap: Map<string, number>;
  viewerBidderId: string | null;
  isFirst: boolean;
  tz: string | null;
}) {
  const isYou = viewerBidderId !== null && bid.bidder_id === viewerBidderId;
  // 2026-07-05: bid TYPE is private. Your own rows show "(auto)" so you can
  // tell when your proxy acted; other bidders' rows never reveal whether a
  // human or a proxy placed the bid (that's snipe-target intel).
  const label = isYou
    ? bid.is_auto
      ? 'YOU (auto)'
      : 'YOU'
    : `Bidder #${anonMap.get(bid.bidder_id) ?? '?'}`;
  // Force the warehouse zone (via the same helper close/pickup use) so the bid
  // clock matches the store's wall clock and stays consistent with the rest of
  // the app — not the device zone (2026-07-13 feedback on confusing bid times).
  const placedStr = formatDateTime(bid.placed_at, tz);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopColor: colors.border,
      }}
    >
      <Text
        style={{
          flex: 1.4,
          color: isYou ? colors.primary : colors.text,
          fontSize: 13,
          fontWeight: isYou ? '800' : '600',
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        style={{
          flex: 1.2,
          color: colors.text,
          fontSize: 13,
          fontWeight: '700',
          textAlign: 'right',
        }}
      >
        {formatCents(bid.amount_cents)}
      </Text>
      <Text
        style={{
          flex: 1.1,
          color: colors.textMuted,
          fontSize: 11,
          textAlign: 'right',
        }}
        numberOfLines={1}
      >
        {placedStr}
      </Text>
    </View>
  );
}

function AnonymizedBidHistory({
  bids,
  totalCount,
  myCount,
  viewerBidderId,
  warehouseTz,
}: {
  bids: BidRow[];
  /** lots.bid_count: bids people placed, everyone's. */
  totalCount: number;
  /** Bids the viewer placed (not their auto-bids). */
  myCount: number;
  viewerBidderId: string | null;
  warehouseTz: string | null;
}) {
  const [showAll, setShowAll] = useState<boolean>(false);

  const persistentNumbers = usePersistentBidderNumbers(bids);
  const anonMap = buildAnonMap(bids, viewerBidderId, persistentNumbers);
  const visible = showAll ? bids : bids.slice(0, BID_HISTORY_INITIAL);
  const overflowCount = bids.length - BID_HISTORY_INITIAL;

  return (
    <View style={{ marginTop: 20 }}>
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 11,
          marginBottom: 8,
          ...type.label,
        }}
      >
        Bid history{totalCount > 0 ? ` · ${bidCountLabel(totalCount, myCount)}` : ''}
      </Text>
      {/* 2026-10-06: the bids table only returns the viewer's own rows (RLS
          bids_self_read), so other bidders never appear here. Say so, instead
          of a list of 7 under a counter of 11, or "No bids yet" on a lot
          with bids. */}
      {totalCount > myCount && (
        <Text
          testID="bid-history-own-only"
          style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}
        >
          Only your bids are shown. Other bidders' bids are private.
        </Text>
      )}

      {bids.length === 0 ? (
        totalCount > 0 ? null : (
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>
            No bids yet — be the first!
          </Text>
        )
      ) : (
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          {/* Column header */}
          <View
            style={{
              flexDirection: 'row',
              paddingVertical: 7,
              paddingHorizontal: 12,
              backgroundColor: colors.surfaceAlt,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={{ flex: 1.4, color: colors.textMuted, fontSize: 10, ...type.label }}>
              Bidder
            </Text>
            <Text
              style={{
                flex: 1.2,
                color: colors.textMuted,
                fontSize: 10,
                textAlign: 'right',
                ...type.label,
              }}
            >
              Amount
            </Text>
            <Text
              style={{
                flex: 0.8,
                color: colors.textMuted,
                fontSize: 10,
                textAlign: 'right',
                ...type.label,
              }}
            >
              Type
            </Text>
            <Text
              style={{
                flex: 1.1,
                color: colors.textMuted,
                fontSize: 10,
                textAlign: 'right',
                ...type.label,
              }}
            >
              Time
            </Text>
          </View>

          {/* Rows — 50 rows max, View + .map() is fine at this scale. */}
          {visible.map((bid, idx) => (
            <BidHistoryRow
              key={bid.id}
              bid={bid}
              anonMap={anonMap}
              viewerBidderId={viewerBidderId}
              isFirst={idx === 0}
              tz={warehouseTz}
            />
          ))}

          {/* Show all / collapse toggle */}
          {overflowCount > 0 && (
            <Pressable
              onPress={() => setShowAll((v) => !v)}
              style={{
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                backgroundColor: colors.surfaceAlt,
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 13,
                  fontWeight: '700',
                }}
              >
                {showAll
                  ? 'Show less'
                  : `Show all (${bids.length})`}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ─── SimilarLotsRail ──────────────────────────────────────────────────────────

function SimilarLotsRail({
  lots,
  mode,
  now,
}: {
  lots: SimilarLotRow[];
  mode: SimilarLotsMode;
  now: number;
}) {
  if (lots.length === 0 || mode === 'none') return null;

  const title =
    mode === 'same-auction-category' || mode === 'same-auction'
      ? 'More from this auction'
      : 'Similar lots';

  // Map SimilarLotRow → LotCardData. operator fields aren't available on
  // similar-lot rows (no join), so we supply safe empty-string defaults —
  // the LotCard renders the operator initial from business_name, so an
  // empty string just produces no letter (photo-placeholder still shows).
  const cardData: LotCardData[] = lots.map((l) => ({
    id: l.id,
    lot_code: l.lot_code,
    sticker_code: l.sticker_code,
    title: l.title,
    photo_urls: l.photo_urls,
    current_bid_cents: l.current_bid_cents,
    starting_bid_cents: l.starting_bid_cents,
    msrp_cents: l.msrp_cents,
    bid_count: l.bid_count ?? 0,
    close_at: l.close_at,
    status: l.status,
    condition: l.condition,
    operator_business_name: '',
    operator_logo_url: null,
    operator_brand_color: null,
  }));

  return (
    <View style={{ marginTop: 24 }}>
      <Text
        style={{
          color: colors.text,
          fontSize: 16,
          fontWeight: '800',
          marginBottom: 12,
          paddingHorizontal: 16,
          letterSpacing: -0.3,
        }}
      >
        {title}
      </Text>
      <FlatList<LotCardData>
        data={cardData}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SIMILAR_ITEM_WIDTH + 12}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        renderItem={({ item }) => (
          <View style={{ width: SIMILAR_ITEM_WIDTH }}>
            <LotCard lot={item} now={now} source="similar" />
          </View>
        )}
      />
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function LotDetailScreen() {
  const { id, source: sourceParam } = useLocalSearchParams<{
    id: string;
    source?: string;
  }>();
  // Coerce the URL param into the typed LotViewSource union. Anything
  // unrecognized falls back to 'browse' so we never lose the event,
  // just lose the source dimension. The list mirrors apps/operator-web.
  const lotViewSource: LotViewSource = (() => {
    const known: LotViewSource[] = [
      'browse',
      'scan',
      'link',
      'watchlist',
      'my_bids',
      'recent_wins',
      'similar',
      'unknown',
    ];
    return known.includes(sourceParam as LotViewSource)
      ? (sourceParam as LotViewSource)
      : 'browse';
  })();
  const [lot, setLot] = useState<Lot | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Resume/reconnect (June-4 "bidding needs a force-close"): loadFailed lets the
  // screen offer a retry instead of an infinite spinner; bumping reloadKey
  // re-runs the focus effect's fetch + realtime subscribe.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Whether the current user has personally placed a manual bid on this
  // lot. Drives the red OUTBID banner — we only want the urgency cue when
  // the bidder is actually competing, not for every visitor whose
  // winner_bidder_id happens to be someone else.
  const [iHaveBid, setIHaveBid] = useState(false);
  // 2026-10-06: the viewer's own bid count and highest maximum, for the
  // "11 bids, 7 yours" counter and the earlier-maximum outbid wording.
  const [myBidCount, setMyBidCount] = useState(0);
  const [myMaxCents, setMyMaxCents] = useState<number | null>(null);
  const [myBidsVersion, setMyBidsVersion] = useState(0);
  // BID-CONFIRM (2026-10): whether the viewer's newest row on this lot is a
  // server-placed proxy defense (is_auto), not a bid she tapped herself —
  // "bids happened on their own" customer report. Pure decision lives in
  // @auction-platform/shared describeAutoRaise; this is display-only.
  const [autoRaise, setAutoRaise] = useState<AutoRaiseStatus | null>(null);

  // 0105 gating cues — read once at mount so we can show the "Add a
  // card to bid" / "Pay $X.XX in fees to bid" banners proactively
  // instead of waiting for the place_bid rejection. The server is the
  // authoritative gate (place_bid §A + §B); this is purely UX.
  const [needsCard, setNeedsCard] = useState(false);
  const [unpaidFeesCents, setUnpaidFeesCents] = useState<number>(0);

  // 0198: platform has no live card processor (platform_settings.payments_disabled).
  // When TRUE, place_bid skips the card / fees / unpaid-invoice gates server-side,
  // so the proactive "Add a card to bid" / "Pay fees to bid" banners and the
  // auto-charge operator-terms line are misleading and must be suppressed.
  // Mirrors the web reader (apps/operator-web/src/lib/payments-mode.ts) but via
  // the SECURITY DEFINER payments_disabled() RPC — the bidder app uses the
  // anon/authenticated key and platform_settings is RLS-locked. Fail-safe:
  // default false (normal card path) so a glitch never hides a real gate.
  const [paymentsDisabled, setPaymentsDisabled] = useState(false);

  const [pickupLoc, setPickupLoc] = useState<WarehousePickupDescribed>(() =>
    describeWarehousePickup(null),
  );

  // In-flight guard for the one-tap counter button so a fast double-tap
  // can't fire two RPCs.
  const [counterPending, setCounterPending] = useState(false);

  // BID-1 (2026-06-05): converge mobile onto the web "quick-bid-first" model.
  // The one-tap "Quick bid" Pressable is now the PRIMARY CTA; the proxy /
  // max-bid PlaceBidSheet is demoted behind this collapsed "Set a max bid"
  // expander so power users keep proxy bidding without the +$1/+$5/+$10 chip
  // ladder competing as a second primary bid surface. Standard lots only —
  // dutch / last_chance use BuyNowSheet and are unaffected.
  const [showMaxBid, setShowMaxBid] = useState(false);

  // Per-operator policy gate. Loaded once when the operator_id is known.
  // `accepted` is the cached answer to "has this user accepted this
  // operator's CURRENT policy version?"; null = not yet checked,
  // true = accepted (no modal), false = needs modal.
  const [operatorPolicy, setOperatorPolicy] = useState<OperatorPolicy | null>(
    null,
  );
  const [accepted, setAccepted] = useState<boolean | null>(null);
  const [policyModalVisible, setPolicyModalVisible] = useState(false);
  // beforeBid resolver — when the policy modal opens we stash the
  // resolve fn here so accept / cancel can finish the awaited promise
  // back inside PlaceBidSheet (or BuyNowSheet). One-shot per attempt.
  const beforeBidResolver = useRef<((v: boolean) => void) | null>(null);
  const offsiteGateCacheRef = useRef<Map<string, Promise<OffsiteNoticeGateLookup>>>(new Map());
  const [offsiteModalVisible, setOffsiteModalVisible] = useState(false);
  const [offsitePrompt, setOffsitePrompt] = useState<{
    pickup: OffsiteNoticePickup;
    warehouseId: string;
  } | null>(null);
  const offsiteBidResolver = useRef<((v: boolean) => void) | null>(null);

  // Soft-close UX state. extensionFlashUntil drives the yellow banner
  // dismiss timing; lastBidTickAt is bumped on every Realtime UPDATE
  // and used by LiveBidTicker as a "refetch please" signal.
  const [extensionFlashUntil, setExtensionFlashUntil] = useState(0);
  const [lastBidTickAt, setLastBidTickAt] = useState(0);

  // Wave 1C: enrichment data loaded once at mount.
  const [bids, setBids] = useState<BidRow[]>([]);
  const [binLocation, setBinLocation] = useState<BinLocation | null>(null);
  const [similarLots, setSimilarLots] = useState<SimilarLotRow[]>([]);
  const [similarLotsMode, setSimilarLotsMode] = useState<SimilarLotsMode>('none');

  // Refs that survive re-renders and let us diff incoming Realtime
  // payloads against the last known state (extension detection,
  // outbid/leading transitions, haptic suppression on first paint).
  const prevCloseAtRef = useRef<string | null>(null);
  const prevWinnerRef = useRef<string | null>(null);
  const prevBidCountRef = useRef<number>(0);
  const firstUpdateRef = useRef(true);
  // lot_code mirror so the Realtime channel callback (which captures
  // its closure on first subscribe) can read the latest code without
  // re-subscribing on every lot state update.
  const lotCodeRef = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, []);

  // Track the lot in the bidder's local "recently viewed" history.
  // Fire-and-forget — failures are silent inside addRecentlyViewed.
  useEffect(() => {
    if (id) addRecentlyViewed(id);
  }, [id]);

  // lot_viewed analytics. Fires once per (lot_code × mount) once the lot
  // row arrives so we can include lot_code (not just lot_id). source is
  // resolved from the URL param above; unknown values default to
  // 'browse' so we never lose the event.
  const lotViewedFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lot?.lot_code) return;
    if (lotViewedFiredRef.current === lot.lot_code) return;
    lotViewedFiredRef.current = lot.lot_code;
    captureLotViewed({ lot_code: lot.lot_code, source: lotViewSource });
  }, [lot?.lot_code, lotViewSource]);

  // Keep the "you" ref in sync so the channel callback can read it
  // without listing it as a dependency (and re-subscribing every login).
  const meRef = useRef<string | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  // Mirror lot_code into the ref so the Realtime channel callback can
  // pull it into the bid_outbid event without forcing a re-subscribe.
  useEffect(() => {
    lotCodeRef.current = lot?.lot_code ?? null;
  }, [lot?.lot_code]);

  // Per-operator policy + acceptance lookup. Runs once per (lot, user)
  // combo. We fetch the active policy from the RPC (anon-readable) and,
  // if the user is signed in, check operator_policy_acceptances for an
  // exact version match. The modal only opens when the user actually
  // tries to bid, but we pre-load so the first tap has zero latency.
  useEffect(() => {
    if (!lot?.operator_id) {
      setOperatorPolicy(null);
      setAccepted(null);
      return;
    }
    let cancelled = false;
    (async () => {
      // PR-B (2026-05-29): direct select instead of RPC so we can read the
      // 4 new mig-0157 columns (no_show_policy, restock/relist_fee_cents,
      // admin_can_refund_outside_window) without re-defining the RPC.
      // Anon read is allowed via mig 0088 RLS `select_published_for_anon`.
      const { data: pol, error: polErr } = await supabase
        .from('operator_policies')
        .select(
          'operator_id, version, terms_md, refund_md, shipping_md, ' +
            'payment_window_hours, pickup_window_days, ' +
            'refund_window_post_pickup_hours, no_show_policy, ' +
            'restock_fee_cents, relist_fee_cents, ' +
            'admin_can_refund_outside_window, effective_at',
        )
        .eq('operator_id', lot.operator_id)
        .eq('published', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || polErr) return;
      const row = pol;
      if (!row) {
        // Operator hasn't published a policy yet — let the bid through
        // without prompting. The seed migration gives every operator a
        // v1, so this branch should be rare in production. We don't
        // want to brick bidding on an edge case.
        setOperatorPolicy(null);
        setAccepted(true);
        return;
      }
      // Cast via unknown: maybeSingle()'s inferred type is too narrow for
      // an arbitrary policy shape; we already null-checked above.
      const policy = row as unknown as OperatorPolicy;
      setOperatorPolicy(policy);
      if (!me) {
        setAccepted(null);
        return;
      }
      const { count } = await supabase
        .from('operator_policy_acceptances')
        .select('id', { head: true, count: 'exact' })
        .eq('user_id', me)
        .eq('operator_id', policy.operator_id)
        .eq('version', policy.version)
        .limit(1);
      if (cancelled) return;
      setAccepted((count ?? 0) > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [lot?.operator_id, me]);

  // beforeBid gate handed to PlaceBidSheet / BuyNowSheet. Resolves true
  // immediately when the user has already accepted (the hot path), or
  // opens the modal and waits for accept / cancel. The same promise is
  // reused for the inline "counter" CTA above.
  const requireAcceptance = useCallback((): Promise<boolean> => {
    if (accepted) return Promise.resolve(true);
    if (!operatorPolicy) {
      // Either still loading or operator has no published policy. If
      // the policy load failed silently we don't want to block forever;
      // resolving true matches the "no policy → no gate" branch above.
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      beforeBidResolver.current = resolve;
      setPolicyModalVisible(true);
    });
  }, [accepted, operatorPolicy]);

  const requireOffsiteNotice = useCallback((): Promise<boolean> => {
    if (!id || !me) return Promise.resolve(true);
    return lookupOffsiteNoticeGateForLot(supabase, id, offsiteGateCacheRef.current)
      .then((lookup) => {
        if (lookup.gate === 'lookup_failed') {
          console.warn('[lot] off-site notice lookup failed; bidding without gate');
          return true;
        }
        if (lookup.gate === 'needs_ack' && lookup.pickup && lookup.warehouseId) {
          return new Promise<boolean>((resolve) => {
            offsiteBidResolver.current = resolve;
            setOffsitePrompt({ pickup: lookup.pickup!, warehouseId: lookup.warehouseId! });
            setOffsiteModalVisible(true);
          });
        }
        return true;
      })
      .catch(() => true);
  }, [id, me]);

  const beforeBid = useCallback(async (): Promise<boolean> => {
    const ok = await requireAcceptance();
    if (!ok) return false;
    const okOffsite = await requireOffsiteNotice();
    if (!okOffsite) return false;
    // Mandatory ZIP block, one-time (ZIP-required-before-bid/checkout plan):
    // runs last so the bidder clears the cheaper, already-shown gates first.
    // Covers both counterBid() below and the PlaceBidSheet instance rendered
    // on this screen, since both call beforeBid().
    return requireZip();
  }, [requireAcceptance, requireOffsiteNotice]);

  function handlePolicyAccepted() {
    setAccepted(true);
    setPolicyModalVisible(false);
    const r = beforeBidResolver.current;
    beforeBidResolver.current = null;
    r?.(true);
  }

  function handlePolicyCancel() {
    setPolicyModalVisible(false);
    const r = beforeBidResolver.current;
    beforeBidResolver.current = null;
    r?.(false);
  }

  function handleOffsiteAccepted() {
    if (offsitePrompt) {
      markOffsiteNoticeAckedInCache(offsiteGateCacheRef.current, offsitePrompt.warehouseId);
    }
    setOffsiteModalVisible(false);
    setOffsitePrompt(null);
    const r = offsiteBidResolver.current;
    offsiteBidResolver.current = null;
    r?.(true);
  }

  function handleOffsiteCancel() {
    setOffsiteModalVisible(false);
    setOffsitePrompt(null);
    const r = offsiteBidResolver.current;
    offsiteBidResolver.current = null;
    r?.(false);
  }

  // Has the user placed a manual bid on this lot? Single query at mount.
  // Realtime UPDATEs that flip winner_bidder_id to me also flip iHaveBid
  // implicitly (the place_bid RPC returns first, see counterBid + sheet).
  useEffect(() => {
    if (!id || !me) {
      setIHaveBid(false);
      setMyBidCount(0);
      setMyMaxCents(null);
      setAutoRaise(null);
      return;
    }
    let cancelled = false;
    // Own rows only (RLS bids_self_read), so this is cheap: count the bids
    // the viewer placed and take their highest maximum. Refetched after each
    // of their bids (myBidsVersion). amount_cents + placed_at (beyond what
    // this screen used before) feed describeAutoRaise below — the same rows,
    // no extra query.
    supabase
      .from('bids')
      .select('amount_cents, max_amount_cents, is_auto, placed_at')
      .eq('lot_id', id)
      .eq('bidder_id', me)
      .then(({ data }) => {
        if (cancelled) return;
        const rows = (data ?? []) as {
          amount_cents: number;
          max_amount_cents: number;
          is_auto: boolean;
          placed_at: string;
        }[];
        const manual = rows.filter((r) => !r.is_auto).length;
        setIHaveBid(manual > 0);
        setMyBidCount(manual);
        setMyMaxCents(rows.length ? Math.max(...rows.map((r) => r.max_amount_cents)) : null);
        setAutoRaise(rows.length ? describeAutoRaise(rows) : null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, me, myBidsVersion]);

  // 0105 — pull the two place_bid gating fields once per (lot, user)
  // combo so the inline banners can render before the user taps the bid
  // CTA. After a successful card-save / fee-pay round-trip the user
  // navigates back here and the screen re-mounts → values refresh.
  useEffect(() => {
    if (!me) {
      setNeedsCard(false);
      setUnpaidFeesCents(0);
      return;
    }
    let cancelled = false;
    supabase
      .from('bidders')
      .select('default_payment_method_id, unpaid_fees_cents')
      .eq('id', me)
      .single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setNeedsCard(
          (data.default_payment_method_id as string | null) == null,
        );
        setUnpaidFeesCents((data.unpaid_fees_cents as number | null) ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  // 0198: resolve the no-live-processor switch once at mount via the
  // payments_disabled() RPC (SECURITY DEFINER, granted to anon/authenticated).
  // Drives suppression of the card/fees banners + auto-charge copy below.
  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc('payments_disabled')
      .then(({ data }) => {
        if (!cancelled) setPaymentsDisabled(data === true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const whId = lot?.auctions?.warehouse_id;
    if (!whId) {
      setPickupLoc(describeWarehousePickup(null));
      return;
    }
    let cancelled = false;
    void (async () => {
      const raw = await fetchWarehousePickup(supabase, whId);
      if (!cancelled) setPickupLoc(describeWarehousePickup(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, [lot?.auctions?.warehouse_id]);

  // Wave 1C: bid history fetch. Runs once per lot id. RLS (bids_self_read)
  // returns only the viewer's own rows; signed out, it returns none.
  // The anonMap is built from the result in the component so no extra state.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    supabase
      .from('bids')
      .select('id, bidder_id, amount_cents, is_auto, placed_at')
      .eq('lot_id', id)
      .order('placed_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (cancelled) return;
        setBids((data as unknown as BidRow[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
    // myBidsVersion: show the viewer's new bid in the history right away.
  }, [id, myBidsVersion]);

  // Item location via lot_public_location (mig 0255, SECURITY DEFINER).
  // The old direct bin_assignments read was RLS-blocked for bidders and
  // always came back empty. The RPC resolves staged-for-pickup first, else
  // the intake shelf while the auction is scheduled/live — so preview
  // customers can walk straight to the item, and the location follows
  // staff moves on every screen load.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    supabase
      .rpc('lot_public_location', { p_lot_id: id })
      .then(({ data }) => {
        if (cancelled) return;
        const rows = (data ?? []) as {
          bin_code: string | null;
          aisle: string | null;
          bay: string | null;
          kind: string | null;
        }[];
        const row = rows[0];
        setBinLocation(
          row
            ? {
                code: row.bin_code ?? null,
                aisle: row.aisle ?? null,
                bay: row.bay ?? null,
                kind: row.kind === 'pickup' ? 'pickup' : 'shelf',
              }
            : null,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Wave 1C: similar lots. Loaded after the lot row is available so we
  // have auction_id + category for the tier queries.
  useEffect(() => {
    if (!lot) return;
    let cancelled = false;
    loadSimilarLots(lot).then(({ lots, mode }) => {
      if (cancelled) return;
      setSimilarLots(lots);
      setSimilarLotsMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, [lot?.id, lot?.auction_id, lot?.category]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dispatcher for the two new 0105 rejection reasons. Reused by the
  // one-tap counter path AND the place_bid result handler so a rejected
  // bid lands on the right fix-it screen instead of a dead-end alert.
  function dispatchRejectionAction(reason: string): boolean {
    if (reason === 'no_payment_method') {
      router.push('/profile/payment-method' as never);
      return true;
    }
    if (reason === 'unpaid_fees') {
      router.push('/profile/pay-fees' as never);
      return true;
    }
    // 0176: an unpaid invoice in the grace window at this operator blocks
    // bidding here. Send them to their invoices so they can pay/update the
    // card and resume — once settled, place_bid stops returning this reason.
    if (reason === 'unpaid_invoice') {
      router.push('/profile/invoices' as never);
      return true;
    }
    return false;
  }

  // Use useFocusEffect for the Realtime channel + 1Hz tick so they suspend
  // when the user navigates to another screen on top of this one (Stack
  // push) and resume on focus return. Without this the channel keeps
  // streaming and the interval keeps ticking on a backgrounded screen.
  useFocusEffect(
    useCallback(() => {
      if (!id) return;

      let cancelled = false;
      firstUpdateRef.current = true;

      // Hoisted so the AppState 'active' resume handler (below) can refetch the
      // row on foreground. useFocusEffect does NOT re-run on background->
      // foreground (the screen never lost navigator focus), so without this the
      // stale row + dead socket persist until a force-close.
      const fetchLot = async () => {
        const { data, error } = await supabase
          .from('lots')
          .select(
            'id, lot_code, sticker_code, display_code, title, description, current_bid_cents, starting_bid_cents, close_at, status, msrp_cents, condition, bid_count, winner_bidder_id, flat_price_cents, dutch_start_cents, dutch_floor_cents, dutch_decline_per_minute_cents, photo_urls, operator_id, auction_id, category, brand, model, upc, asin, fnsku, lpn, mpn, product_sku, site_sku, manufacture_sku, auctions(warehouse_id, format, starts_at, prebid_enabled, pickup_ends_at, bid_increment_schedule, buyer_premium_bps, warehouses(timezone)), operators:operators_public(business_name, logo_url, brand_color, offers_shipping, bid_increment_schedule, default_buyer_premium_bps)',
          )
          .eq('id', id)
          .single();
        if (cancelled) return;
        if (error || !data) {
          // The old code swallowed the error and left lot===null on the
          // "Loading…" spinner forever (a backgrounded token race or transient
          // blip). Surface a retry instead.
          setLoadFailed(true);
          return;
        }
        const fresh = data as unknown as Lot;
        prevCloseAtRef.current = fresh.close_at;
        prevWinnerRef.current = fresh.winner_bidder_id;
        prevBidCountRef.current = fresh.bid_count;
        setLoadFailed(false);
        setLot(fresh);
      };
      void fetchLot();

      // Channel name salted so a rapid pop+push to the same lot id can't
      // collide with a still-cleaning-up prior subscription. Wrapped in a
      // factory so the resume handler can tear down + recreate it.
      let channel: ReturnType<typeof supabase.channel> | null = null;
      const subscribe = () => {
        channel = supabase
        .channel(`lot:${id}:${Date.now()}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'lots', filter: `id=eq.${id}` },
          (payload) => {
            if (cancelled) return;
            const next = payload.new as Lot;

            // Diff against prev refs BEFORE we merge state, so we know
            // whether close_at moved forward (popcorn extension) and
            // whether the winner flipped to/from us.
            const prevCloseAt = prevCloseAtRef.current;
            const prevWinner = prevWinnerRef.current;
            const prevBidCount = prevBidCountRef.current;
            const meId = meRef.current;
            const skipHaptics = firstUpdateRef.current;
            firstUpdateRef.current = false;

            const closeAtAdvanced =
              prevCloseAt &&
              next.close_at &&
              new Date(next.close_at).getTime() - new Date(prevCloseAt).getTime() >=
                EXTENSION_THRESHOLD_MS;
            const bidCountAdvanced = next.bid_count > prevBidCount;

            // Only flash the extension banner when BOTH close_at moved
            // forward AND a new bid landed. Server retries that recompute
            // close_at without a fresh bid won't fire the banner twice.
            if (!skipHaptics && closeAtAdvanced && bidCountAdvanced) {
              setExtensionFlashUntil(Date.now() + EXTENSION_BANNER_MS);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            }

            if (!skipHaptics && meId && prevWinner !== next.winner_bidder_id) {
              if (prevWinner === meId && next.winner_bidder_id !== meId) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
                // bid_outbid: bidder was leading on the prior payload
                // and the latest UPDATE flipped the winner to someone
                // else. Pair with bid_placed via lot_code to measure
                // outbid → counter conversion. lotCodeRef is updated
                // by the mirroring useEffect above so the subscribed
                // closure always sees the latest code.
                const code = lotCodeRef.current;
                if (code) {
                  captureBidOutbid({
                    lot_code: code,
                    new_bid_cents: next.current_bid_cents ?? 0,
                  });
                }
              } else if (prevWinner !== meId && next.winner_bidder_id === meId) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              }
            }

            prevCloseAtRef.current = next.close_at;
            prevWinnerRef.current = next.winner_bidder_id;
            prevBidCountRef.current = next.bid_count;
            // Pin the merge to the specific scalar columns we know come
            // through Postgres CDC. Spreading the entire payload would
            // overwrite joined `auctions` / `operators` with undefined
            // (CDC doesn't include joins) and could null-out columns the
            // publication delivers as literal null.
            setLot((prev) =>
              prev
                ? {
                    ...prev,
                    current_bid_cents: next.current_bid_cents,
                    close_at: next.close_at,
                    status: next.status,
                    bid_count: next.bid_count,
                    winner_bidder_id: next.winner_bidder_id,
                    flat_price_cents: next.flat_price_cents,
                    dutch_start_cents: next.dutch_start_cents,
                    dutch_floor_cents: next.dutch_floor_cents,
                    dutch_decline_per_minute_cents: next.dutch_decline_per_minute_cents,
                  }
                : prev,
            );
            setLastBidTickAt(Date.now());
          },
        )
        .subscribe((status) => {
          // A dropped/errored socket is common right after the app was
          // backgrounded. Refetch so we don't miss UPDATEs that arrived while
          // it was dead; supabase-js auto-rejoins the socket itself. (CLOSED is
          // the normal teardown path — ignore it.)
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            void fetchLot();
          }
        });
      };
      subscribe();

      // iOS background->foreground: refetch + rebuild the channel on resume.
      // useFocusEffect won't re-run here (no navigator focus change), so this is
      // the only place the stale row + dead socket get refreshed — the fix for
      // "bidding needs a force-close after backgrounding".
      const appStateSub = AppState.addEventListener('change', (state) => {
        if (cancelled || state !== 'active') return;
        void fetchLot();
        if (channel) supabase.removeChannel(channel);
        firstUpdateRef.current = true;
        subscribe();
      });

      const tick = setInterval(() => setNow(Date.now()), 1000);

      return () => {
        cancelled = true;
        clearInterval(tick);
        appStateSub.remove();
        if (channel) supabase.removeChannel(channel);
      };
    }, [id, reloadKey]),
  );

  // Pulse the urgent countdown — opacity 1.0 → 0.5 over 600ms, looped,
  // with useNativeDriver so the timing runs on the native thread. We
  // stay on RN Animated (not Reanimated 4) because Expo Go SDK 54
  // doesn't bundle the react-native-worklets TurboModule.
  const heat = lot ? heatFromCloseAt(lot.close_at, lot.status) : 'scheduled';
  const isUrgent = heat === 'urgent';
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isUrgent) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.5, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isUrgent, pulse]);

  if (!lot) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        {loadFailed ? (
          <>
            <Text
              style={{ color: colors.text, fontSize: 15, textAlign: 'center', marginBottom: 16 }}
            >
              Couldn&apos;t load this lot. Check your connection and try again.
            </Text>
            <Pressable
              onPress={() => {
                setLoadFailed(false);
                setReloadKey((k) => k + 1);
              }}
              style={{
                paddingHorizontal: 22,
                paddingVertical: 12,
                borderRadius: 10,
                backgroundColor: colors.primary,
              }}
            >
              <Text style={{ color: '#000', fontWeight: '900' }}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <Text style={{ color: colors.textMuted }}>Loading…</Text>
        )}
      </View>
    );
  }

  void now;
  const youAreLeader = me && lot.winner_bidder_id === me;
  // OUTBID banner: only fire urgent red when the user has actually placed
  // a bid here AND someone else is currently leading. The earlier check
  // (`bid_count > 0 && winner !== me`) fired for every authenticated
  // visitor on a hot lot — false urgency that erodes trust.
  const youHaveLost =
    iHaveBid && lot.winner_bidder_id != null && lot.winner_bidder_id !== me;
  // BID-CONFIRM: shown only while she is actually the leader — an auto-raise
  // on a lot she's since been outbid on isn't "your bid status" any more.
  const leaderAutoRaiseMessage =
    youAreLeader && autoRaise ? autoRaiseMessage(autoRaise, formatCents) : null;
  // 2026-10-06: say how the viewer lost, live and after close (lib/lot-outcome).
  const outcome = lotOutcome({
    me,
    winnerBidderId: lot.winner_bidder_id,
    iHaveBid,
    myMaxCents,
    currentBidCents: lot.current_bid_cents,
    closed: heat === 'closed',
  });
  const outcomeMessage = outbidMessage(outcome, formatCents);
  const lostClosed = outcome.kind === 'outbid' && outcome.closed;
  // 0221: preview pre-bidding — a scheduled lot in an opted-in auction is
  // fully biddable; place_bid keeps it 'scheduled' until the auction opens.
  const prebidOpen = lot.status === 'scheduled' && lot.auctions?.prebid_enabled === true;
  const canBid = lot.status === 'live' || prebidOpen;
  const heatHex = heatColor(heat);
  const countdown = formatCountdown(lot.close_at);
  const showExtensionFlash = now < extensionFlashUntil;
  // BID-3: effective increment schedule = per-auction override ?? operator
  // default ?? null (legacy ladder). Threaded into the quick-bid amount AND
  // PlaceBidSheet's minNextCents so both match what place_bid enforces.
  const effectiveSchedule: BidIncrementTier[] | null =
    lot.auctions?.bid_increment_schedule ?? lot.operators?.bid_increment_schedule ?? null;
  const counterCents = nextMinimumBidCents(
    lot.current_bid_cents,
    lot.starting_bid_cents,
    effectiveSchedule,
  );
  const displayPriceCents = lot.current_bid_cents ?? lot.starting_bid_cents;
  // Buyer's premium (basis points) for this lot's auction, falling back to the
  // operator default. Surfaced right on the price face so bidders see the
  // all-in cost, not just the hammer price (it was previously buried in the
  // policy blurb far below the bid button).
  const buyerPremiumBps =
    lot.auctions?.buyer_premium_bps ?? lot.operators?.default_buyer_premium_bps ?? 0;

  // One-tap counter from the Outbid banner. Hardened version:
  //   - in-flight guard via counterPending
  //   - identity gate when counterCents crosses the verification threshold
  //   - friendly reason copy via COUNTER_REASON_MESSAGES
  const lotIdForBid = lot.id;
  async function counterBid() {
    if (counterPending) return;
    setCounterPending(true);
    try {
      // Per-operator policy gate. If the bidder hasn't yet accepted this
      // operator's current policy version, requireAcceptance() opens the
      // modal and waits for accept / cancel. Cancel → silent return; no
      // misleading error banner.
      const ok = await beforeBid();
      if (!ok) return;

      // Identity gate is now SERVER-AUTHORITATIVE and REACTIVE (mig 0212): no
      // client pre-check. When KYC is armed, place_bid RAISES
      // identity_verification_required and we surface the verify prompt from the
      // RPC error handler below (mirrors the payments_disabled/no_payment_method
      // pattern). When the identity_verification_disabled flag is on (no KYC
      // provider wired), the server allows the bid and it just goes through.

      // UX-P0-1 fix (2026-05-24 audit): wrap RPC in 10s timeout. On a
      // flaky connection the call previously hung indefinitely and the
      // bidder thought the bid was placed when it wasn't. Raw Stripe /
      // Supabase error strings are also sanitized for end users.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const { data, error } = await supabase
          .rpc('place_bid', {
            p_lot_id: lotIdForBid,
            p_max_amount_cents: counterCents,
          })
          .abortSignal(controller.signal);
        if (error) {
          // Server identity gate (place_bid): a bid at/above the threshold
          // without a verified id RAISES identity_verification_required. Surface
          // the verify path reactively. (When the KYC flag disables the gate,
          // this never fires and the bid succeeds.)
          if ((error.message ?? '').includes('identity_verification_required')) {
            Alert.alert(
              'Verify your identity',
              `Bids over ${formatCents(IDENTITY_VERIFICATION_THRESHOLD_CENTS)} require a quick ID check to protect the marketplace.`,
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Verify now', onPress: () => router.push('/identity/verify') },
              ],
            );
            return;
          }
          console.error('[place_bid] rpc error:', error);
          Alert.alert('Bid failed', 'Please try again or contact support.');
          return;
        }
        const result = data as unknown as PlaceBidResult;
        if (!result.ok) {
          // BID-1: analytics parity with PlaceBidSheet — the one-tap quick-bid
          // is now the primary surface, so it must emit the same funnel event
          // a rejected sheet bid would. Mirrors PlaceBidSheet's
          // track('bid_rejected', { lot_id, reason, max_cents }).
          track('bid_rejected', {
            lot_id: lotIdForBid,
            reason: result.reason,
            max_cents: counterCents,
          });
          const friendly =
            COUNTER_REASON_MESSAGES[result.reason] ?? 'Try again in a moment.';
          // 0105: when the counter is rejected for a fixable reason
          // (no card / unpaid fees), refresh the local state and route
          // the bidder to the fix-it screen. Otherwise just show the
          // friendly message.
          if (
            result.reason === 'no_payment_method' ||
            result.reason === 'unpaid_fees'
          ) {
            if (result.reason === 'no_payment_method') setNeedsCard(true);
            dispatchRejectionAction(result.reason);
            return;
          }
          Alert.alert('Bid rejected', friendly);
          return;
        }
        // BID-1: analytics parity with PlaceBidSheet — emit bid_placed on the
        // surviving primary (quick-bid) path. Mirrors PlaceBidSheet's
        // track('bid_placed', { lot_id, max_cents, current_bid_cents, was_extended }).
        track('bid_placed', {
          lot_id: lotIdForBid,
          max_cents: counterCents,
          current_bid_cents: result.current_bid_cents,
          was_extended: result.was_extended,
        });
        // Counter succeeded — mark iHaveBid optimistically so subsequent
        // outbid signals fire correctly even before the bids-table refetch.
        setIHaveBid(true);
        setMyBidsVersion((v) => v + 1);
        // 2026-09-17: consume the RPC result, the same way the PlaceBidSheet
        // path (onPlaced, below) already did. This path did not, so a
        // quick-bid left the displayed price and leader badge on their
        // pre-bid values until the realtime echo arrived — the same defect
        // reported on the web, where it was the whole bug.
        //
        // Do NOT unconditionally claim the lead: a proxy-outbid means the
        // leader is somebody else, and the OUTBID banner has to stay correct.
        // Trust current_leader_id verbatim.
        setLot((prev) =>
          prev
            ? {
                ...prev,
                winner_bidder_id: result.current_leader_id,
                current_bid_cents: result.current_bid_cents ?? prev.current_bid_cents,
                close_at: result.close_at ?? prev.close_at,
              }
            : prev,
        );
        // Keep the diff ref in lock-step so the realtime UPDATE echoing this
        // same winner reads as "no change" and does not double-fire the
        // win/outbid haptic played just below.
        prevWinnerRef.current = result.current_leader_id;
        // bid_count is not in place_bid_result and is deliberately not
        // inferred — one bid can insert two rows (this bidder's, plus the
        // leader's proxy counter). The realtime echo carries the true count.
        //
        // Haptic has to be decided HERE now, and correctly. Two reasons:
        //
        //  1. ok:true does not mean you are winning. place_bid returns ok:true
        //     when an existing higher max immediately out-proxies you. This
        //     path fired an unconditional Success buzz for that, which tells
        //     the bidder they won when they lost — the same misreading #226
        //     fixed in PlaceBidSheet ("a proxy-outbid path was rendered as a
        //     green success — actively misleading").
        //  2. Pinning prevWinnerRef above means the realtime echo now reads as
        //     "no change", so the Error haptic it used to fire for an outbid
        //     will no longer fire. Without this branch, suppressing the double
        //     buzz would have silently removed the outbid signal altogether.
        const iLead =
          meRef.current != null && result.current_leader_id === meRef.current;
        Haptics.notificationAsync(
          iLead
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        ).catch(() => {});
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          Alert.alert(
            'No connection',
            'Bid not placed. Check your connection and try again.',
          );
        } else {

          console.error('[place_bid] failed:', err);
          Alert.alert('Bid failed', 'Please try again or contact support.');
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } finally {
      setCounterPending(false);
    }
  }

  // BID-CONFIRM (2026-10): customer report — the one-tap "Quick bid $X" CTA
  // and the red Outbid banner's counter placed a bid on a single tap, no
  // confirmation ("bids happened on their own"). Both now route through this
  // instead of calling counterBid() directly; the Alert names the exact
  // amount (counterCents, the same number the button itself shows) and only
  // the confirm action calls the existing place_bid path. Nothing else about
  // bidding changes — counterBid's in-flight guard, identity gate, policy
  // gate and reason routing are untouched. Matches
  // features/bidding/QuickBidButton.tsx's grid-thumbnail confirm style.
  function confirmCounterBid() {
    if (counterPending) return;
    const copy = quickBidConfirmCopy(formatCents(counterCents));
    Alert.alert(copy.title, copy.message, [
      { text: copy.cancelLabel, style: 'cancel' },
      { text: copy.confirmLabel, onPress: () => void counterBid() },
    ]);
  }

  return (
    <KeyboardAvoidingView
      // Android handles keyboard via android.softwareKeyboardLayoutMode
      // = "resize" in app.json — KeyboardAvoidingView with behavior="height"
      // compresses the ScrollView and hides the bid input on small screens.
      // iOS still benefits from the padding behavior.
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Extension flash — fires when popcorn fired (close_at moved
          forward by ≥30s AND bid_count incremented since the previous
          Realtime UPDATE). Auto-dismisses ~4s later. When this is
          showing we suppress the outbid banner to avoid a stack of
          urgent banners competing for attention. */}
      {showExtensionFlash && (
        <View
          style={{
            backgroundColor: colors.winning,
            paddingVertical: 10,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Text style={{ fontSize: 16 }}>⚡</Text>
          <Text
            style={{
              color: '#000',
              fontSize: 12,
              fontWeight: '900',
              letterSpacing: 1.0,
              textTransform: 'uppercase',
            }}
          >
            Extended — last bid reset the timer
          </Text>
        </View>
      )}

      {/* Sticky leader banner — pinned above ScrollView so it always shows
          while bidders scroll the photos. Yellow when you're winning, red
          when you've been outbid and the lot is still open. */}
      {!showExtensionFlash && youAreLeader && (
        <View
          testID="high-bidder-banner"
          style={{
            backgroundColor: colors.winning,
            paddingVertical: 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <View style={{ alignItems: 'center' }}>
            <Text
              style={{
                color: '#000',
                fontSize: 13,
                fontWeight: '900',
                letterSpacing: 1.2,
                textTransform: 'uppercase',
              }}
            >
              ✓ You&apos;re the high bidder
            </Text>
            {/* BID-CONFIRM: her current lead came from a server-placed proxy
                defense, not a tap of her own — name it, so a price move she
                didn't make never reads as a mystery ("bids happened on their
                own" customer report). */}
            {leaderAutoRaiseMessage && (
              <Text
                testID="auto-raise-line"
                style={{ color: '#000', fontSize: 11, fontWeight: '700', marginTop: 2 }}
              >
                {leaderAutoRaiseMessage}
              </Text>
            )}
          </View>
        </View>
      )}
      {!showExtensionFlash && !youAreLeader && youHaveLost && canBid && (
        <View
          style={{
            backgroundColor: colors.danger,
            paddingVertical: 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}
          >
            <Text style={{ fontSize: 14 }}>⚡</Text>
            <View style={{ flexShrink: 1 }}>
              <Text
                style={{
                  color: colors.text,
                  fontSize: 13,
                  fontWeight: '900',
                  letterSpacing: 1.0,
                  textTransform: 'uppercase',
                }}
                numberOfLines={1}
              >
                Outbid
              </Text>
              {outcomeMessage && !lostClosed ? (
                <Text
                  testID="outbid-earlier-max"
                  style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}
                  numberOfLines={2}
                >
                  {outcomeMessage}
                </Text>
              ) : null}
            </View>
          </View>
          <Pressable
            onPress={confirmCounterBid}
            disabled={counterPending}
            style={{
              backgroundColor: '#fff',
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 999,
              opacity: counterPending ? 0.6 : 1,
            }}
          >
            <Text
              style={{
                color: colors.danger,
                fontSize: 13,
                fontWeight: '900',
                letterSpacing: 0.4,
              }}
            >
              {counterPending ? 'Bidding…' : `Bid ${formatCents(counterCents)} →`}
            </Text>
          </Pressable>
        </View>
      )}
      {!showExtensionFlash && lostClosed && outcomeMessage && (
        <View
          testID="lost-banner"
          style={{
            backgroundColor: colors.surfaceAlt,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
            {outcomeMessage}
          </Text>
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
        <PhotoCarousel photos={lot.photo_urls ?? []} />

        <View style={{ padding: 16 }}>
          {lot.operators && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {lot.operators.logo_url ? (
                <Image
                  source={{ uri: lot.operators.logo_url }}
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                  resizeMode="contain"
                />
              ) : (
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    backgroundColor: lot.operators.brand_color ?? colors.surfaceHi,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 12, fontWeight: '900' }}>
                    {lot.operators.business_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <Text
                style={{
                  color: lot.operators.brand_color ?? colors.textMuted,
                  fontSize: 12,
                  ...type.label,
                }}
              >
                {lot.operators.business_name}
              </Text>
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 12,
                  fontWeight: '900',
                  letterSpacing: 0.6,
                  marginLeft: 4,
                }}
              >
                · {lotDisplayCode(lot) ?? lot.lot_code}
              </Text>
            </View>
          )}

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <Text
              style={{
                color: colors.text,
                fontSize: 24,
                flex: 1,
                marginRight: 12,
                ...type.display,
              }}
            >
              {lot.title}
            </Text>
            <WatchlistToggle lotId={lot.id} />
          </View>

          {lot.description && (
            <Text style={{ color: colors.textMuted, marginTop: 8, lineHeight: 20 }}>
              {lot.description}
            </Text>
          )}

          {/* Identifiers (Stream C) — product identity for trust + off-platform
              lookup. Only fields present on the lot render; values are selectable
              so bidders can copy a UPC/ASIN. Operator-internal fields
              (cost, return reason, pallet) are never selected or shown. */}
          {(lot.brand || lot.model || lot.mpn || lot.upc || lot.asin || lot.fnsku || lot.lpn || lot.product_sku || lot.site_sku || lot.manufacture_sku) && (
            <View
              style={{
                marginTop: 16,
                padding: 14,
                backgroundColor: colors.surface,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 8, ...type.label }}>
                IDENTIFIERS
              </Text>
              {(
                [
                  ['Brand', lot.brand],
                  ['Model', lot.model],
                  ['MPN', lot.mpn],
                  ['Product SKU', lot.product_sku],
                  ['Site SKU', lot.site_sku],
                  ['Mfr SKU', lot.manufacture_sku],
                  ['UPC', lot.upc],
                  ['ASIN', lot.asin],
                  ['FNSKU', lot.fnsku],
                  ['LPN', lot.lpn],
                ] as const
              ).map(([label, value]) =>
                value ? (
                  <View
                    key={label}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      paddingVertical: 3,
                    }}
                  >
                    <Text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</Text>
                    <Text
                      selectable
                      style={{
                        color: colors.text,
                        fontSize: 13,
                        fontWeight: '600',
                        flexShrink: 1,
                        textAlign: 'right',
                        marginLeft: 12,
                      }}
                    >
                      {value}
                    </Text>
                  </View>
                ) : null,
              )}
            </View>
          )}

          {/* Stat block — current bid, bid count, countdown. The countdown
              tile uses the heat color and pulses when urgent. */}
          <View
            style={{
              marginTop: 20,
              padding: 16,
              backgroundColor: colors.surface,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: isUrgent ? colors.danger : colors.border,
            }}
          >
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 11,
                ...type.label,
              }}
            >
              {lot.current_bid_cents != null ? 'Current bid' : 'Starts at'}
            </Text>
            <Text
              style={{
                color: colors.text,
                fontSize: 36,
                marginTop: 2,
                ...type.displayHero,
              }}
            >
              {formatCents(displayPriceCents)}
            </Text>
            {buyerPremiumBps > 0 && (
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                {`+ ${(buyerPremiumBps / 100).toFixed(buyerPremiumBps % 100 === 0 ? 0 : 1)}% buyer's premium · `}
                <Text style={{ color: colors.text, fontWeight: '700' }}>
                  {`${formatCents(Math.round(displayPriceCents * (1 + buyerPremiumBps / 10000)))} all-in`}
                </Text>
              </Text>
            )}

            <View
              style={{
                flexDirection: 'row',
                gap: 12,
                marginTop: 16,
              }}
            >
              <View
                style={{
                  flex: 1,
                  padding: 10,
                  backgroundColor: colors.surfaceAlt,
                  borderRadius: 10,
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 10, ...type.label }}>
                  Bids
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                  {lot.bid_count > 0 && <Text style={{ fontSize: 14 }}>🔥</Text>}
                  <Text
                    style={{
                      color: colors.text,
                      fontSize: 20,
                      ...type.display,
                    }}
                  >
                    {lot.bid_count}
                  </Text>
                </View>
                {myBidCount > 0 && (
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    {myBidCount} yours
                  </Text>
                )}
              </View>
              <Animated.View
                style={{
                  flex: 1.4,
                  padding: 10,
                  backgroundColor: isUrgent ? colors.dangerDim : colors.surfaceAlt,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: isUrgent ? colors.danger : 'transparent',
                  opacity: pulse,
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 10, ...type.label }}>
                  {heat === 'closed' ? 'Result' : 'Closes in'}
                </Text>
                <Text
                  style={{
                    color: lostClosed ? colors.danger : heatHex,
                    fontSize: 20,
                    ...type.display,
                  }}
                >
                  {lostClosed ? 'Outbid' : countdown}
                </Text>
              </Animated.View>
            </View>

            {lot.msrp_cents != null && (
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 12,
                  marginTop: 12,
                }}
              >
                MSRP: {formatCents(lot.msrp_cents)} ·{' '}
                <Text style={{ color: colors.success, fontWeight: '900' }}>
                  {Math.round(
                    (1 - displayPriceCents / lot.msrp_cents) * 100,
                  )}
                  % off
                </Text>
              </Text>
            )}
          </View>

          {/* 1C — SavingsCallout: below the price stat block, above bid sheet */}
          <SavingsCallout
            msrpCents={lot.msrp_cents}
            displayPriceCents={displayPriceCents}
          />

          {/* Live bid ticker — only renders during the closing window
              ('closing' = <30m, 'urgent' = <2m). Outside that window
              the component returns null and we pay nothing. */}
          <LiveBidTicker
            lotId={lot.id}
            active={heat === 'urgent' || heat === 'closing'}
            lastBidTickAt={lastBidTickAt}
            now={now}
          />

          {/* 0105 gating banners — visible above the bid sheet when the
              bidder is missing a card or has unpaid fees. Tapping the
              CTA opens the relevant fix-it screen; once they come back
              the screen remounts and the banner disappears. We render
              fees first since they block ALL bidding (a bidder with no
              card AND fees has both — paying fees doesn't unblock until
              they also add a card). */}
          {/* 0221: preview pre-bidding banner — this lot is biddable before the
              auction opens. Copy mirrors the web BidWidget. */}
          {prebidOpen && (
            <View
              style={{
                marginHorizontal: 16,
                marginBottom: 10,
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.primary,
                backgroundColor: colors.primaryDim,
              }}
            >
              <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800', marginBottom: 2 }}>
                PRE-BIDDING OPEN
              </Text>
              <Text style={{ color: colors.text, fontSize: 12, lineHeight: 17 }}>
                Place your max bid now — proxy bidding defends it when the auction
                goes live{lot.auctions?.starts_at ? ` (${new Date(lot.auctions.starts_at).toLocaleString()})` : ''}.
              </Text>
            </View>
          )}

          {canBid && !paymentsDisabled && unpaidFeesCents > 0 && (
            <Pressable
              onPress={() => router.push('/profile/pay-fees' as never)}
              style={{
                marginTop: 16,
                padding: 14,
                backgroundColor: colors.dangerDim,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.danger,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.danger, fontSize: 12, ...type.label }}>
                  Pay fees to bid
                </Text>
                <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>
                  {`You owe ${formatCents(unpaidFeesCents)} in fees.`}
                </Text>
              </View>
              <Text style={{ color: colors.danger, fontSize: 14, fontWeight: '800' }}>
                Pay →
              </Text>
            </Pressable>
          )}
          {canBid && !paymentsDisabled && needsCard && unpaidFeesCents <= 0 && (
            <Pressable
              onPress={() => router.push('/profile/payment-method' as never)}
              style={{
                marginTop: 16,
                padding: 14,
                backgroundColor: colors.primaryDim,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.primary,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.primary, fontSize: 12, ...type.label }}>
                  Add a card to bid
                </Text>
                <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>
                  We&apos;ll charge it automatically when you win.
                </Text>
              </View>
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '800' }}>
                Add →
              </Text>
            </Pressable>
          )}

          {/* One-tap quick-bid — surfaces the same counterBid() that powers
              the red Outbid banner, but in the NOT-outbid state (no bid yet
              or currently winning) so a bidder can jump the next increment
              without expanding the bid sheet. Hidden when youHaveLost is true
              because the red Outbid banner already shows this exact action,
              and hidden for dutch / last_chance (those use BuyNowSheet, where
              "next minimum increment" isn't the bid model). Reuses counterBid
              verbatim — same in-flight guard (counterPending), identity gate,
              policy gate, and reason routing. */}
          {canBid &&
            !youHaveLost &&
            lot.auctions?.format !== 'dutch' &&
            lot.auctions?.format !== 'last_chance' && (
              <Pressable
                onPress={confirmCounterBid}
                disabled={counterPending}
                style={{
                  marginTop: 16,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: colors.primaryDim,
                  borderWidth: 1,
                  borderColor: colors.primary,
                  alignItems: 'center',
                  opacity: counterPending ? 0.6 : 1,
                }}
              >
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: 15,
                    fontWeight: '900',
                    letterSpacing: 0.4,
                  }}
                >
                  {counterPending
                    ? 'Bidding…'
                    : `Quick bid ${formatCents(counterCents)} →`}
                </Text>
              </Pressable>
            )}

          {/* Dutch / last_chance keep their dedicated BuyNowSheet, always
              expanded — "next minimum increment" isn't their bid model so the
              quick-bid CTA above is hidden for them and this is their only
              surface. (BID-1 does not touch this flow.) */}
          {canBid &&
            (lot.auctions?.format === 'dutch' || lot.auctions?.format === 'last_chance') && (
              <BuyNowSheet
                lotId={lot.id}
                format={lot.auctions.format}
                flatPriceCents={lot.flat_price_cents}
                dutchStartCents={lot.dutch_start_cents}
                dutchFloorCents={lot.dutch_floor_cents}
                dutchDeclinePerMinuteCents={lot.dutch_decline_per_minute_cents}
                auctionStartsAt={lot.auctions.starts_at}
                beforeBuy={requireAcceptance}
              />
            )}

          {/* BID-1: standard lots — the max-bid / proxy PlaceBidSheet is now a
              SECONDARY, collapsed affordance under the primary quick-bid CTA.
              Power users tap "Set a max bid" to reveal the proxy input; the
              +$1/+$5/+$10 chip ladder no longer competes as a second primary
              bid surface. The capability is fully preserved — same
              PlaceBidSheet, same beforeBid (policy) + identity gates, same
              onPlaced state mirroring. */}
          {canBid &&
            lot.auctions?.format !== 'dutch' &&
            lot.auctions?.format !== 'last_chance' && (
              <>
                <Pressable
                  onPress={() => setShowMaxBid((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel="Set a max bid"
                  style={{
                    marginTop: 12,
                    paddingVertical: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <Text
                    style={{
                      color: colors.textMuted,
                      fontSize: 13,
                      fontWeight: '700',
                      letterSpacing: 0.3,
                    }}
                  >
                    {showMaxBid ? 'Hide max bid' : 'Set a max bid'}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    {showMaxBid ? '▲' : '▼'}
                  </Text>
                </Pressable>
                {showMaxBid && (
                  <PlaceBidSheet
                    lotId={lot.id}
                    currentBidCents={lot.current_bid_cents}
                    startingBidCents={lot.starting_bid_cents}
                    incrementSchedule={effectiveSchedule}
                    msrpCents={lot.msrp_cents}
                    closeAt={lot.close_at}
                    onPlaced={(result) => {
                      setIHaveBid(true);
                      setMyBidsVersion((v) => v + 1);
                      // M3: consume the RPC result so the winning/leader state
                      // flips instantly instead of waiting for the Realtime echo.
                      // PlaceBidSheet already knows the outcome (current_leader_id
                      // + current_bid_cents) and has already fired the local
                      // success/outbid haptic, so we only mirror state here —
                      // no haptic from this path.
                      //
                      // Guard: do NOT unconditionally claim the lead. On a
                      // proxy-outbid the leader is someone else, so we must let
                      // winner_bidder_id reflect that (the OUTBID banner stays
                      // correct). We trust the server's current_leader_id verbatim.
                      setLot((prev) =>
                        prev
                          ? {
                              ...prev,
                              winner_bidder_id: result.current_leader_id,
                              current_bid_cents:
                                result.current_bid_cents ?? prev.current_bid_cents,
                            }
                          : prev,
                      );
                      // Keep the diff ref in lock-step with the optimistic update
                      // so the Realtime UPDATE that echoes this same winner is
                      // seen as "no change" and doesn't double-fire the win/outbid
                      // haptic (PlaceBidSheet already played it).
                      prevWinnerRef.current = result.current_leader_id;
                    }}
                    beforeBid={beforeBid}
                  />
                )}
              </>
            )}

          {/* 1C — PickupInfoCard: between bid sheet and operator policy card */}
          {lot.auction_id !== null && (
            <PickupInfoCard
              closeAt={lot.close_at}
              pickupEndsAt={lot.auctions?.pickup_ends_at ?? null}
              binLocation={binLocation}
              warehouseTz={lot.auctions?.warehouses?.timezone ?? null}
              pickupLoc={pickupLoc}
            />
          )}

          {/* Per-operator policy summary card — 4 lines max, compact.
              Tells the bidder up-front how this operator handles payment,
              pickup, refunds, and shipping so there are no surprises
              after the bid lands. The full text lives behind the
              acceptance modal. */}
          {operatorPolicy && (
            <View
              testID="refund-policy-section"
              style={{
                marginTop: 14,
                padding: 12,
                backgroundColor: colors.surfaceAlt,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                gap: 4,
              }}
            >
              <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                Operator terms
              </Text>
              {lot.operators && (
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {`Buyer's premium: ${
                    (lot.auctions?.buyer_premium_bps ??
                      lot.operators.default_buyer_premium_bps) / 100
                  }% added to your winning bid`}
                </Text>
              )}
              {/* PR-A1 (2026-05-29): hid the "Pay within Xh" line. Auto-charge
                  fires immediately at lot close per trigger_enqueue_auto_charge
                  (mig 0105) — the operator_policies.payment_window_hours column
                  is display-only, not enforced. Replaced with the truthful
                  auto-charge wording so bidders aren't misled. */}
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {paymentsDisabled
                  ? 'No card needed right now — you settle your winning invoice with the seller (cash/offline) at pickup.'
                  : 'Your saved card is charged automatically at auction close.'}
              </Text>
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {`${operatorPolicy.pickup_window_days} day${
                  operatorPolicy.pickup_window_days === 1 ? '' : 's'
                } to pick up`}
              </Text>
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {lot?.operators?.offers_shipping
                  ? 'Shipping available — see operator policy'
                  : 'Shipping: not available'}
              </Text>
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {operatorPolicy.refund_window_post_pickup_hours === 0
                  ? 'All sales final after pickup'
                  : `${operatorPolicy.refund_window_post_pickup_hours}-hour return window after pickup`}
              </Text>
              {/* PR-B (mig 0157): no-show / restock disclosure so the bidder
                  knows up-front what happens if they miss their pickup. */}
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {operatorPolicy.no_show_policy === 'refund_minus_restock'
                  ? operatorPolicy.restock_fee_cents > 0
                    ? `If not picked up in time: refund minus ${formatCents(operatorPolicy.restock_fee_cents)} restock fee.`
                    : 'If not picked up in time: full refund issued.'
                  : 'If not picked up in time: lot forfeited, no refund.'}
              </Text>
              {/* PR-B (mig 0157): relist-fee disclosure for declined-card path. */}
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {operatorPolicy.relist_fee_cents > 0
                  ? `If your card declines and grace expires: lot relisted + ${formatCents(operatorPolicy.relist_fee_cents)} fee.`
                  : 'If your card declines and grace expires: lot relisted (no fee).'}
              </Text>
            </View>
          )}

          {/* 1C — AnonymizedBidHistory: below stat block + operator policy */}
          <AnonymizedBidHistory
            bids={bids}
            totalCount={lot.bid_count}
            myCount={myBidCount}
            viewerBidderId={me}
            warehouseTz={lot.auctions?.warehouses?.timezone ?? null}
          />
        </View>

        {/* 1C — SimilarLotsRail: full-width below the padded content block */}
        <SimilarLotsRail lots={similarLots} mode={similarLotsMode} now={now} />
      </ScrollView>

      <OperatorPolicyModal
        visible={policyModalVisible}
        operatorBusinessName={lot.operators?.business_name ?? 'this operator'}
        buyerPremiumBps={
          lot.auctions?.buyer_premium_bps ??
          lot.operators?.default_buyer_premium_bps ??
          null
        }
        policy={
          operatorPolicy
            ? ({
                operator_id: operatorPolicy.operator_id,
                version: operatorPolicy.version,
                terms_md: operatorPolicy.terms_md,
                refund_md: operatorPolicy.refund_md,
                shipping_md: operatorPolicy.shipping_md,
              } satisfies OperatorPolicyForModal)
            : null
        }
        onCancel={handlePolicyCancel}
        onAccepted={handlePolicyAccepted}
      />
      <OffsiteNoticeModal
        visible={offsiteModalVisible}
        pickup={offsitePrompt?.pickup ?? null}
        warehouseId={offsitePrompt?.warehouseId ?? null}
        onCancel={handleOffsiteCancel}
        onAccepted={handleOffsiteAccepted}
      />
    </View>
    </KeyboardAvoidingView>
  );
}
