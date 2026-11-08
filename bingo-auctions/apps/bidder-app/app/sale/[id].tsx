import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { BRANDED_BUTTON_GREEN, BrandedButton, colors, type } from '@auction-platform/design-system';
import { fetchOffsiteSales, type OffsiteSaleRow } from '@/lib/offsite-sales';
import { describeWarehousePickup, fetchWarehousePickup } from '@/lib/warehouse-pickup';
import { LiveAuctionCard, type LiveAuctionCardAuction } from '@/components/home/LiveAuctionCard';
import { auctionCardRoute } from '@/lib/auction-result-status';

type AuctionRow = LiveAuctionCardAuction & { operator_id: string };

export default function OffsiteSaleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const warehouseId = typeof id === 'string' ? id : '';

  const [loading, setLoading] = useState(true);
  const [sale, setSale] = useState<OffsiteSaleRow | null>(null);
  const [pickupFallback, setPickupFallback] = useState<ReturnType<typeof describeWarehousePickup> | null>(
    null,
  );
  const [auctions, setAuctions] = useState<AuctionRow[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!warehouseId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const sales = await fetchOffsiteSales(supabase);
    const match = sales.find((s) => s.warehouse_id === warehouseId) ?? null;
    setSale(match);

    if (!match) {
      const pickupRow = await fetchWarehousePickup(supabase, warehouseId);
      const described = describeWarehousePickup(pickupRow);
      if (described.isOffsite && pickupRow?.active !== false) {
        setPickupFallback(described);
      } else {
        setPickupFallback(null);
      }
      setAuctions([]);
      setLoading(false);
      return;
    }

    setPickupFallback(null);

    const { data } = await supabase
      .from('auctions')
      .select(
        'id, title, operator_id, status, starts_at, ends_at, last_lot_ends_at, operators:operators_public(business_name), warehouses(timezone)',
      )
      .eq('warehouse_id', warehouseId)
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false)
      .order('ends_at', { ascending: true });

    const rows = ((data ?? []) as unknown as AuctionRow[]).filter((a) => a.operators != null);
    const auctionIds = rows.map((a) => a.id);
    const countEntries = await Promise.all(
      auctionIds.map(async (aid) => {
        const { count } = await supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .eq('auction_id', aid)
          .in('status', ['scheduled', 'live'])
          .is('deleted_at', null);
        return [aid, count ?? 0] as const;
      }),
    );
    const countMap = new Map(countEntries);
    setAuctions(rows.map((a) => ({ ...a, lot_count: countMap.get(a.id) ?? 0 })));
    setLoading(false);
  }, [warehouseId]);

  useEffect(() => {
    load();
  }, [load]);

  const pickup = sale
    ? describeWarehousePickup(sale)
    : pickupFallback;

  const valid =
    sale != null ||
    (pickupFallback != null && pickupFallback.isOffsite);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!valid || !pickup?.isOffsite) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          padding: 24,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 16, textAlign: 'center' }}>
          This sale has ended.
        </Text>
        <BrandedButton variant="primary" onPress={() => router.back()}>
          Go back
        </BrandedButton>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 16,
          gap: 8,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800' }}>
          {pickup.name ?? 'Sale'}
        </Text>
        {pickup.notice && (
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 21 }}>
            {pickup.notice}
          </Text>
        )}
        {pickup.addressLines.length > 0 &&
          pickup.addressLines.map((line) => (
            <Text key={line} style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20 }}>
              {line}
            </Text>
          ))}
        {pickup.directionsUrl && (
          <Pressable onPress={() => Linking.openURL(pickup.directionsUrl!)} accessibilityRole="link">
            <Text style={{ color: BRANDED_BUTTON_GREEN, fontWeight: '700', fontSize: 14 }}>
              Get directions
            </Text>
          </Pressable>
        )}
        {pickup.hoursLines.length > 0 && (
          <View style={{ marginTop: 4, gap: 2 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>PICKUP HOURS</Text>
            {pickup.hoursLines.map((line) => (
              <Text key={line} style={{ color: colors.text, fontSize: 13 }}>{line}</Text>
            ))}
          </View>
        )}
        {pickup.instructions && (
          <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20, marginTop: 4 }}>
            {pickup.instructions}
          </Text>
        )}
      </View>

      <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>AUCTIONS</Text>

      {auctions.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 14 }}>
          No auctions are open at this location right now.
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {auctions.map((auction) => (
            <LiveAuctionCard
              key={auction.id}
              auction={auction}
              now={now}
              onPress={() => router.push(auctionCardRoute(auction) as never)}
            />
          ))}
        </ScrollView>
      )}
    </ScrollView>
  );
}
