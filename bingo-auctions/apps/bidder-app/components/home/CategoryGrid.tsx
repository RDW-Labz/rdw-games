// CategoryGrid — 2-col (phone) / 4-col (iPad) CDN image card grid.
//
// Ported from the `CategoryGrid` function in:
//   apps/operator-web/src/app/(public)/page.tsx (lines 198-309)
//
// Each card is a CDN image with:
//   • Preferred: `image_url_clean` (no baked-in label) — we render the name ourselves
//   • Fallback:  `image_url` (label baked in by CDN pipeline)
//   • Last resort: CDN no-photo placeholder
//
// A dark gradient covers the bottom 40% so the white label is always
// legible over any photo content.
//
// Tapping a card calls `onCategoryPress(category.id)` which the parent
// (index.tsx) uses to set `categoryFilter`.

import { useWindowDimensions, View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useCategories, type CategoryRow } from '@auction-platform/domain-bidding';
import { colors } from '@auction-platform/design-system';

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

// Photographic tiles (2026-07-03): cards load the self-hosted category photos
// the web homepage uses — slug-keyed under {origin}/art/photo/categories/.
// Same env convention as payment-method.tsx.
const WEB_ORIGIN = (
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_OPERATOR_WEB_URL) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CategoryGridProps {
  /** Called with the category id when a card is tapped. */
  onCategoryPress: (categoryId: string) => void;
  /** Currently active category filter — card is highlighted when matched. */
  activeCategoryId: string | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CategoryGrid({ onCategoryPress, activeCategoryId }: CategoryGridProps) {
  const { width } = useWindowDimensions();
  const categories = useCategories();

  if (!categories || categories.topLevel.length === 0) return null;

  // 2 columns on phone, 4 on iPad
  const isTablet = width >= 768;
  const numColumns = isTablet ? 4 : 2;
  const gap = 10;
  const sidePadding = 12;
  // Card width accounts for side padding + gaps between columns
  const cardWidth = (width - sidePadding * 2 - gap * (numColumns - 1)) / numColumns;
  // 4:3 card aspect ratio — same as web
  const cardHeight = (cardWidth * 3) / 4;

  // Cap at 16, matching the web page
  const visibleCategories = categories.topLevel.slice(0, 16);

  // Build rows for the grid
  const rows = buildRows(visibleCategories, numColumns);

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.heading}>Shop by category</Text>
      </View>

      <View style={[styles.grid, { paddingHorizontal: sidePadding }]}>
        {rows.map((row, rowIdx) => (
          <View
            key={rowIdx}
            style={[styles.row, rowIdx < rows.length - 1 && { marginBottom: gap }]}
          >
            {row.map((cat, colIdx) => (
              <CategoryCard
                key={cat.id}
                category={cat}
                width={cardWidth}
                height={cardHeight}
                isActive={activeCategoryId === cat.id}
                onPress={() => onCategoryPress(cat.id)}
                style={colIdx < row.length - 1 ? { marginRight: gap } : undefined}
              />
            ))}
            {/* Fill empty cells in the last row so layout doesn't stretch */}
            {row.length < numColumns &&
              Array.from({ length: numColumns - row.length }).map((_, i) => (
                <View key={`empty-${i}`} style={{ width: cardWidth }} />
              ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// ── CategoryCard ─────────────────────────────────────────────────────────────

interface CategoryCardProps {
  category: CategoryRow;
  width: number;
  height: number;
  isActive: boolean;
  onPress: () => void;
  style?: object;
}

function CategoryCard({
  category,
  width,
  height,
  isActive,
  onPress,
  style,
}: CategoryCardProps) {
  // Self-hosted photographic tile, slug-keyed — the same set the web homepage
  // shows (generated 2026-07-03, served from our origin under /art/photo).
  // Falls back to a DB image outside the legacy CDN, then to the clean navy tile.
  const slug = (category as unknown as { slug?: string }).slug ?? null;
  const rawImg =
    category.image_url_clean ?? (category as unknown as { image_url?: string }).image_url ?? null;
  const dbImg = rawImg && !rawImg.includes('clovrbid') ? rawImg : null;
  const imageSource = slug ? `${WEB_ORIGIN}/art/photo/categories/${slug}.webp` : dbImg;
  const hasImage = imageSource != null;

  // Gradient covers bottom 40% — makes label legible over any photo
  const gradientColors = ['rgba(10,12,17,0.05)', 'rgba(10,12,17,0.80)'];
  const gradientStart = { x: 0, y: 0.6 };
  const gradientEnd = { x: 0, y: 1.0 };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { width, height },
        isActive && styles.cardActive,
        pressed && styles.cardPressed,
        style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={category.name}
      accessibilityState={{ selected: isActive }}
    >
      {hasImage ? (
        <>
          <Image
            source={imageSource}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition="center"
            cachePolicy="memory-disk"
            accessibilityLabel={category.name}
          />

          {/* Bottom gradient for label legibility over the photo */}
          {LinearGradient != null ? (
            <LinearGradient
              colors={gradientColors}
              start={gradientStart}
              end={gradientEnd}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.cardOverlayFallback]} pointerEvents="none" />
          )}

          {/* Category label over the photo */}
          <Text style={styles.cardLabel} numberOfLines={2}>
            {category.name}
          </Text>
        </>
      ) : (
        // Clean navy tile (no image) — label + orange arrow, matching the web.
        <View style={styles.cardEmpty}>
          <Text style={styles.cardEmptyLabel} numberOfLines={2}>
            {category.name}
          </Text>
          <Text style={styles.cardEmptyArrow}>→</Text>
        </View>
      )}
    </Pressable>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRows<T>(items: T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }
  return rows;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    paddingTop: 20,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
    color: '#ffffff',
  },
  grid: {
    // Gap is handled per-row via marginBottom to avoid FlatList nesting issues
  },
  row: {
    flexDirection: 'row',
  },
  card: {
    overflow: 'hidden',
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cardEmpty: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  cardEmptyLabel: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: -0.2,
  },
  cardEmptyArrow: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: '900',
    alignSelf: 'flex-end',
  },
  cardActive: {
    borderColor: '#5FE065',
    borderWidth: 2,
  },
  cardPressed: {
    opacity: 0.88,
  },
  cardOverlayFallback: {
    // Simulate bottom-heavy gradient with a simple overlay when expo-linear-gradient is absent
    backgroundColor: 'rgba(10,12,17,0.35)',
  },
  cardLabel: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.2,
    lineHeight: 16,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});
