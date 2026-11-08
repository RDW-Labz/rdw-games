// CategoryIcon — maps a category SLUG to a small stroke-based SVG glyph
// for the browse chip rails. Brand style: stroke ~1.75, round caps/joins,
// 24x24 viewBox, single color set by the caller (chips pass active/inactive
// text color). Unmapped slugs fall back to the DB emoji so new categories
// degrade gracefully instead of rendering blank.
//
// Top-level slugs (packages/db/migrations/0018_categories.sql +
// 0034_competitor_taxonomy.sql): home-improvement, outdoor-garden,
// kitchen-dining, bath, electronics, furniture, apparel, auto, beauty,
// health, toys-games, sports-fitness, baby-kids, pet-supplies,
// office-school, other-misc, appliances. 'all' is a synthetic slug used by
// the "All" chip (box glyph).

import type { ReactNode } from 'react';
import { Text } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type GlyphName =
  | 'plug'
  | 'sofa'
  | 'wrench'
  | 'pot'
  | 'droplet'
  | 'tree'
  | 'shirt'
  | 'car'
  | 'sparkle'
  | 'heart'
  | 'teddy'
  | 'dumbbell'
  | 'bottle'
  | 'paw'
  | 'briefcase'
  | 'box'
  | 'fridge';

const SLUG_TO_GLYPH: Record<string, GlyphName> = {
  all: 'box',
  electronics: 'plug',
  furniture: 'sofa',
  'home-improvement': 'wrench',
  'kitchen-dining': 'pot',
  bath: 'droplet',
  'outdoor-garden': 'tree',
  apparel: 'shirt',
  auto: 'car',
  beauty: 'sparkle',
  health: 'heart',
  'toys-games': 'teddy',
  'sports-fitness': 'dumbbell',
  'baby-kids': 'bottle',
  'pet-supplies': 'paw',
  'office-school': 'briefcase',
  'other-misc': 'box',
  appliances: 'fridge',
};

function glyphFor(name: GlyphName): ReactNode {
  switch (name) {
    case 'plug':
      return (
        <>
          <Path d="M9 8V3M15 8V3" />
          <Path d="M6 8h12v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
          <Path d="M12 16v5" />
        </>
      );
    case 'sofa':
      return (
        <>
          <Path d="M20 9.5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2.5" />
          <Path d="M2 12a2 2 0 0 1 4 0v1.5h12V12a2 2 0 0 1 4 0v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z" />
          <Path d="M5 18v2M19 18v2" />
        </>
      );
    case 'wrench':
      return (
        <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      );
    case 'pot':
      return (
        <>
          <Path d="M4 10h16" />
          <Path d="M5 10v6.5a3.5 3.5 0 0 0 3.5 3.5h7a3.5 3.5 0 0 0 3.5-3.5V10" />
          <Path d="M9 7V5M12 7V4M15 7V5" />
        </>
      );
    case 'droplet':
      return <Path d="M12 3S6 10 6 14.2A6 6 0 0 0 18 14.2C18 10 12 3 12 3z" />;
    case 'tree':
      return (
        <>
          <Path d="M12 2 7.5 8.5h2.5L6 14.5h4.5L7 20h10l-3.5-5.5H18l-4-6h2.5L12 2z" />
          <Path d="M12 20v2" />
        </>
      );
    case 'shirt':
      return (
        <Path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.17a1 1 0 0 0 .99-.84l.58-3.47A2 2 0 0 0 20.4 3.5z" />
      );
    case 'car':
      return (
        <>
          <Path d="M19 17h2a1 1 0 0 0 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3A2.5 2.5 0 0 0 12 7H5a1.6 1.6 0 0 0-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4a1 1 0 0 0 1 1h2" />
          <Circle cx="7" cy="17" r="2" />
          <Circle cx="17" cy="17" r="2" />
          <Path d="M9 17h6" />
        </>
      );
    case 'sparkle':
      return (
        <>
          <Path d="M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2L12 3z" />
          <Path d="M19 17v4M17 19h4" />
        </>
      );
    case 'heart':
      return (
        <Path d="M19 14c1.5-1.46 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.04 3 5.5l7 6.9 7-6.9z" />
      );
    case 'teddy':
      return (
        <>
          <Circle cx="7" cy="6.5" r="2.5" />
          <Circle cx="17" cy="6.5" r="2.5" />
          <Circle cx="12" cy="13.5" r="7" />
          <Path d="M10 12h.01M14 12h.01" />
          <Path d="M10.5 16.5c.9.7 2.1.7 3 0" />
        </>
      );
    case 'dumbbell':
      return (
        <>
          <Path d="M6.5 6.5 17.5 17.5" />
          <Path d="m21 21-1.5-1.5M4.5 4.5 3 3" />
          <Path d="m18 22 4-4M2 6l4-4" />
          <Path d="m3 10 7-7M14 21l7-7" />
        </>
      );
    case 'bottle':
      return (
        <>
          <Path d="M12 2a2 2 0 0 1 2 2v2h-4V4a2 2 0 0 1 2-2z" />
          <Path d="M10 6h4l1.2 3.2a2 2 0 0 1 .13.7V20a2 2 0 0 1-2 2h-2.66a2 2 0 0 1-2-2V9.9a2 2 0 0 1 .13-.7L10 6z" />
          <Path d="M9 13h6M9 16h6" />
        </>
      );
    case 'paw':
      return (
        <>
          <Circle cx="6" cy="10" r="1.8" />
          <Circle cx="10" cy="6" r="1.8" />
          <Circle cx="14.5" cy="6" r="1.8" />
          <Circle cx="18.5" cy="10" r="1.8" />
          <Path d="M12.3 11.5c-2.6 0-5.2 2.2-5.2 4.7 0 1.9 1.6 3 3.3 3 .7 0 1.3-.2 1.9-.2s1.2.2 1.9.2c1.7 0 3.3-1.1 3.3-3 0-2.5-2.6-4.7-5.2-4.7z" />
        </>
      );
    case 'briefcase':
      return (
        <>
          <Rect x="2.5" y="7" width="19" height="13" rx="2" />
          <Path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
          <Path d="M2.5 12.5h19" />
        </>
      );
    case 'box':
      return (
        <>
          <Path d="M21 16V8l-9-5-9 5v8l9 5 9-5z" />
          <Path d="m3 8 9 5 9-5" />
          <Path d="M12 13v8" />
        </>
      );
    case 'fridge':
      return (
        <>
          <Rect x="6" y="2.5" width="12" height="19" rx="2" />
          <Path d="M6 9.5h12" />
          <Path d="M9 5.5V7M9 12.5v3" />
        </>
      );
  }
}

export function CategoryIcon({
  slug,
  size = 18,
  color,
  emoji,
}: {
  /** Category slug ('all' for the All chip). Unmapped → emoji fallback. */
  slug?: string | null;
  size?: number;
  color: string;
  /** DB emoji fallback rendered when the slug has no glyph mapping. */
  emoji?: string;
}) {
  const glyph = slug ? SLUG_TO_GLYPH[slug] : undefined;
  if (!glyph) {
    return <Text style={{ fontSize: size * 0.85 }}>{emoji ?? '📦'}</Text>;
  }
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyphFor(glyph)}
    </Svg>
  );
}
