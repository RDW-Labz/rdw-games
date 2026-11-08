// CustomTabBar — branded bottom-tab bar for the bidder app.
//
// Replaces Expo Router's stock iOS tab bar (the "basic ass little triangle
// tabs" the user flagged 2026-05-24). The stock bar uses tiny icons, a
// thin chevron, and the platform-default surface — none of which match
// the v3 dark theme + brand-green accents the rest of the app now uses
// (HomeHero, CategoryGrid, SectionBanner, BrandedButton).
//
// Design (matches POST-V1-PLAN.md "UI polish: tab bar"):
//   - Solid dark surface (#0A0C11 — same as HomeHero background)
//   - 2px brand-green (#5FE065) top border as the visible separator
//   - 28px icons (filled when active, outline when inactive)
//   - Active: brand-green tint + heavier label weight
//   - Inactive: muted neutral tint
//   - Pressed feedback: opacity 0.7
//   - Safe-area bottom padding for iPhone X+ home indicator
//   - Badge passthrough: any tab passing `options.tabBarBadge` (number)
//     renders a brand-green pill at the top-right of the icon
//
// Icons are pure react-native-svg paths (already a project dep at
// 15.12.1 via react-native-qrcode-svg). No new dependency added — keeps
// this change Sprint 1 OTA-able.
//
// testIDs from PR #18 (`tab-browse`, `tab-watchlist`, `tab-my-bids`,
// `tab-scan`, `tab-pickup`, `tab-profile`) are preserved on each
// Pressable so Maestro screenshot flows continue to work.

import { type ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect, Line } from 'react-native-svg';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

// ── Tokens ────────────────────────────────────────────────────────────

const SURFACE = '#0A0C11';      // matches HomeHero / v3 dark theme
const BRAND_GREEN = '#5FE065';  // matches BrandedButton + HomeHero CTA
const TINT_INACTIVE = '#6B7280'; // muted neutral, WCAG-AA on SURFACE
const LABEL_ACTIVE = '#FFFFFF';
const LABEL_INACTIVE = '#9CA3AF';

const ICON_SIZE = 28;
const LABEL_SIZE = 11;
const TOP_BORDER_HEIGHT = 2;
const TAB_VERTICAL_PADDING = 8;

// ── Icon primitives ───────────────────────────────────────────────────
//
// Each tab pairs a "filled" and "outline" icon. We model both via
// react-native-svg paths drawn at 24-unit viewBox; the parent <Svg>
// scales them to ICON_SIZE. Active state passes `fill={color}` to the
// filled variant; inactive uses `stroke={color}` on the outline.

interface IconProps {
  color: string;
  size?: number;
}

// Browse → magnifying glass
function BrowseIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx="11"
        cy="11"
        r="7"
        stroke={color}
        strokeWidth={active ? 2.5 : 2}
        fill={active ? color : 'none'}
        fillOpacity={active ? 0.18 : 0}
      />
      <Line
        x1="16.5"
        y1="16.5"
        x2="21"
        y2="21"
        stroke={color}
        strokeWidth={active ? 2.5 : 2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

// Watchlist → bookmark
function WatchlistIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        fill={active ? color : 'none'}
      />
    </Svg>
  );
}

// My Bids → gavel
function MyBidsIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Hammer head — rotated rectangle */}
      <Rect
        x="2"
        y="8"
        width="10"
        height="4"
        rx="0.5"
        transform="rotate(-45 7 10)"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        fill={active ? color : 'none'}
        fillOpacity={active ? 1 : 0}
      />
      {/* Handle */}
      <Line
        x1="12.5"
        y1="11.5"
        x2="20"
        y2="19"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      {/* Base / sound block */}
      <Rect
        x="14"
        y="19"
        width="8"
        height="2.5"
        rx="0.5"
        stroke={color}
        strokeWidth={2}
        fill={active ? color : 'none'}
        fillOpacity={active ? 1 : 0}
      />
    </Svg>
  );
}

// Scan → QR-code corners
function ScanIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  const sw = active ? 2.5 : 2;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Top-left corner */}
      <Path
        d="M4 9V5a1 1 0 0 1 1-1h4"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Top-right corner */}
      <Path
        d="M15 4h4a1 1 0 0 1 1 1v4"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bottom-right corner */}
      <Path
        d="M20 15v4a1 1 0 0 1-1 1h-4"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bottom-left corner */}
      <Path
        d="M9 20H5a1 1 0 0 1-1-1v-4"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Active state: center scan line */}
      {active && (
        <Line
          x1="4"
          y1="12"
          x2="20"
          y2="12"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
    </Svg>
  );
}

// Notifications → bell
function NotificationsIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Bell body */}
      <Path
        d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        fill={active ? color : 'none'}
        fillOpacity={active ? 0.2 : 0}
      />
      {/* Clapper */}
      <Path
        d="M10 18a2 2 0 0 0 4 0"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

