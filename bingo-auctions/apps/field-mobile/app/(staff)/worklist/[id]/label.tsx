// /inventory/[id]/label — printable label view for one lot.
//
// Big QR + lot_code + title on a white background, sized for ~62mm
// thermal label width. Operator screenshots this and either:
//   - Shows the screen to a coworker who scans it at intake
//   - Prints via OS share sheet to a Bluetooth thermal printer
//   - AirDrops the screenshot to a Mac for proper label printing
//
// Future commit: expo-print + native print API for one-click thermal
// output. Out of scope for this round.

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { LotQRCard } from '@/features/lotting/LotQRCard';

type Lot = {
  lot_code: string;
  title: string;
  source: string | null;
};

export default function LotLabel() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useOperatorRole();

  const [lot, setLot] = useState<Lot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || role.kind !== 'staff') return;
    let cancelled = false;
    (async () => {
      const { data, error: e } = await supabase
        .from('lots')
        .select('lot_code, title, source')
        .eq('id', id)
        .eq('operator_id', role.operatorId)
        .is('deleted_at', null)
        .maybeSingle();
      if (cancelled) return;
      if (e) {
        setError(e.message);
        return;
      }
      if (!data) {
        setError('Lot not found');
        return;
      }
      setLot(data as Lot);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, role]);

  if (role.kind !== 'staff') return null;

  if (error) {
    return (
      <SafeAreaView style={s.errorScreen}>
        <Text style={{ color: colors.danger, fontWeight: '800' }}>{error}</Text>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!lot) {
    return (
      <SafeAreaView style={s.loadingScreen}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Label · {lot.lot_code}</Text>
        <Pressable onPress={() => router.back()} style={s.headerCloseBtn} hitSlop={12}>
          <Text style={s.headerCloseText}>Done</Text>
        </Pressable>
      </View>

      {/* White card-on-dark — screenshot the rectangle and print. */}
      <View style={s.center}>
        <LotQRCard
          lotCode={lot.lot_code}
          title={lot.title}
          source={lot.source ?? undefined}
          variant="label"
        />
        <Text style={s.tip}>
          Screenshot to AirPrint, share to a Bluetooth thermal printer,
          or hand the phone to the picker for a quick scan.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    color: colors.primary,
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '900',
  },
  headerCloseBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerCloseText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 },
  tip: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 18,
  },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  errorScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, gap: 16, padding: 24 },
  backBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.primary}55`,
  },
});
