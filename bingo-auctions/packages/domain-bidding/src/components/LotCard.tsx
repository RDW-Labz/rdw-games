// LotCard — the visual unit of the browse grid.
//
// Two variants:
//   'mac-bid'  (default) — MAC.BID-parity chrome: segmented bottom countdown,
//                           single-pill priority badge top-left, red savings pill
//                           alongside the price. Matches the web LotCard visual
//                           hierarchy exactly.
//   'classic'            — legacy layout preserved for call sites that haven't
//                           opted into the new chrome yet. Swap by passing
//                           variant='classic'.
//
// Photo zone overlays (z-order, ascending):
//   z:1 — photo (expo-image, cover fit)
//   z:2 — top-left priority badge (single pill: ENDING SOON > TOP DEAL > CONDITION)
//   z:2 — bottom segmented countdown bar ("3h | 12m | 04s")
//   z:3 — watchlist heart (future: not yet wired; structure kept)
//
// Badge priority (top-left, single pill — mirrors web resolveBadge):
//   1. ENDING SOON — closes within 5 min of now
//   2. TOP DEAL    — current bid < 1.5× starting bid
//   3. CONDITION   — CONDITION_LABEL_MAP lookup
//
// Savings pill (alongside price):
//   Only renders when msrp_cents > displayPrice and percent >= 10.
//   backgroundColor rgba(255,59,59,0.15), color #ff3b3b — matches web.
//
// The 1Hz `now` prop is wired by apps/bidder-app/app/(tabs)/index.tsx
// and drives the memo comparator. The segmented countdown reads from
// `now` directly so seconds visibly tick without a separate local state.

