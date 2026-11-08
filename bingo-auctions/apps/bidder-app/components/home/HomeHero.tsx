// requires: npx expo install expo-linear-gradient
//
// HomeHero — full-bleed CDN banner with dark gradient overlay + headline.
//
// Ported from apps/operator-web/src/app/(public)/_components/HomeHero.tsx.
// The web "How it works | Get the app" strip is omitted — this IS the app.
//
// Aspect ratio:
//   Phone  — 16:9 (matches landscape hero crop)
//   iPad   — 21:9 (wider panoramic feel on large canvas)
//
// 2026-05-30: CTA button removed. The hero now lives in HomeTabFooter
// (below the lot grid), so a "Browse Auctions" button in the footer
// would navigate the user BACK UP to content they already scrolled past.
// The hero is branding/social-proof only in this position.
//
// LinearGradient: left-to-right darkening so headline text on the left
// stays legible over any photo content.

import { useWindowDimensions, View, Text, StyleSheet } from 'react-native';

let LinearGradient: React.ComponentType<{
  colors: string[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: object;
}> | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LinearGradient = require('expo-linear-gradient').LinearGradient;
} catch {
  // expo-linear-gradient not installed — fallback to solid overlay View
  LinearGradient = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HomeHeroProps {
  title?: string;
  subtitle?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HomeHero({
  title = 'Better Deals. Better Bids.',
  subtitle = 'Online auctions, run by the people who run them.',
}: HomeHeroProps) {
  const { width } = useWindowDimensions();

  // Hero is now a compact branding band in the footer (below the lot grid).
  // Reduced from 9/16 (full-viewport) to a fixed slim height — enough for
  // headline + subtitle, not enough to feel like an interstitial.
  const heroHeight = width >= 768 ? 160 : 130;

  // BinGo navy brand band — no remote image; subtle left-to-right depth.
  const overlayColors = ['#1f3357', '#15233a', '#15233a'];

  return (
    <View style={[styles.container, { height: heroHeight }]}>
      {/* BinGo navy brand gradient background */}
      {LinearGradient != null ? (
        <LinearGradient
          colors={overlayColors}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        // Fallback when expo-linear-gradient is not installed
        <View
          style={[StyleSheet.absoluteFill, styles.overlayFallback]}
          pointerEvents="none"
        />
      )}

      {/* Text block */}
      <View style={styles.textBlock}>
        <Text style={styles.title} numberOfLines={3} adjustsFontSizeToFit>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={3}>
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#15233a',
    justifyContent: 'center',
  },
  overlayFallback: {
    backgroundColor: '#15233a',
  },
  textBlock: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    maxWidth: 420,
    zIndex: 1,
  },
  title: {
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -1,
    lineHeight: 34,
    color: '#ffffff',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.82)',
    marginBottom: 20,
  },
});
