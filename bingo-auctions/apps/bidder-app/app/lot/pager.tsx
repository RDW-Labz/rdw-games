// Vertical browse pager (2026-07-07) — the "Option C hybrid": tapping a lot
// on the Browse grid opens this full-screen vertical pager seeded at that
// lot. Swipe up/down = next/previous lot in the SAME filtered, sorted list
// the customer was scrolling; photos swipe horizontally inside each page;
// "Bid & details" pushes the full /lot/[id] screen (all bidding logic stays
// there — back returns here at the same position).
//
// The lot list arrives via the lib/browse-pager module singleton (set by the
// grid right before navigation), not route params — it can be hundreds of
// ids. Cold-opening this route without context just bounces back to Browse.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Share,
  PanResponder,
  useWindowDimensions,
  type ViewToken,
} from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { formatCents } from '@auction-platform/shared';
import {
  PhotoCarousel,
  WatchlistToggle,
} from '@auction-platform/domain-bidding';
import { getPagerContext, type PagerLot } from '../../lib/browse-pager';

// ── Countdown label ───────────────────────────────────────────────────────────

function countdownLabel(closeAt: string | null, nowMs: number): string {
  if (!closeAt) return '';
  const ms = new Date(closeAt).getTime() - nowMs;
  if (ms <= 0) return 'Closing…';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ── One full-screen page ──────────────────────────────────────────────────────

function PagerPage({
  lot,
  index,
  total,
  pageHeight,
  topInset,
  bottomInset,
  now,
  onOpenLot,
}: {
  lot: PagerLot;
  index: number;
  total: number;
  pageHeight: number;
  topInset: number;
  bottomInset: number;
  now: number;
  onOpenLot: (id: string) => void;
}) {
  const price =
    lot.current_bid_cents !== null ? lot.current_bid_cents : lot.starting_bid_cents;
  const priceLabel = lot.current_bid_cents !== null ? 'CURRENT BID' : 'STARTS AT';
  const closing = countdownLabel(lot.close_at, now);
  const isUrgent =
    lot.close_at !== null &&
    new Date(lot.close_at).getTime() - now <= 5 * 60 * 1000 &&
    new Date(lot.close_at).getTime() > now;

  let msrpPercent: number | null = null;
  if (lot.msrp_cents !== null && lot.msrp_cents > 0 && price < lot.msrp_cents) {
    msrpPercent = Math.floor((1 - price / lot.msrp_cents) * 100);
    if (msrpPercent < 1) msrpPercent = null;
  }

  const CONDITION_LABELS: Record<string, string> = {
    appears_new: 'Appears New',
    open_box: 'Open Box',
    good: 'Good',
    as_is: 'As-Is',
  };
  const conditionLabel = lot.condition ? (CONDITION_LABELS[lot.condition] ?? lot.condition) : null;

  // Share the public lot page via the OS share sheet (customer request
  // 2026-07-08 — no share affordance existed in the pager).
  const onShare = useCallback(() => {
    const url = `https://bingoauctions.com/lot/${lot.lot_code}`;
    void Share.share({ message: `${lot.title} — ${url}`, url }).catch(() => {
      /* user dismissed — not an error */
    });
  }, [lot.lot_code, lot.title]);

  // Horizontal swipe on the info area opens full details — reaching the
  // bottom "Bid & details" button felt slow (customer request 2026-07-08).
  // Scoped to the info region only, so it never fights the PhotoCarousel
  // (which owns horizontal swipes over the image) or the vertical FlatList
  // paging. Claims the gesture only on a clearly horizontal drag, so taps
  // on the buttons below still register.
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) > 60) onOpenLot(lot.id);
        },
      }),
    [lot.id, onOpenLot],
  );

  return (
    <View
      style={{
        height: pageHeight,
        paddingTop: topInset + 8,
        paddingBottom: bottomInset + 12,
        backgroundColor: colors.bg,
      }}
    >
      {/* Photos — horizontal swipe stays inside the carousel; vertical swipes
          on it page lots (FlatList owns the vertical gesture). */}
      <PhotoCarousel photos={lot.photo_urls ?? []} />

      <View
        style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 8 }}
        {...swipe.panHandlers}
      >
        {/* Position + condition row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: colors.textMuted, fontSize: 12, ...type.label }}>
            {index + 1} of {total}
          </Text>
          {conditionLabel && (
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>
                {conditionLabel}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          {/* Share — OS share sheet for the public lot page. */}
          <Pressable
            onPress={onShare}
            hitSlop={8}
            accessibilityLabel="Share this lot"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>↗</Text>
          </Pressable>
          <WatchlistToggle lotId={lot.id} compact />
        </View>

        <Text
          numberOfLines={3}
          style={{ color: colors.text, fontSize: 20, fontWeight: '800', lineHeight: 26 }}
        >
          {lot.title}
        </Text>

        {/* Price + countdown */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 14, marginTop: 4 }}>
          <View>
            <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
              {priceLabel}
            </Text>
            <Text style={{ color: colors.text, fontSize: 28, fontWeight: '900' }}>
              {formatCents(price)}
            </Text>
          </View>
          <View style={{ paddingBottom: 3 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
              {lot.bid_count ?? 0} bid{(lot.bid_count ?? 0) === 1 ? '' : 's'}
            </Text>
            {closing !== '' && (
              <Text
                style={{
                  color: isUrgent ? colors.danger : colors.textMuted,
                  fontSize: 13,
                  fontWeight: '700',
                }}
              >
                {closing}
              </Text>
            )}
          </View>
          {msrpPercent !== null && (
            <View style={{ paddingBottom: 3, marginLeft: 'auto' }}>
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '800' }}>
                -{msrpPercent}% vs retail
              </Text>
            </View>
          )}
        </View>

        <View style={{ flex: 1 }} />

        {/* Bid & details — all bidding logic lives on /lot/[id]; back
            returns here at the same position (this screen stays mounted). */}
        <Pressable
          testID={`pager-open-lot-${lot.lot_code}`}
          onPress={() => onOpenLot(lot.id)}
          style={{
            backgroundColor: colors.primary,
            borderRadius: 12,
            paddingVertical: 14,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#0b0d12', fontSize: 16, fontWeight: '900' }}>
            Bid &amp; details →
          </Text>
        </Pressable>

        <Text style={{ color: colors.textMuted, fontSize: 11, textAlign: 'center' }}>
          Swipe ↑ for the next lot · swipe ← or → here for details
        </Text>
      </View>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function BrowsePagerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: pageHeight } = useWindowDimensions();

  // Snapshot the context once — the grid rewrites it before every open.
  const ctx = useMemo(() => getPagerContext(), []);
  const [lots, setLots] = useState<PagerLot[]>(ctx?.lots ?? []);

  // 1s tick for countdowns (single timer for the whole pager).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Refresh the visible lot's live numbers (bid, count, close_at for
  // anti-snipe extensions) as the customer lands on it. One tiny query per
  // page-turn; no realtime subscription needed at this fidelity.
  const refreshedAt = useRef(new Map<string, number>());
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const item = viewableItems[0]?.item as PagerLot | undefined;
      if (!item) return;
      const last = refreshedAt.current.get(item.id) ?? 0;
      if (Date.now() - last < 5000) return;
      refreshedAt.current.set(item.id, Date.now());
      void (async () => {
        const { data } = await supabase
          .from('lots')
          .select('id, current_bid_cents, bid_count, close_at, status')
          .eq('id', item.id)
          .maybeSingle();
        const fresh = data as {
          id: string;
          current_bid_cents: number | null;
          bid_count: number | null;
          close_at: string;
          status: string | null;
        } | null;
        if (!fresh) return;
        setLots((prev) =>
          prev.map((l) =>
            l.id === fresh.id
              ? {
                  ...l,
                  current_bid_cents: fresh.current_bid_cents,
                  bid_count: fresh.bid_count ?? l.bid_count,
                  close_at: fresh.close_at,
                  status: fresh.status ?? l.status,
                }
              : l,
          ),
        );
      })();
    },
  );

  const onOpenLot = useCallback(
    (id: string) => {
      router.push({ pathname: '/lot/[id]', params: { id, source: 'browse' } });
    },
    [router],
  );

  if (!ctx || ctx.lots.length === 0) {
    // Cold deep-link / stale state — nothing to page through.
    return <Redirect href="/(tabs)" />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ headerShown: false }} />

      <FlatList
        data={lots}
        keyExtractor={(l) => l.id}
        renderItem={({ item, index }) => (
          <PagerPage
            lot={item}
            index={index}
            total={lots.length}
            pageHeight={pageHeight}
            topInset={insets.top}
            bottomInset={insets.bottom}
            now={now}
            onOpenLot={onOpenLot}
          />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        initialScrollIndex={Math.min(ctx.startIndex, lots.length - 1)}
        getItemLayout={(_, index) => ({
          length: pageHeight,
          offset: pageHeight * index,
          index,
        })}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        onViewableItemsChanged={onViewableItemsChanged.current}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        ListFooterComponent={
          ctx.hasMore ? (
            <View
              style={{
                height: pageHeight,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 24,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>
                That&apos;s everything loaded so far
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center' }}>
                Head back to the list to load more lots, then dive in again.
              </Text>
              <Pressable
                onPress={() => router.back()}
                style={{
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 28,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>
                  Back to the list
                </Text>
              </Pressable>
            </View>
          ) : null
        }
      />

      {/* Close — floats over the first page's photo. */}
      <Pressable
        testID="pager-close"
        onPress={() => router.back()}
        hitSlop={10}
        style={{
          position: 'absolute',
          top: insets.top + 10,
          right: 14,
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: 'rgba(11,13,18,0.65)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800' }}>✕</Text>
      </Pressable>
    </View>
  );
}
