/**
 * RecentWinsRail — horizontal scroll rail of anonymized recent winning invoices.
 *
 * Native port of apps/operator-web/src/app/(public)/_components/RecentWins.tsx.
 *
 * Data source: public.get_recent_wins RPC (migration 0126).
 * The RPC is SECURITY DEFINER and callable with the anon key — mobile MUST
 * NOT hold the service-role key. The privacy contract (no bidder_id, no email,
 * no display_name) is enforced server-side in the SQL function body.
 *
 * Rendering rules:
 *   - Returns null when there are zero qualifying results (never show an
 *     empty section — bad social proof).
 *   - Shows 3 skeleton placeholder cards while the RPC is in flight.
 *   - Cards snap to a 216px interval (200px card + 16px gap).
 *
 * Wiring (Wave 1B merge target — do NOT edit index.tsx from this branch):
 *   In apps/bidder-app/app/(tabs)/index.tsx, inside the ListHeaderComponent,
 *   add after the existing header content:
 *
 *     import { RecentWinsRail } from '@auction-platform/domain-bidding/RecentWinsRail';
 *     // ... inside the header JSX:
 *     <RecentWinsRail />
 *
 *   Wave 1B owns that file; add these two lines during the conflict-merge.
 */

import { useEffect, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { supabase } from '@auction-platform/supabase-client';
import { formatCents } from '@auction-platform/shared';
import { colors } from '@auction-platform/design-system';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape returned by the get_recent_wins RPC.
 *  Column names match the SQL RETURNS TABLE declaration in 0126_get_recent_wins_rpc.sql.
 *  No bidder-identifying fields — enforced server-side. */
export type RecentWin = {
  invoice_id: string;
  representative_title: string;
  representative_photo_url: string | null;
  savings_cents: number;
  lot_count: number;
  paid_at: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CARD_WIDTH = 200;
const CARD_GAP = 16;
/** snapToInterval = card + gap so the list snaps cleanly card-by-card. */
const SNAP_INTERVAL = CARD_WIDTH + CARD_GAP;
const SKELETON_COUNT = 3;
const HORIZONTAL_PADDING = 16;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Human-friendly "2h ago" / "3d ago" / "just now" label. Matches the web version. */
function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'recent';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** A single win card rendered inside the horizontal rail. */
function WinCard({ item }: { readonly item: RecentWin }) {
  return (
    <View style={styles.card}>
      {/* Photo — uses expo-image for progressive loading and disk caching */}
      {item.representative_photo_url != null ? (
        <Image
          source={{ uri: item.representative_photo_url }}
          style={styles.cardPhoto}
          contentFit="cover"
          // Low-quality placeholder while image loads — neutral grey
          placeholder={{ blurhash: 'L9AB,s%2~q%M-;WBxuWB4nxuRjay' }}
          transition={200}
          accessibilityLabel={`Photo for ${item.representative_title}`}
        />
      ) : (
        <View style={[styles.cardPhoto, styles.cardPhotoFallback]}>
          <Text style={styles.cardPhotoFallbackIcon} accessibilityElementsHidden>
            🏆
          </Text>
        </View>
      )}

      {/* Content strip */}
      <View style={styles.cardBody}>
        {/* Savings headline */}
        <Text style={styles.savingsLabel} numberOfLines={1}>
          Saved {formatCents(item.savings_cents)}
        </Text>

        {/* Representative lot title */}
        <Text style={styles.titleLabel} numberOfLines={2}>
          {item.representative_title}
        </Text>

        {/* Footer row: lot count + relative time */}
        <View style={styles.cardFooter}>
          <Text style={styles.metaLabel}>
            {item.lot_count === 1 ? '1 lot' : `${item.lot_count} lots`}
          </Text>
          <Text style={styles.metaLabel}>{formatRelativeTime(item.paid_at)}</Text>
        </View>
      </View>
    </View>
  );
}

/** Three grey placeholder cards displayed while the RPC is in flight. */
function SkeletonCard() {
  return (
    <View style={[styles.card, styles.skeletonCard]}>
      <View style={[styles.cardPhoto, styles.skeletonBlock]} />
      <View style={styles.cardBody}>
        <View style={[styles.skeletonLine, { width: '70%' }]} />
        <View style={[styles.skeletonLine, { width: '90%', marginTop: 6 }]} />
        <View style={[styles.skeletonLine, { width: '50%', marginTop: 6 }]} />
      </View>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface RecentWinsRailProps {
  /** How many past days to include. Default 7. Clamped to [1,90] server-side. */
  readonly days?: number;
  /** Max cards to show. Default 10. Clamped to [1,50] server-side. */
  readonly limit?: number;
}

export function RecentWinsRail({ days = 7, limit = 10 }: RecentWinsRailProps) {
  const [wins, setWins] = useState<RecentWin[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchWins(): Promise<void> {
      const { data, error } = await supabase.rpc('get_recent_wins', {
        p_days: days,
        p_limit: limit,
      });

      if (cancelled) return;

      if (error != null || data == null) {
        // Silently hide the rail on any error — never show an error state
        // for a social-proof widget; it's decorative, not functional.
        setWins([]);
        setLoading(false);
        return;
      }

      setWins(data as RecentWin[]);
      setLoading(false);
    }

    void fetchWins();

    return () => {
      cancelled = true;
    };
  }, [days, limit]);

  // Show skeletons while loading so the layout doesn't shift abruptly.
  if (loading) {
    return (
      <View style={styles.section}>
        <SectionHeader />
        <FlatList
          data={Array.from({ length: SKELETON_COUNT }, (_, i) => i)}
          keyExtractor={(i) => String(i)}
          renderItem={() => <SkeletonCard />}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          scrollEnabled={false}
        />
      </View>
    );
  }

  // Zero results → render nothing (matches web behaviour: bad social proof).
  if (wins.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionHeader />
      <FlatList
        data={wins}
        keyExtractor={(item) => item.invoice_id}
        renderItem={({ item }) => <WinCard item={item} />}
        horizontal
        showsHorizontalScrollIndicator={Platform.OS === 'web'}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        snapToInterval={SNAP_INTERVAL}
        snapToAlignment="start"
        decelerationRate="fast"
        // Accessibility: treat the row as a single list so screen readers
        // can enumerate cards without losing context.
        accessibilityRole="list"
        accessibilityLabel="Recent winning bidders"
      />
    </View>
  );
}

/** Section heading + subtitle — extracted to keep the render functions short. */
function SectionHeader() {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Recent wins</Text>
        {/* No "View all" link on mobile — there's no /winners route yet. */}
      </View>
      <Text style={styles.subheading}>Real bidders, real savings — last 7 days.</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Uses design-system tokens — packages/design-system/src/theme.ts is
// React-Native-free (exports only primitive values, no CSS vars).
// The `colors` import is shared with bidder-app's (tabs)/index.tsx and
// field-mobile without issue.
const ACCENT = colors.primary;
const ACCENT_DIM = colors.primaryDim;
const ACCENT_BORDER = colors.border;
const FG = colors.text;
const FG_MUTED = colors.textMuted;
const SKELETON_BG = colors.surfaceAlt;
const CARD_BG = colors.surface;

const styles = StyleSheet.create({
  section: {
    paddingTop: 24,
    paddingBottom: 16,
    // colors.surface gives a subtle tray effect against colors.bg background
    // — the same visual affordance the light-theme '#f9fafb' gave, but in
    // the dark palette.
    backgroundColor: colors.surface,
  },
  header: {
    paddingHorizontal: HORIZONTAL_PADDING,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
    color: FG,
  },
  subheading: {
    marginTop: 2,
    fontSize: 12,
    color: FG_MUTED,
  },
  listContent: {
    paddingHorizontal: HORIZONTAL_PADDING,
  },
  separator: {
    width: CARD_GAP,
  },
  // ── Card ──
  card: {
    width: CARD_WIDTH,
    backgroundColor: CARD_BG,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ACCENT_BORDER,
    overflow: 'hidden',
    // Subtle shadow on iOS; elevation on Android
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
    }),
  },
  cardPhoto: {
    width: CARD_WIDTH,
    height: 100,
    backgroundColor: ACCENT_DIM,
  },
  cardPhotoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardPhotoFallbackIcon: {
    fontSize: 32,
  },
  cardBody: {
    padding: 10,
    gap: 3,
  },
  savingsLabel: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.4,
    color: ACCENT,
  },
  titleLabel: {
    fontSize: 12,
    color: FG_MUTED,
    lineHeight: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  metaLabel: {
    fontSize: 10,
    color: FG_MUTED,
    fontStyle: 'italic',
  },
  // ── Skeleton ──
  skeletonCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: SKELETON_BG,
  },
  skeletonBlock: {
    backgroundColor: SKELETON_BG,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
    backgroundColor: SKELETON_BG,
  },
});
