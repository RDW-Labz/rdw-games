// /bins — operator's bin QR codes, ready to scan or print.
//
// Operators testing without thermal labels can keep this view open on
// a tablet during put-away — they walk up to a bin, hold up the
// scanner, scan the QR off the tablet screen, done.
//
// For thermal-label workflows: screenshot each card, send to a
// Bluetooth printer. Future commit can add bulk export to PDF.
//
// Read query is RLS-scoped (bins → warehouse → operator); no manual
// operator_id filter needed.
//
// 0293 / multi-location audit: operator scope is NOT enough once a company has
// more than one building. Before this, Harrison's 518 bins and Dodge City's 30
// came back in one alphabetical list with only a small warehouse label to tell
// them apart — and bin codes look alike across locations (`4-16-02` is plausible
// in both), so it quietly invited put-away into the wrong building. Now scoped
// to the device's active warehouse, and the screen refuses to render an
// un-scoped list at all (RequireWarehouse).

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  SafeAreaView,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { BinQRCard } from '@/features/lotting/BinQRCard';
import { useWarehouse } from '@/features/location/WarehouseContext';
import { RequireWarehouse } from '@/features/location/WarehouseSwitcher';

type BinRow = {
  id: string;
  code: string;
  qr_token: string;
  warehouse: { name: string } | { name: string }[] | null;
};

export default function BinsList() {
  return (
    <RequireWarehouse>
      <BinsListInner />
    </RequireWarehouse>
  );
}

function BinsListInner() {
  const router = useRouter();
  const { warehouse } = useWarehouse();
  const role = useOperatorRole();
  const [bins, setBins] = useState<BinRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (role.kind !== 'staff') return;
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('bins')
        .select('id, code, qr_token, warehouse:warehouses(name)')
        .order('code', { ascending: true });
      // Scope to the active building. RequireWarehouse guarantees a selection
      // whenever the operator has more than one, so the only way this is null
      // is a genuine single-warehouse operator — where the operator-wide query
      // is already correct.
      if (warehouse) q = q.eq('warehouse_id', warehouse.id);
      const { data, error: e } = await q;
      if (cancelled) return;
      if (e) {
        setError(e.message);
        return;
      }
      setBins((data ?? []) as unknown as BinRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [role, warehouse]);

  function warehouseNameOf(b: BinRow): string {
    const w = b.warehouse;
    if (!w) return '';
    if (Array.isArray(w)) return w[0]?.name ?? '';
    return w.name ?? '';
  }

  if (role.kind !== 'staff') return null;

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <View>
          <Text style={s.headerEyebrow}>BINS</Text>
          <Text style={s.headerTitle}>QR codes</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => router.push('/layout/bins/new' as never)}
            style={s.headerAddBtn}
            hitSlop={12}
          >
            <Text style={s.headerAddText}>+ New</Text>
          </Pressable>
          <Pressable onPress={() => router.back()} style={s.headerCloseBtn} hitSlop={12}>
            <Text style={s.headerCloseText}>Done</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <View style={s.centered}>
          <Text style={{ color: colors.danger, fontWeight: '800' }}>{error}</Text>
        </View>
      ) : !bins ? (
        <View style={s.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : bins.length === 0 ? (
        <View style={s.centered}>
          <Text style={{ color: colors.textMuted, textAlign: 'center', maxWidth: 280, fontSize: 13, marginBottom: 16 }}>
            No bins yet. Tap below to generate QR codes for an aisle — a typical
            10-bay aisle takes about 5 seconds.
          </Text>
          <Pressable
            onPress={() => router.push('/layout/bins/new' as never)}
            style={s.emptyAddBtn}
          >
            <Text style={s.emptyAddBtnText}>+ Generate bins</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 32 }}>
          {bins.map((b) => (
            <BinQRCard
              key={b.id}
              binCode={b.code}
              qrToken={b.qr_token}
              warehouseName={warehouseNameOf(b)}
              variant="label"
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerEyebrow: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  headerCloseBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerCloseText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  headerAddBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: 'rgba(255,122,0,0.12)',
  },
  headerAddText: { color: colors.primary, fontSize: 14, fontWeight: '800' },
  emptyAddBtn: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  emptyAddBtnText: { color: '#000', fontSize: 14, fontWeight: '900' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
