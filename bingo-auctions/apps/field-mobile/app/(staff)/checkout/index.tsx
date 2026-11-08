// Check Out hub — customer-facing handoff workflows.
//
// Tiles:
//   Verify Pickup  — scan bidder QR → confirm identity + lots → hand over
//   Stage          — scan lot label + bin QR → stage for pickup
//   Queue          — view lots still needing to be staged

import { useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { type Href } from 'expo-router';
import { colors, type } from '@auction-platform/design-system';
import { HubTile } from '@/components/HubTile';
import { WarehouseFilterChip } from '@/features/location/WarehouseFilterChip';

const TILES = [
  {
    href: '/checkout/pickup-verify' as const,
    icon: '✅',
    label: 'Verify Pickup',
    sub: 'Scan bidder QR → confirm identity + lots → hand over',
    tone: 'primary' as const,
  },
  {
    href: '/checkout/stage' as const,
    icon: '📦',
    label: 'Stage Lot',
    sub: 'Scan lot label + bin QR → stage for pickup',
    tone: 'elevated' as const,
  },
  {
    href: '/checkout/queue' as const,
    icon: '📋',
    label: 'Staging Queue',
    sub: 'View lots still awaiting staging',
    tone: 'elevated' as const,
  },
] as const;

export default function CheckoutHub() {
  const [warehouseFilterId, setWarehouseFilterId] = useState<string | null>(null);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12 }}
    >
      <View style={{ marginBottom: 8 }}>
        <Text style={s.eyebrow}>Customer Handoff</Text>
        <Text style={s.heroTitle}>Check Out</Text>
        <Text style={s.heroSub}>Verify, stage, and hand over customer lots.</Text>
      </View>

      <WarehouseFilterChip value={warehouseFilterId} onChange={setWarehouseFilterId} />

      {TILES.map((t, idx) => (
        <HubTile
          key={t.href}
          href={t.href as Href}
          icon={t.icon}
          label={t.label}
          sub={t.sub}
          tone={t.tone}
          testID={idx === 0 ? 'checkout-session-row-first' : undefined}
        />
      ))}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

import { StyleSheet } from 'react-native';

const s = StyleSheet.create({
  eyebrow: {
    ...type.label,
    color: colors.primary,
    fontSize: 11,
    letterSpacing: 1.4,
    marginBottom: 6,
  },
  heroTitle: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  heroSub: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 4,
  },
});
