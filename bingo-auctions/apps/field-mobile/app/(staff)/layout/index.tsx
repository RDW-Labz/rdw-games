// Layout capture landing — pick a warehouse to walk + scan or to capture
// per-bin landmark photos.
//
// Post-2026-05-21 rework: the desktop-style "upload a floor plan PNG, drag
// bins onto it" workflow was removed (Modes 1 and 2 from the old Phase C
// plan). Replaced by a walk-and-scan flow that takes the phone as the
// primary input: scan each bin's QR while physically standing at it, and
// the system records walk-mode position (with ARKit later for absolute
// meters; without it, idealized grid from the bin code).
//
// This screen now lists warehouses with:
//   • Walk + scan (the primary action — coming in the next build)
//   • Bin landmark photos (per-bin shelf photos, still useful as ever)

import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

type Warehouse = {
  id: string;
  name: string;
  bin_count: number;
  verified_count: number;
  landmarked_count: number;
};

export default function LayoutHome() {
  const role = useOperatorRole();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (role.kind !== 'staff') return;
    // Fetch warehouses + bin counts. RLS scopes both tables to the
    // operator the user is staff for, so no explicit filter needed.
    const { data: whs } = await supabase
      .from('warehouses')
      .select('id, name')
      .order('name');
    if (!whs) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const ids = whs.map((w) => w.id as string);
    // Migration 0102 added bins.scanned_at; old prod rows have it as NULL.
    // landmark_photo_url is still per-bin from earlier migrations.
    const { data: bins } = await supabase
      .from('bins')
      .select('warehouse_id, landmark_photo_url, scanned_at')
      .in('warehouse_id', ids)
      .is('retired_at', null);
    const counts = new Map<string, { total: number; landmarked: number; verified: number }>();
    for (const b of bins ?? []) {
      const k = b.warehouse_id as string;
      const c = counts.get(k) ?? { total: 0, landmarked: 0, verified: 0 };
      c.total += 1;
      if (b.landmark_photo_url) c.landmarked += 1;
      if (b.scanned_at) c.verified += 1;
      counts.set(k, c);
    }
    setWarehouses(
      whs.map((w) => ({
        id: w.id as string,
        name: w.name as string,
        bin_count: counts.get(w.id as string)?.total ?? 0,
        verified_count: counts.get(w.id as string)?.verified ?? 0,
        landmarked_count: counts.get(w.id as string)?.landmarked ?? 0,
      })),
    );
    setLoading(false);
    setRefreshing(false);
  }, [role]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

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
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 24, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textMuted}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Text
        style={{
          color: colors.primary,
          fontSize: 11,
          ...type.label,
          marginBottom: 4,
        }}
      >
        Warehouse layout
      </Text>
      <Text
        style={{
          color: colors.text,
          fontSize: 26,
          ...type.displayHero,
          marginBottom: 8,
        }}
      >
        Walk the warehouse
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
        Pick a warehouse and physically walk it — scan each bin&apos;s QR
        to confirm it&apos;s placed. Bidders see a clean map generated from
        your bin codes. No floor plans, no dragging.
      </Text>

      {/* W1 follow-up (2026-05-26): Bin QR codes link.
          Plan W1 moved the "Bin QR codes" tile from Put-away hub to
          Layout but didn't add a Layout tile in the same change. This
          card surfaces the existing /layout/bins page (operator-scoped
          list of bin QRs, viewable on-tablet for scan-from-screen). */}
      <Link href={'/layout/bins' as never} asChild>
        <Pressable
          style={{
            marginTop: 8,
            padding: 14,
            borderRadius: 12,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Text style={{ fontSize: 22 }}>🏷️</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>
              Bin QR codes
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
              Scan-from-screen or screenshot for thermal labels
            </Text>
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 18 }}>›</Text>
        </Pressable>
      </Link>

      {warehouses.length === 0 && (
        <View
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.textMuted, lineHeight: 20 }}>
            No warehouses yet. Create one from the operator console first,
            then come back here to walk it.
          </Text>
        </View>
      )}

      {warehouses.map((w) => (
        <View
          key={w.id}
          style={{
            backgroundColor: colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            padding: 14,
            gap: 8,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>
            {w.name}
          </Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 2 }}>
            <Stat label="Bins" value={String(w.bin_count)} />
            <Stat
              label="Walked"
              value={`${w.verified_count} / ${w.bin_count}`}
            />
            <Stat
              label="Photos"
              value={`${w.landmarked_count} / ${w.bin_count}`}
            />
          </View>

          {/* Walk-and-scan — the new primary action. Replaces the old
              "Import floor plan" + "Sketch a new plan" buttons.
              `as any` cast: expo-router's typed-routes manifest is
              generated at build time and doesn't include /layout/walk
              until the next Metro bundle rebuild. Same precedent set
              by /lotting/web (2026-05-21). */}
          <Link
            href={{ pathname: '/layout/walk' as never, params: { warehouseId: w.id } }}
            asChild
          >
            <Pressable
              style={{
                marginTop: 6,
                padding: 12,
                backgroundColor: colors.primary,
                borderRadius: 10,
              }}
            >
              <Text
                style={{
                  color: '#000',
                  textAlign: 'center',
                  ...type.label,
                }}
              >
                {w.verified_count === w.bin_count && w.bin_count > 0
                  ? '✓ Re-walk warehouse'
                  : '🚶 Walk + scan bins'}
              </Text>
            </Pressable>
          </Link>

          {/* Bin landmark photos — still useful as ever. Per-bin shelf
              photos give bidders a recognizable visual on pickup. */}
          <Link
            href={{ pathname: '/layout/bin-landmarks', params: { warehouseId: w.id } }}
            asChild
          >
            <Pressable
              style={{
                padding: 12,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 10,
              }}
            >
              <Text
                style={{
                  color: colors.text,
                  textAlign: 'center',
                  ...type.label,
                }}
              >
                📸 Bin landmark photos
              </Text>
            </Pressable>
          </Link>
        </View>
      ))}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{ color: colors.textMuted, fontSize: 10, ...type.label }}>
        {label}
      </Text>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
        {value}
      </Text>
    </View>
  );
}