import { memo, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, View, Text, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { formatCents, lotDisplayCode } from '@auction-platform/shared';
import {
  colors,
  type,
  heatFromCloseAt,
  formatCountdown,
} from '@auction-platform/design-system';
import { WatchlistToggle } from './WatchlistToggle';

// ── No-photo fallback ─────────────────────────────────────────────────────────
// Bundled with the JS bundle — never fetched. The old remote placeholder lived
// on the BinGo CDN, which BinGo doesn't own, so photo-less lots 404'd.
const NO_PHOTO = require('../assets/no-photo.png');

// ── Layout constants ──────────────────────────────────────────────────────────

const SCREEN = Dimensions.get('window');
const GUTTER = 8;
const COLS = 2;
export const CARD_WIDTH = (SCREEN.width - GUTTER * (COLS + 1)) / COLS;

// ── Types ─────────────────────────────────────────────────────────────────────

export type LotCardData = {
  id: string;
  lot_code: string;
  sticker_code?: string | null;
  display_code?: string | null;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  msrp_cents: number | null;
  bid_count: number;
  close_at: string;
  status: string;
  condition: string | null;
  operator_business_name: string;
  operator_logo_url: string | null;
  operator_brand_color: string | null;
};

// ── Badge logic ───────────────────────────────────────────────────────────────

/**
 * Maps lot_condition enum values (packages/db/migrations/0001_init.sql:23)
 * and legacy variant spellings to display labels for the condition pill badge.
 *
 * Canonical slugs (what lotting writes to lots.condition):
 *   appears_new → APPEARS NEW
 *   open_box    → OPEN BOX
 *   good        → GOOD
 *   as_is       → AS-IS
 *
 * Legacy hyphenated variants and old pack-aligned slugs are preserved for
 * rows written by older code paths — they render a reasonable label but
 * lotting no longer produces them.
 */
const CONDITION_LABEL_MAP: Readonly<Record<string, string>> = {
  // Canonical lot_condition enum values (migration 0001)
  appears_new: 'APPEARS NEW',
  open_box: 'OPEN BOX',
  good: 'GOOD',
  as_is: 'AS-IS',
  // Legacy hyphenated variants from older code paths
  'open-box': 'OPEN BOX',
  'as-is': 'AS-IS',
  // Old pack-aligned slugs — kept so seed/test data still renders a pill
  new: 'APPEARS NEW',
  'like-new': 'APPEARS NEW',
  like_new: 'APPEARS NEW',
  tested: 'GOOD',
  // Other legacy values
  used: 'USED',
  refurbished: 'REFURB',
  damaged: 'DAMAGED',
  salvage: 'SALVAGE',
  parts: 'PARTS',
};

type BadgeKind =
  | { type: 'ending-soon' }
  | { type: 'top-deal' }
  | { type: 'condition'; label: string };

/** Pure function — mirrors the web's resolveBadge exactly. */
function resolveBadge(lot: LotCardData, nowMs: number): BadgeKind | null {
  const closeMs = new Date(lot.close_at).getTime();

  // 1. Ending soon — closes within 5 minutes
  if (closeMs - nowMs <= 5 * 60 * 1000 && closeMs > nowMs) {
    return { type: 'ending-soon' };
  }

  // 2. Top deal — current bid < 1.5× starting bid (only when bids exist)
  const currentBid = lot.current_bid_cents;
  if (currentBid !== null && currentBid < lot.starting_bid_cents * 1.5) {
    return { type: 'top-deal' };
  }

  // 3. Condition label pill
  if (lot.condition) {
    const label = CONDITION_LABEL_MAP[lot.condition];
    if (label) return { type: 'condition', label };
  }

  return null;
}

// ── Segmented countdown ───────────────────────────────────────────────────────

interface SegmentedTime {
  closed: boolean;
  /** True when diff < 2 min — flips pill background to danger red. */
  urgent: boolean;
  /** E.g. ["3h", "12m", "04s"]. Leading-zero segments are stripped. */
  segments: string[];
}

/**
 * Mirrors the web's formatSegmentedTime.
 *
 * Rules:
 *   - Negative diff → { closed: true }
 *   - Drop leading-zero segments ("0d 3h 12m" → "3h 12m 04s")
 *   - Cap at 3 segments
 *   - Seconds are zero-padded two-digit ("04s") for stable monospace display
 */
function formatSegmentedTime(closeAt: string, nowMs: number): SegmentedTime {
  const diffMs = new Date(closeAt).getTime() - nowMs;
  if (diffMs <= 0) {
    return { closed: true, urgent: false, segments: [] };
  }

  const urgent = diffMs < 2 * 60 * 1000;
  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const pad2 = (n: number): string => String(n).padStart(2, '0');

  const all: Array<{ value: number; label: string }> = [
    { value: days, label: `${days}d` },
    { value: hours, label: `${hours}h` },
    { value: mins, label: `${mins}m` },
    { value: secs, label: `${pad2(secs)}s` },
  ];

  let firstNonZero = all.findIndex((seg) => seg.value > 0);
  if (firstNonZero === -1) firstNonZero = all.length - 1;

  const segments = all.slice(firstNonZero, firstNonZero + 3).map((s) => s.label);
  return { closed: false, urgent, segments };
}

// ── Savings helper ────────────────────────────────────────────────────────────

const SAVINGS_MIN_PERCENT = 10;

interface SavingsInfo {
  percent: number;
  msrpCents: number;
}

/** Mirrors the web's resolveSavings. */
function resolveSavings(
  msrpCents: number | null | undefined,
  displayPriceCents: number,
): SavingsInfo | null {
  if (!msrpCents || msrpCents <= 0 || msrpCents <= displayPriceCents) return null;
  const percent = Math.round((1 - displayPriceCents / msrpCents) * 100);
  if (percent < SAVINGS_MIN_PERCENT) return null;
  return { percent, msrpCents };
}

// ── Badge colour tokens ───────────────────────────────────────────────────────

// Matches web: ending-soon → danger red, top-deal/condition → accent lime
const BADGE_ENDING_SOON = { bg: colors.danger, fg: '#ffffff' } as const;
const BADGE_DEAL = { bg: '#c8f135', fg: '#0a0c11' } as const; // accent lime

// ── Sub-components ────────────────────────────────────────────────────────────

function PriorityBadge({ badge }: { badge: BadgeKind }) {
  const { bg, fg } =
    badge.type === 'ending-soon' ? BADGE_ENDING_SOON : BADGE_DEAL;
  const label =
    badge.type === 'ending-soon'
      ? 'ENDING SOON'
      : badge.type === 'top-deal'
        ? 'TOP DEAL'
        : badge.label;

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: bg,
        borderRadius: 999,
        // elevation/shadow for legibility over bright photos
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.35,
        shadowRadius: 4,
        elevation: 3,
      }}
    >
      <Text
        style={{
          color: fg,
          fontSize: 11,
          fontWeight: '800',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function CountdownBar({ time }: { time: SegmentedTime }) {
  if (time.closed) return null;

  const bg = time.urgent ? colors.danger : 'rgba(10, 12, 17, 0.85)';

  return (
    <View
      accessible
      accessibilityLabel={`Time remaining: ${time.segments.join(' ')}`}
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        right: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.35,
        shadowRadius: 4,
        elevation: 3,
      }}
    >
      {time.segments.map((seg, i) => (
        <View key={seg + String(i)} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            style={{
              color: '#ffffff',
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.8,
              // tabular-nums keeps digits from jumping as seconds change
              fontVariant: ['tabular-nums'],
            }}
          >
            {seg}
          </Text>
          {i < time.segments.length - 1 && (
            <Text
              aria-hidden
              style={{
                color: '#ffffff',
                fontSize: 11,
                fontWeight: '400',
                opacity: 0.35,
                marginHorizontal: 5,
              }}
            >
              |
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

// Preview-B (2026-06-11): static "Upcoming" pill shown on scheduled lots in
// place of the ticking CountdownBar. Mirrors the web LotCard's gating — a
// not-yet-open lot must not show a live timer. Same bottom-edge anchor and
// chrome as CountdownBar (muted, non-urgent) so the card layout is stable.
function UpcomingBar() {
  return (
    <View
      accessible
      accessibilityLabel="Upcoming — bidding not open yet"
      style={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        right: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(10, 12, 17, 0.85)',
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.35,
        shadowRadius: 4,
        elevation: 3,
      }}
    >
      <Text
        style={{
          color: '#ffffff',
          fontSize: 11,
          fontWeight: '800',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        Upcoming
      </Text>
    </View>
  );
}

// ── WatchlistHeartOverlay ─────────────────────────────────────────────────────
//
// Compact heart rendered at z:3 (top-right of photo zone). Uses a thin
// wrapper around WatchlistToggle's logic so we can swap in a heart icon
// without changing WatchlistToggle's existing button layout (which is
// also used on the lot detail screen as a larger standalone button).

function WatchlistHeartOverlay({ lotId }: { lotId: string }) {
  return (
    <View
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 3,
        // Intercept touches so the parent Pressable (lot detail nav) does
        // not also fire when tapping the heart.
      }}
      // Stop touch from bubbling through to the Link/Pressable below.
      onStartShouldSetResponder={() => true}
    >
      <WatchlistToggle lotId={lotId} compact />
    </View>
  );
}

// ── mac-bid variant body ──────────────────────────────────────────────────────

function MacBidCard({
  lot,
  now,
  source,
  showWatchlistHeart = false,
  onPressOverride,
  quickBid,
}: {
  lot: LotCardData;
  now: number;
  source?: LotCardSource;
  showWatchlistHeart?: boolean;
  onPressOverride?: (lotId: string) => void;
  quickBid?: (lot: LotCardData) => ReactNode;
}) {
  const heat = heatFromCloseAt(lot.close_at, lot.status);
  const isUrgent = heat === 'urgent';

  const photo = lot.photo_urls?.[0] ?? null;

  const badge = resolveBadge(lot, now);
  const segmented = formatSegmentedTime(lot.close_at, now);

  const displayPrice =
    lot.current_bid_cents !== null ? lot.current_bid_cents : lot.starting_bid_cents;
  const hasBids = lot.current_bid_cents !== null;
  const priceLabel = hasBids ? 'CURRENT' : 'STARTS AT';
  const savings = resolveSavings(lot.msrp_cents, displayPrice);

  // Urgent pulse — stays on RN Animated (not Reanimated) to avoid the
  // Worklets TurboModule requirement until a custom dev client is built.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isUrgent) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isUrgent, pulse]);

  // With onPressOverride the card is a plain Pressable (the caller decides
  // where the tap goes — e.g. the vertical browse pager); otherwise it's the
  // usual Link to /lot/[id].
  const inner = (
      <Pressable
        onPress={onPressOverride ? () => onPressOverride(lot.id) : undefined}
        testID={`lot-card-${lot.lot_code}`}
        accessibilityLabel={`${lot.title}, ${hasBids ? `Current bid ${formatCents(displayPrice)}` : `Starts at ${formatCents(displayPrice)}`}`}
        accessibilityRole="button"
        style={{
          width: CARD_WIDTH,
          marginBottom: GUTTER,
          backgroundColor: colors.surface,
          borderRadius: 14,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: isUrgent ? colors.danger : colors.border,
        }}
      >
        {/* ── Photo zone (3:2 aspect ratio, mirrors web) ── */}
        <Animated.View
          style={{
            width: '100%',
            aspectRatio: 3 / 2,
            backgroundColor: colors.surfaceAlt,
            opacity: pulse,
          }}
        >
          {photo ? (
            <Image
              source={{ uri: photo }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              transition={120}
              onError={() => {/* expo-image shows blank; operator-initial fallback below shows through */}}
            />
          ) : (
            <Image
              source={NO_PHOTO}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
            />
          )}

          {/* Operator-initial secondary fallback — only visible if the
              lot photo fails to load (the bundled no-photo asset can't).
              Sits behind the Image components via z-order; expo-image
              renders opaque on success, transparent on error, so this
              shows through only on network failure. */}
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: lot.operator_brand_color ?? colors.surfaceAlt,
              // Behind both Image layers
              zIndex: -1,
            }}
          >
            <Text
              style={{ color: colors.text, fontSize: 36, ...type.displayHero }}
            >
              {lot.operator_business_name.charAt(0).toUpperCase()}
            </Text>
          </View>

          {/* Priority badge — single pill, top-left */}
          {badge && <PriorityBadge badge={badge} />}

          {/* Segmented countdown — bottom edge. Preview-B (2026-06-11): a
              scheduled lot must not look live, so show a static "Upcoming"
              pill instead of the ticking timer. Live (and any non-scheduled)
              lots keep the live countdown unchanged. */}
          {lot.status === 'scheduled' ? (
            <UpcomingBar />
          ) : (
            <CountdownBar time={segmented} />
          )}

          {/* z:3 — watchlist heart overlay, top-right. Only rendered when
              showWatchlistHeart=true (opt-in per call site). Uses a
              compact heart-icon Pressable so it doesn't crowd the badge. */}
          {showWatchlistHeart && (
            <WatchlistHeartOverlay lotId={lot.id} />
          )}
        </Animated.View>

        {/* ── Text body ── */}
        <View style={{ padding: 10, gap: 4 }}>
          {/* Lot code — small accent label */}
          <Text
            style={{
              color: colors.primary,
              fontSize: 9,
              fontWeight: '900',
              letterSpacing: 0.4,
            }}
          >
            {lotDisplayCode(lot) ?? lot.lot_code}
          </Text>

          {/* Title — 2-line clamp */}
          <Text
            numberOfLines={2}
            style={{
              color: colors.text,
              fontSize: 13,
              fontWeight: '700',
              minHeight: 32,
            }}
          >
            {lot.title}
          </Text>

          {/* Price label */}
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 9,
              ...type.label,
            }}
          >
            {priceLabel}
          </Text>

          {/* Price line: price + optional MSRP strikethrough + savings pill */}
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            <Text
              style={{
                color: hasBids ? colors.text : colors.textMuted,
                fontSize: 16,
                ...type.display,
              }}
            >
              {formatCents(displayPrice)}
            </Text>

            {savings !== null && (
              <>
                <Text
                  style={{
                    fontSize: 12,
                    color: colors.textMuted,
                    textDecorationLine: 'line-through',
                  }}
                >
                  {formatCents(savings.msrpCents)}
                </Text>
                <View
                  accessible
                  accessibilityLabel={`Save ${savings.percent} percent`}
                  style={{
                    backgroundColor: 'rgba(255, 59, 59, 0.15)',
                    borderRadius: 4,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                  }}
                >
                  <Text
                    style={{
                      color: '#ff3b3b',
                      fontSize: 11,
                      fontWeight: '800',
                      letterSpacing: 0.3,
                    }}
                  >
                    -{savings.percent}%
                  </Text>
                </View>
              </>
            )}
          </View>
          {/* Quick Bid slot (customer request 2026-07-29): bid from the
              thumbnail without opening the listing, for the last seconds of an
              auction. Rendered by the host so this shared card stays free of
              bidding/auth logic and web keeps its current behaviour until it
              opts in. Sits OUTSIDE the tap target below so a bid press can
              never be read as a navigation press. */}
          {quickBid ? quickBid(lot) : null}
        </View>
      </Pressable>
  );
  if (onPressOverride) return inner;
  return (
    <Link
      href={{
        pathname: '/lot/[id]',
        params: source ? { id: lot.id, source } : { id: lot.id },
      }}
      asChild
    >
      {inner}
    </Link>
  );
}

// ── classic variant body ──────────────────────────────────────────────────────
// Preserved exactly from the pre-parity implementation so existing call
// sites can opt out of the new chrome with variant='classic'.

const CONDITION_LABEL_CLASSIC: Readonly<Record<string, string>> = {
  new: 'New',
  open_box: 'Open box',
  like_new: 'Like new',
  used: 'Used',
  refurbished: 'Refurb',
  damaged: 'Damaged',
  salvage: 'Salvage',
  parts: 'Parts',
  unknown: '',
};

const CONDITION_TINT: Readonly<
  Record<string, { bg: string; fg: string }>
> = {
  new: { bg: 'rgba(34, 197, 94, 0.18)', fg: colors.success },
  open_box: { bg: 'rgba(34, 197, 94, 0.12)', fg: colors.success },
  like_new: { bg: 'rgba(34, 197, 94, 0.12)', fg: colors.success },
  used: { bg: 'rgba(255, 122, 0, 0.14)', fg: colors.primary },
  refurbished: { bg: 'rgba(255, 122, 0, 0.14)', fg: colors.primary },
  damaged: { bg: 'rgba(255, 59, 59, 0.14)', fg: colors.danger },
  salvage: { bg: 'rgba(255, 59, 59, 0.14)', fg: colors.danger },
  parts: { bg: 'rgba(255, 59, 59, 0.14)', fg: colors.danger },
};

function ClassicCard({
  lot,
  now: _now,
  source,
}: {
  lot: LotCardData;
  now: number;
  source?: LotCardSource;
}) {
  const heat = heatFromCloseAt(lot.close_at, lot.status);
  const isUrgent = heat === 'urgent';
  const photo = lot.photo_urls?.[0] ?? null;

  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isUrgent) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isUrgent, pulse]);

  const countdown = formatCountdown(lot.close_at);

  const heatHex = (() => {
    switch (heat) {
      case 'urgent': return colors.danger;
      case 'closing': return colors.primary;
      case 'live': return colors.success;
      case 'scheduled': return colors.textMuted;
      case 'closed': return colors.textDim;
    }
  })();

  const price =
    lot.current_bid_cents !== null ? lot.current_bid_cents : lot.starting_bid_cents;
  const priceLabel = lot.current_bid_cents !== null ? 'CURRENT' : 'STARTS AT';

  let msrpPercent: number | null = null;
  if (lot.msrp_cents !== null && lot.msrp_cents > 0 && price < lot.msrp_cents) {
    msrpPercent = Math.floor((1 - price / lot.msrp_cents) * 100);
    if (msrpPercent < 1) msrpPercent = null;
  }

  const conditionLabel = lot.condition ? (CONDITION_LABEL_CLASSIC[lot.condition] ?? '') : '';
  const conditionTint = lot.condition ? (CONDITION_TINT[lot.condition] ?? null) : null;

  return (
    <Link
      href={{
        pathname: '/lot/[id]',
        params: source ? { id: lot.id, source } : { id: lot.id },
      }}
      asChild
    >
      <Pressable
        testID={`lot-card-${lot.lot_code}`}
        accessibilityLabel={`${lot.title}, ${lot.current_bid_cents !== null ? `Current bid ${formatCents(price)}` : `Starts at ${formatCents(price)}`}`}
        accessibilityRole="button"
        style={{
          width: CARD_WIDTH,
          marginBottom: GUTTER,
          backgroundColor: colors.surface,
          borderRadius: 14,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: isUrgent ? colors.danger : colors.border,
        }}
      >
        <View style={{ width: '100%', aspectRatio: 4 / 3, backgroundColor: colors.surfaceAlt }}>
          {photo ? (
            <Image
              source={{ uri: photo }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              transition={120}
            />
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: lot.operator_brand_color ?? colors.surfaceAlt,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 36, ...type.displayHero }}>
                {lot.operator_business_name.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}

          {lot.bid_count > 0 && (
            <View
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                paddingHorizontal: 8,
                paddingVertical: 4,
                backgroundColor: 'rgba(0, 0, 0, 0.65)',
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Text style={{ fontSize: 11 }}>🔥</Text>
              <Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>
                {lot.bid_count}
              </Text>
            </View>
          )}

          <Animated.View
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              opacity: pulse,
              paddingHorizontal: 8,
              paddingVertical: 4,
              backgroundColor: heatHex,
              borderRadius: 6,
            }}
          >
            <Text
              style={{
                color: heat === 'closing' || heat === 'urgent' ? '#000' : colors.text,
                fontSize: 11,
                fontWeight: '900',
                letterSpacing: 0.4,
              }}
            >
              {countdown}
            </Text>
          </Animated.View>

          {conditionLabel !== '' && conditionTint !== null && (
            <View
              style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                paddingHorizontal: 8,
                paddingVertical: 3,
                backgroundColor: conditionTint.bg,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: conditionTint.fg,
              }}
            >
              <Text
                style={{
                  color: conditionTint.fg,
                  fontSize: 10,
                  fontWeight: '900',
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                {conditionLabel}
              </Text>
            </View>
          )}

          {msrpPercent !== null && (
            <View
              style={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                paddingHorizontal: 8,
                paddingVertical: 3,
                backgroundColor: colors.success,
                borderRadius: 999,
              }}
            >
              <Text
                style={{
                  color: '#000',
                  fontSize: 11,
                  fontWeight: '900',
                  letterSpacing: 0.4,
                }}
              >
                {msrpPercent}% off
              </Text>
            </View>
          )}
        </View>

        <View style={{ padding: 10, gap: 4 }}>
          <Text
            style={{
              color: colors.primary,
              fontSize: 9,
              fontWeight: '900',
              letterSpacing: 0.4,
            }}
          >
            {lotDisplayCode(lot) ?? lot.lot_code}
          </Text>
          <Text
            numberOfLines={2}
            style={{
              color: colors.text,
              fontSize: 13,
              fontWeight: '700',
              minHeight: 32,
            }}
          >
            {lot.title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 9,
                ...type.label,
              }}
            >
              {priceLabel}
            </Text>
            <Text
              style={{
                color: colors.text,
                fontSize: 16,
                ...type.display,
              }}
            >
              {formatCents(price)}
            </Text>
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