// Pickup → package / box
function PickupIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        fill={active ? color : 'none'}
        fillOpacity={active ? 0.18 : 0}
      />
      <Line
        x1="3"
        y1="7"
        x2="12"
        y2="11"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Line
        x1="21"
        y1="7"
        x2="12"
        y2="11"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Line
        x1="12"
        y1="11"
        x2="12"
        y2="21"
        stroke={color}
        strokeWidth={2}
      />
    </Svg>
  );
}

// Profile → user silhouette
function ProfileIcon({ color, active, size = ICON_SIZE }: IconProps & { active: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx="12"
        cy="8"
        r="4"
        stroke={color}
        strokeWidth={2}
        fill={active ? color : 'none'}
      />
      <Path
        d="M4 21v-1a8 8 0 0 1 16 0v1"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        fill={active ? color : 'none'}
        fillOpacity={active ? 0.5 : 0}
      />
    </Svg>
  );
}

// ── Route → icon map ──────────────────────────────────────────────────
//
// expo-router file-system routes map to navigator route names by file
// name minus extension. The (tabs)/_layout declares: index, watchlist,
// my-bids, scan, pickup, profile.

type TabIcon = ComponentType<IconProps & { active: boolean }>;

const ICON_FOR_ROUTE: Record<string, TabIcon> = {
  index: BrowseIcon,
  watchlist: WatchlistIcon,
  'my-bids': MyBidsIcon,
  notifications: NotificationsIcon,
  scan: ScanIcon,
  pickup: PickupIcon,
  profile: ProfileIcon,
};

// ── Component ─────────────────────────────────────────────────────────

export function CustomTabBar(props: BottomTabBarProps) {
  const { state, descriptors, navigation } = props;
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        // Safe-area inset on iPhone X+ keeps tabs above the home indicator.
        // Add a small minimum so non-notched devices still have breathing
        // room below the labels.
        { paddingBottom: Math.max(insets.bottom, 6) },
      ]}
      accessibilityRole="tablist"
    >
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          // Strict-mode TS treats Record index access as possibly
          // undefined. In practice every route in `state.routes` has a
          // matching descriptor — but we narrow defensively so the
          // tab bar can't crash on a transient mismatch.
          const descriptor = descriptors[route.key];
          if (descriptor == null) return null;
          const { options } = descriptor;
          const isFocused = state.index === index;
          const Icon = ICON_FOR_ROUTE[route.name];
          const color = isFocused ? BRAND_GREEN : TINT_INACTIVE;
          const labelColor = isFocused ? LABEL_ACTIVE : LABEL_INACTIVE;

          // Resolve label exactly the way React Navigation does: prefer
          // tabBarLabel if it's a string, otherwise title, otherwise
          // fall back to the route name.
          const rawLabel =
            typeof options.tabBarLabel === 'string'
              ? options.tabBarLabel
              : typeof options.title === 'string'
                ? options.title
                : route.name;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          const badge = options.tabBarBadge;
          const hasBadge = badge !== undefined && badge !== null && badge !== 0 && badge !== '';

          return (
            <Pressable
              key={route.key}
              testID={options.tabBarButtonTestID}
              accessibilityRole="tab"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? rawLabel}
              onPress={onPress}
              onLongPress={onLongPress}
              style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
            >
              <View style={styles.iconWrap}>
                {Icon != null ? (
                  <Icon color={color} active={isFocused} size={ICON_SIZE} />
                ) : (
                  // Defensive fallback: route added without a matching
                  // icon. Render a neutral dot so the tab still works.
                  <View
                    style={{
                      width: ICON_SIZE,
                      height: ICON_SIZE,
                      borderRadius: ICON_SIZE / 2,
                      backgroundColor: color,
                    }}
                  />
                )}
                {hasBadge && (
                  <View style={styles.badge} accessibilityElementsHidden>
                    <Text style={styles.badgeText} numberOfLines={1}>
                      {String(badge)}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                style={[
                  styles.label,
                  {
                    color: labelColor,
                    fontWeight: isFocused ? '700' : '500',
                  },
                ]}
                numberOfLines={1}
              >
                {rawLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: SURFACE,
    // 2px brand-green separator above the tabs — replaces the stock
    // hairline borderTop the iOS tab bar shows by default.
    borderTopWidth: TOP_BORDER_HEIGHT,
    borderTopColor: BRAND_GREEN,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: TAB_VERTICAL_PADDING,
    // Each tab clears 44pt (icon 28 + label 11 + 8+8 padding ≥ 44) —
    // Apple HIG minimum tap target.
    minHeight: 44,
  },
  tabPressed: {
    opacity: 0.7,
  },
  iconWrap: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  label: {
    fontSize: LABEL_SIZE,
    marginTop: 4,
    letterSpacing: 0.1,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: BRAND_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: SURFACE,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },
});
