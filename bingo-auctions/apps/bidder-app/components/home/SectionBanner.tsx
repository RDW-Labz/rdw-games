// SectionBanner — navy CTA band (BinGo).
//
// The original ported design used a full-bleed cdn.clovrbid banner image with
// the headline baked in. BinGo has no CDN, so this renders an on-brand navy
// gradient band, surfaces the headline as real text (from `alt`), and keeps the
// tap-through CTA pill. `mobileSrc` is still accepted so callers are unchanged,
// but it's no longer rendered.

import { View, Text, Pressable, StyleSheet } from 'react-native';

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
  LinearGradient = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SectionBannerProps {
  /** Legacy CDN url — accepted for call-site compatibility, no longer rendered. */
  mobileSrc?: string;
  /** Headline text for the band (was baked into the old banner image). */
  alt: string;
  /** Label text shown on the CTA pill. */
  ctaText: string;
  /** Called when the banner or CTA is pressed. */
  onPress: () => void;
  /** Which side the headline sits on — darkens that side. */
  overlayAlign?: 'left' | 'right';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SectionBanner({
  alt,
  ctaText,
  onPress,
  overlayAlign = 'left',
}: SectionBannerProps) {
  const isRight = overlayAlign === 'right';
  const gradientColors = ['#1f3357', '#15233a', '#15233a'];
  const gradientStart = isRight ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 };
  const gradientEnd = isRight ? { x: 0, y: 0.5 } : { x: 1, y: 0.5 };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.container, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={ctaText}
    >
      {LinearGradient != null ? (
        <LinearGradient
          colors={gradientColors}
          start={gradientStart}
          end={gradientEnd}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.overlayFallback]} pointerEvents="none" />
      )}

      <View style={[styles.body, isRight && styles.bodyRight]}>
        <Text style={styles.title} numberOfLines={2}>
          {alt}
        </Text>
        <View style={styles.ctaPill}>
          <Text style={styles.ctaText}>{ctaText}</Text>
        </View>
      </View>
    </Pressable>
  );
}

// ── CDN URL builder (kept for call-site compatibility; value is ignored) ───────

/** Legacy helper — returns the slug; the band no longer loads a remote image. */
export function sectionBannerMobileSrc(slug: string): string {
  return slug;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 800 / 250,
    overflow: 'hidden',
    backgroundColor: '#15233a',
  },
  pressed: { opacity: 0.92 },
  overlayFallback: { backgroundColor: '#15233a' },
  body: {
    flex: 1,
    padding: 18,
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  bodyRight: { alignItems: 'flex-end' },
  title: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
    maxWidth: '80%',
  },
  ctaPill: {
    backgroundColor: '#f6911e',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  ctaText: {
    color: '#15233a',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.1,
  },
});
