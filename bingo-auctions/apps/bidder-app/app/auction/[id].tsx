// Auction results — read-only "Recently closed" detail screen.
//
// Why this exists: a closed auction correctly drops out of the live
// "Live auctions" rail (which filters status scheduled/live) and its lots
// are excluded from the browse grid (status in scheduled/live). That left a
// closed auction completely unreachable in the app even though the web side
// ships a "Recently closed" results section. This screen + the new
// "Recently closed" rail on (tabs)/index.tsx close that gap.
//
// It is intentionally read-only: no bidding, no realtime. RLS policy
// auctions_bidder_read_published (0002_rls.sql) lets any signed-in bidder
// SELECT auctions with status='closed', and the lots policy lets them read
// the won/unsold lot rows — so a non-winning bidder can still browse results.
//
// JS-only (no native modules) so it ships as an OTA update.

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, router } from 'expo-router';
import { isLotSold, lotResultLabel, type LotResultLabel } from '@/lib/auction-result-status';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents, lotDisplayCode } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';
import {
  describeWarehousePickup,
  fetchWarehousePickup,
  type WarehousePickupDescribed,
} from '@/lib/warehouse-pickup';

// No-photo placeholder — bundled locally (navy + "No photo"), no remote CDN.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NO_PHOTO = require('../../assets/no-photo.png');

type AuctionResult = {
  id: string;
  title: string;
  status: string;
  ends_at: string | null;
  last_lot_ends_at: string | null;
  operator_id: string;
  warehouse_id: string;
  operators: {
    business_name: string;
    logo_url: string | null;
    brand_color: string | null;
  } | null;
  warehouses: { timezone: string | null } | null;
};

type ResultLot = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  winner_bidder_id: string | null;
  status: string;
};

const DEFAULT_RESULTS_TZ = 'America/Chicago';

// Matches the formatDateTime helper in lot/[id].tsx so the ended date reads
// identically across screens. Formats in the warehouse's IANA timezone.
function formatDateTime(iso: string, timeZone?: string | null): string {
  const tz = timeZone && timeZone.length > 0 ? timeZone : DEFAULT_RESULTS_TZ;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: DEFAULT_RESULTS_TZ,
    }).format(new Date(iso));
  }
}