// ── Outer component + memo ────────────────────────────────────────────────────

export type LotCardVariant = 'mac-bid' | 'classic';

/**
 * Opaque string enum tagging the surface a card was rendered on. Forwarded to
 * the lot detail route as a `source` URL param so /lot/[id] can emit the
 * `lot_viewed` PostHog event with the correct origin (browse vs watchlist vs
 * similar etc). Unknown values default to 'browse' at the receiver. Keep
 * synchronized with apps/bidder-app/lib/analytics.ts → LotViewSource.
 */
export type LotCardSource =
  | 'browse'
  | 'scan'
  | 'link'
  | 'watchlist'
  | 'my_bids'
  | 'recent_wins'
  | 'similar'
  | 'unknown';

type LotCardImplProps = {
  lot: LotCardData;
  now: number;
  variant?: LotCardVariant;
  /**
   * Surface tag forwarded into the lot detail route as a `source` URL
   * param. Optional — call sites that don't pass one fall back to the
   * route's 'browse' default. Set this on watchlist/my-bids/similar/
   * recent-wins rails so the funnel can split entry sources.
   */
  source?: LotCardSource;
  /**
   * Render the watchlist heart overlay (z:3) on the photo zone.
   * Default false so existing call sites are unaffected.
   * The app's Browse grid passes true; the web uses its own LotCard
   * component entirely (apps/operator-web/.../LotCard.tsx) and is unaffected.
   */
  showWatchlistHeart?: boolean;
  /**
   * When set, tapping the card calls this instead of navigating to
   * /lot/[id] — the Browse grid uses it to open the vertical swipe pager
   * seeded at this lot. mac-bid variant only (classic keeps the Link).
   */
  onPressOverride?: (lotId: string) => void;
  /**
   * Optional Quick Bid control rendered at the foot of the mac-bid card. The
   * host owns it entirely — placing a bid needs auth, a payment method and the
   * place_bid RPC, none of which belong in a presentational card. Omitted =
   * card renders exactly as before.
   *
   * Return a COMPONENT, not inline JSX driven by parent state. The custom memo
   * comparator below intentionally ignores this prop (it only re-renders on
   * fields the card displays), so a button whose busy/disabled state lives in
   * the parent would render once and then appear frozen. A self-contained
   * component holds its own state and re-renders independently of the card.
   */
  quickBid?: (lot: LotCardData) => ReactNode;
};

