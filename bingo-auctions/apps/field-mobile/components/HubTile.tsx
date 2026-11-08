// HubTile — polished navigation tile used in the Lotting and Picker hubs.
//
// Layout:
//   [icon bubble]  [label + sub]  [chevron]
//
// Tones:
//   primary  — filled primary (orange) background; dark-on-light text.
//   elevated — surfaceAlt background with primary-colored icon bubble.
//   moat     — indigo tint background with indigo icon bubble.

import { type ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Link, type Href } from 'expo-router';
import { colors } from '@auction-platform/design-system';

// ── Icon rendering ───────────────────────────────────────────────────────────
// IMPORTANT: vector icon fonts (@expo/vector-icons) require font files that
// must be bundled at native-build time. The current TestFlight build (#2) was
// built BEFORE this component existed, so its IPA doesn't carry the Ionicons
// or MaterialCommunityIcons font files. OTA updates can ship JS but cannot
// ship new native assets — vector icons would render as fallback glyphs.
//
// Until the next native build, we use styled emoji which work without fonts.
// The polish (circular bubble, color tones, typography) carries the visual
// upgrade. After build #3 ships, swap IconSpec back to vector icon names.
//
// Spec: a single emoji character. Rendered at size 30 inside the colored bubble.

type IconSpec = string;

type Tone = 'primary' | 'elevated' | 'moat';

interface HubTileProps {
  href: Href;
  icon: IconSpec;
  label: string;
  sub: string;
  tone: Tone;
  testID?: string;
}

// ── Color helpers ────────────────────────────────────────────────────────────

// Primary tone redesign (2026-05-10): the previous "solid orange tile
// with black text" reads as "blacked out" in warehouse lighting —
// the saturation is so high that the eye perceives the dark text as
// holes rather than letters. New design uses a dark tile with an
// orange-tinted background + orange accent stripe (border + icon
// bubble + chevron), keeping the visual prominence without burning
// the operator's eyes. Same pattern as the lotting hub's accent treatment.

function tileBg(tone: Tone): string {
  switch (tone) {
    case 'primary':  return 'rgba(255,122,0,0.10)'; // dark base + light orange wash
    case 'elevated': return colors.surfaceAlt;
    case 'moat':     return 'rgba(99,102,241,0.14)';
  }
}

function tileBorder(tone: Tone): string {
  switch (tone) {
    case 'primary':  return colors.primary;
    case 'elevated': return colors.border;
    case 'moat':     return 'rgba(99,102,241,0.35)';
  }
}

function bubbleBg(tone: Tone): string {
  switch (tone) {
    case 'primary':  return colors.primary; // solid orange bubble keeps the visual focus
    case 'elevated': return colors.primaryDim;
    case 'moat':     return 'rgba(99,102,241,0.2)';
  }
}

function iconColor(tone: Tone): string {
  switch (tone) {
    case 'primary':  return '#000'; // dark icon on orange bubble — high contrast at 28px
    case 'elevated': return colors.primary;
    case 'moat':     return '#a5b4fc';
  }
}

function labelColor(tone: Tone): string {
  switch (tone) {
    case 'primary':  return colors.text;
    case 'elevated': return colors.text;
    case 'moat':     return '#a5b4fc';
  }
}

function subColor(tone: Tone): string {
  switch (tone) {
    case 'primary':  return colors.textMuted;
    case 'elevated': return colors.textMuted;
    case 'moat':     return 'rgba(199,210,254,0.95)';
  }
}

function chevronColor(tone: Tone): string {
  switch (tone) {
    case 'primary':  return colors.primary;
    case 'elevated': return colors.textMuted;
    case 'moat':     return 'rgba(199,210,254,0.6)';
  }
}

// ── Icon renderer ────────────────────────────────────────────────────────────

function IconRenderer({ spec }: { spec: IconSpec; color: string }): ReactNode {
  // Emoji renders without needing a font file. The 'color' prop is ignored
  // (emoji are colored by the OS), but we keep the prop for API parity with
  // the future vector-icon implementation post-build #3.
  return <Text style={s.iconEmoji}>{spec}</Text>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function HubTile({ href, icon, label, sub, tone, testID }: HubTileProps) {
  return (
    <Link href={href} asChild>
      <Pressable
        testID={testID}
        style={({ pressed }) => [
          s.tile,
          {
            backgroundColor: tileBg(tone),
            borderColor: tileBorder(tone),
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        {/* Icon bubble */}
        <View style={[s.bubble, { backgroundColor: bubbleBg(tone) }]}>
          <IconRenderer spec={icon} color={iconColor(tone)} />
        </View>

        {/* Label area */}
        <View style={s.labelArea}>
          <Text style={[s.label, { color: labelColor(tone) }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={[s.sub, { color: subColor(tone) }]} numberOfLines={2}>
            {sub}
          </Text>
        </View>

        {/* Chevron — use a text arrow until vector fonts are in the IPA */}
        <Text style={[s.chevron, { color: chevronColor(tone) }]}>›</Text>
      </Pressable>
    </Link>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 80,
  },
  bubble: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  labelArea: {
    flex: 1,
    gap: 3,
  },
  label: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 12,
    lineHeight: 16,
  },
  iconEmoji: {
    fontSize: 28,
    lineHeight: 32,
    textAlign: 'center',
  },
  chevron: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
    paddingLeft: 4,
  },
});