// ── Sold / Unsold chip ──────────────────────────────────────────────────────
// Sold only when the lot's status is 'won' (lib/auction-result-status);
// a scheduled/live lot reads Open even with a leading pre-bid. Green (success) vs
// muted, matching the platform's "confirmation = green" colour convention.
function ResultChip({ label }: { label: LotResultLabel }) {
  const sold = label === 'Sold';
  return (
    <View
      style={{
        backgroundColor: sold ? colors.successDim : colors.surfaceHi,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 3,
        borderWidth: 1,
        borderColor: sold ? colors.success : colors.border,
      }}
    >
      <Text
        style={{
          color: sold ? colors.success : colors.textMuted,
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

// ── Lot result row ──────────────────────────────────────────────────────────
// Tapping navigates to the existing lot detail screen, which already renders
// closed lots (its "Result" countdown branch handles heat === 'closed').
function ResultRow({ lot }: { lot: ResultLot }) {
  const photo = lot.photo_urls?.[0] ?? null;
  const label = lotResultLabel(lot);
  const sold = isLotSold(lot);

  return (
    <Pressable
      testID={`auction-result-row-${lot.lot_code}`}
      onPress={() =>
        router.push({ pathname: '/lot/[id]', params: { id: lot.id } })
      }
      accessibilityRole="button"
      accessibilityLabel={`${lot.title}, ${
        sold ? `sold for ${formatCents(lot.current_bid_cents)}` : label === 'Open' ? 'open for bidding' : 'unsold'
      }`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      {/* Photo (or CDN no-photo placeholder) */}
      <Image
        source={photo ? { uri: photo } : NO_PHOTO}
        style={{
          width: 64,
          height: 64,
          borderRadius: 8,
          backgroundColor: colors.surfaceAlt,
        }}
        contentFit="cover"
        transition={120}
      />

      {/* Title + lot code */}
      <View style={{ flex: 1, gap: 2 }}>
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
          style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}
        >
          {lot.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <ResultChip label={label} />
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {sold ? 'Final' : label === 'Open' ? (lot.current_bid_cents != null ? 'Current bid' : 'No bids yet') : 'No bids'}
          </Text>
        </View>
      </View>

      {/* Final price */}
      <Text
        style={{
          color: sold ? colors.text : colors.textMuted,
          fontSize: 16,
          ...type.display,
        }}
      >
        {formatCents(lot.current_bid_cents)}
      </Text>
    </Pressable>
  );
}

export default function AuctionResultsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [auction, setAuction] = useState<AuctionResult | null>(null);
  const [lots, setLots] = useState<ResultLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickupLoc, setPickupLoc] = useState<WarehousePickupDescribed>(() =>
    describeWarehousePickup(null),
  );

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: auctionData } = await supabase
        .from('auctions')
        .select(
          'id, title, status, ends_at, last_lot_ends_at, operator_id, warehouse_id, operators:operators_public(business_name, logo_url, brand_color), warehouses(timezone)',
        )
        .eq('id', id)
        .single();
      if (cancelled) return;
      setAuction((auctionData as unknown as AuctionResult) ?? null);

      const { data: lotData } = await supabase
        .from('lots')
        .select(
          'id, lot_code, sticker_code, display_code, title, photo_urls, current_bid_cents, winner_bidder_id, status',
        )
        .eq('auction_id', id)
        .is('deleted_at', null)
        // L5 (defensive): only show terminal/result + still-live lots — never
        // draft or canceled rows. Matches the bidder-read RLS status set
        // (0002_rls.sql) so this can't hide anything bidders may legitimately
        // see on a results screen.
        .in('status', ['scheduled', 'live', 'won', 'unsold', 'relisted'])
        .order('lot_code');
      if (cancelled) return;
      setLots((lotData as unknown as ResultLot[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const whId = auction?.warehouse_id;
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
  }, [auction?.warehouse_id]);

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
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (!auction) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 8,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
          Results unavailable
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center' }}>
          This auction could not be found, or its results aren&apos;t public.
        </Text>
      </View>
    );
  }

  // last_lot_ends_at is the true window close; fall back to ends_at (the
  // first-lot close) when the auction never set a staggered last-lot time.
  const endedAt = auction.last_lot_ends_at ?? auction.ends_at;
  const soldCount = lots.filter(isLotSold).length;
  // Normalise the warehouses embed (supabase-js may return array or object).
  const warehousesEmbed = auction.warehouses;
  const auctionTz: string | null =
    Array.isArray(warehousesEmbed)
      ? (warehousesEmbed[0]?.timezone ?? null)
      : (warehousesEmbed?.timezone ?? null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}>
        {/* Header — operator chip, results title, ended date */}
        <View style={{ gap: 8 }}>
          {auction.operators && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {auction.operators.logo_url ? (
                <Image
                  source={{ uri: auction.operators.logo_url }}
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                  contentFit="contain"
                />
              ) : (
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    backgroundColor:
                      auction.operators.brand_color ?? colors.surfaceHi,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 12, fontWeight: '900' }}>
                    {auction.operators.business_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <Text
                style={{
                  color: auction.operators.brand_color ?? colors.textMuted,
                  fontSize: 12,
                  ...type.label,
                }}
              >
                {auction.operators.business_name}
              </Text>
            </View>
          )}

          <Text style={{ color: colors.text, fontSize: 24, ...type.display }}>
            Results — {auction.title}
          </Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {endedAt && (
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                Ended {formatDateTime(endedAt, auctionTz)}
              </Text>
            )}
            {lots.length > 0 && (
              <>
                <Text style={{ color: colors.textDim, fontSize: 13 }}>·</Text>
                <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                  {`${soldCount} of ${lots.length} sold`}
                </Text>
              </>
            )}
          </View>
        </View>

        {pickupLoc.isOffsite && (
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.danger,
              backgroundColor: 'rgba(255, 59, 59, 0.08)',
              borderRadius: 12,
              padding: 14,
              gap: 8,
            }}
          >
            {pickupLoc.notice ? (
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800', lineHeight: 22 }}>
                {pickupLoc.notice}
              </Text>
            ) : null}
            {pickupLoc.fullAddress ? (
              <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>
                {pickupLoc.fullAddress}
              </Text>
            ) : null}
            {pickupLoc.directionsUrl ? (
              <Pressable
                onPress={() => void Linking.openURL(pickupLoc.directionsUrl!)}
                accessibilityRole="link"
              >
                <Text style={{ color: colors.cyan, fontSize: 14, fontWeight: '700' }}>
                  Get directions
                </Text>
              </Pressable>
            ) : null}
            {pickupLoc.hoursLines.length > 0 ? (
              <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>Pickup hours: </Text>
                {pickupLoc.hoursLines.join(' · ')}
              </Text>
            ) : null}
            {pickupLoc.instructions ? (
              <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
                {pickupLoc.instructions}
              </Text>
            ) : null}
          </View>
        )}

        {/* Lot results list */}
        {lots.length === 0 ? (
          <View style={{ paddingVertical: 32, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center' }}>
              No lots to show for this auction.
            </Text>
          </View>
        ) : (
          lots.map((lot) => <ResultRow key={lot.id} lot={lot} />)
        )}
      </ScrollView>
    </View>
  );
}
