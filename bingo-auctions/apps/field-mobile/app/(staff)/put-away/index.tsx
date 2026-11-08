// Put-away hub — receiving workflows.
//
// W1 (2026-05-26): renamed from picker/ → put-away/. Bin QR codes tile
// moved out to /layout (warehouse layout owns bin management now).
//
// Tiles:
//   Single   — scan lot label + bin QR → flip to in_inventory
//   Batch    — scan many lots then one bin QR → bulk put-away
//   Shelf    — continuous lot resolution + one bin commit (rewritten in W3)

import { View, Text, ScrollView } from 'react-native';
// expo-updates intentionally removed from field-mobile (see app.config.ts comment
// 2026-05-20). EXUpdatesAppController crashes at native init on iOS 26 + New Arch.
// BUILD_MARKER is now the only version indicator; updateId is no longer shown.
import { type Href } from 'expo-router';
import { colors, type } from '@auction-platform/design-system';
import { HubTile } from '@/components/HubTile';

// Hardcoded "build marker" — bump on every OTA so the operator can
// visually confirm they're on the latest bundle by checking the tiny
// label on the put-away hub. If the marker doesn't match the most-recent
// OTA's commit short-SHA, the device is on a stale bundle and needs
// another force-close + reopen cycle.
const BUILD_MARKER = 'b11-restructure';

const TILES = [
  {
    href: '/put-away/single' as const,
    icon: '📦',
    label: 'Single',
    sub: 'Scan lot label + bin QR → receive one item',
    tone: 'primary' as const,
  },
  {
    href: '/put-away/batch' as const,
    icon: '🗂️',
    label: 'Batch',
    sub: 'Scan cart of lots → scan one bin → commit',
    tone: 'elevated' as const,
  },
  {
    href: '/put-away/shelf-scan' as const,
    icon: '🗄️',
    label: 'Shelf scan',
    sub: 'Continuous lot resolution → one bin commit (W3)',
    tone: 'moat' as const,
  },
] as const;

export default function PutAwayHub() {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 12 }}
    >
      <View style={{ marginBottom: 8 }}>
        <Text style={s.eyebrow}>
          Put-Away &amp; Receiving{'  ·  '}
          <Text style={s.buildMarker}>{BUILD_MARKER}</Text>
        </Text>
        <Text style={s.heroTitle}>Put-away</Text>
        <Text style={s.heroSub}>Receive, bin, and locate inventory. For customer handoff, use Check Out. For bin QR codes, see Warehouse layout.</Text>
      </View>

      {TILES.map((t) => (
        <HubTile
          key={t.href}
          // Cast required until expo-router regenerates typed routes
          // (.expo/types/router.d.ts) — paths are new after W1 rename.
          href={t.href as Href}
          icon={t.icon}
          label={t.label}
          sub={t.sub}
          tone={t.tone}
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
  buildMarker: {
    color: colors.textMuted,
    fontSize: 10,
    letterSpacing: 0,
    fontFamily: 'monospace',
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