function LotCardImpl({ lot, now, variant = 'mac-bid', source, showWatchlistHeart = false, onPressOverride, quickBid }: LotCardImplProps) {
  if (variant === 'classic') {
    return <ClassicCard lot={lot} now={now} source={source} />;
  }
  return (
    <MacBidCard
      lot={lot}
      now={now}
      source={source}
      showWatchlistHeart={showWatchlistHeart}
      onPressOverride={onPressOverride}
      quickBid={quickBid}
    />
  );
}

// Custom comparator — only re-render when something the card actually
// shows has changed. Without this the parent's 1Hz `now` tick would
// rebuild every card on the screen every second.
//
// For mac-bid variant: the segmented countdown needs to re-evaluate every
// second (seconds tick visibly). We allow re-renders on each 1s tick for
// urgent lots and on each 1s tick always (the segmented bar shows seconds
// live). This is deliberate — the CountdownBar shows "04s" live.
export const LotCard = memo(LotCardImpl, (prev, next) => {
  if (prev.lot.id !== next.lot.id) return false;
  if (prev.lot.close_at !== next.lot.close_at) return false;
  if (prev.lot.current_bid_cents !== next.lot.current_bid_cents) return false;
  if (prev.lot.bid_count !== next.lot.bid_count) return false;
  if (prev.lot.status !== next.lot.status) return false;
  if (prev.variant !== next.variant) return false;
  if (prev.showWatchlistHeart !== next.showWatchlistHeart) return false;

  const variant = next.variant ?? 'mac-bid';

  if (variant === 'classic') {
    // Classic: re-render once a minute for the countdown label.
    if (Math.floor(prev.now / 60_000) !== Math.floor(next.now / 60_000)) return false;
    // Urgent classic lots: re-render every 5s.
    const heat = heatFromCloseAt(next.lot.close_at, next.lot.status);
    if (
      heat === 'urgent' &&
      Math.floor(prev.now / 5_000) !== Math.floor(next.now / 5_000)
    ) {
      return false;
    }
    return true;
  }

  // mac-bid: the segmented bar shows live seconds — re-render every second.
  // Badge re-evaluation happens on the same tick (resolveBadge is cheap).
  if (Math.floor(prev.now / 1_000) !== Math.floor(next.now / 1_000)) return false;

  return true;
});
