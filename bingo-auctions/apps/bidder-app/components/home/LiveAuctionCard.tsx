import { Pressable, Text, View } from 'react-native';
import { colors, type } from '@auction-platform/design-system';

export type LiveAuctionCardAuction = {
  id: string;
  title: string;
  status: string;
  starts_at: string | null;
  ends_at: string;
  last_lot_ends_at: string | null;
  lot_count: number;
  operators: { business_name: string } | null;
  warehouses: { timezone: string | null } | { timezone: string | null }[] | null;
};

export function LiveAuctionCard({
  auction,
  now,
  isActive,
  onPress,
}: {
  auction: LiveAuctionCardAuction;
  now: number;
  isActive?: boolean;
  onPress: () => void;
}) {
  const closeDate = auction.last_lot_ends_at ?? auction.ends_at;
  const startMs = auction.starts_at ? new Date(auction.starts_at).getTime() : null;
  const closeMs = closeDate ? new Date(closeDate).getTime() : null;
  const isElapsedScheduled = closeMs !== null && closeMs <= now;
  const isLive =
    !isElapsedScheduled &&
    (startMs !== null ? startMs <= now : auction.status === 'live');
  const auctionTzRaw = auction.warehouses;
  const auctionTz: string =
    (Array.isArray(auctionTzRaw)
      ? (auctionTzRaw[0]?.timezone ?? null)
      : (auctionTzRaw?.timezone ?? null)) ?? 'America/Chicago';
  const closeDateShort = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: auctionTz,
  }).format(new Date(closeDate));
  const closeTimeShort = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: auctionTz,
  }).format(new Date(closeDate));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${auction.operators?.business_name ?? ''}: ${auction.title}, ${auction.lot_count} lots, closes ${closeDateShort}`}
      style={{
        width: 200,
        backgroundColor: isActive ? colors.primaryDim : colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: isActive ? colors.primary : colors.border,
        padding: 10,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: isLive
              ? colors.danger
              : isElapsedScheduled
                ? colors.surfaceHi
                : colors.primaryDim,
          }}
        >
          <Text
            style={{
              color: isLive
                ? '#ffffff'
                : isElapsedScheduled
                  ? colors.textMuted
                  : colors.primary,
              fontSize: 9,
              fontWeight: '900',
              letterSpacing: 0.5,
            }}
          >
            {isLive ? 'LIVE' : isElapsedScheduled ? 'ENDED' : 'UPCOMING'}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={{ color: colors.textMuted, fontSize: 10, flex: 1, ...type.label }}
        >
          {auction.operators?.business_name ?? ''}
        </Text>
      </View>

      <Text
        numberOfLines={2}
        style={{ color: colors.text, fontSize: 13, fontWeight: '700', minHeight: 32 }}
      >
        {auction.title}
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <Text style={{ color: colors.textMuted, fontSize: 11 }}>
          {auction.lot_count.toLocaleString()} lots
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 11 }}>·</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11 }}>
          {closeDateShort} {closeTimeShort}
        </Text>
      </View>
    </Pressable>
  );
}
