// Dev-only floating cost HUD.
//
// Renders a small card at the bottom-right corner of the screen, above the
// safe area, showing:
//   - The most recent AI call: task name + cost + cached/live
//   - Running session total
//
// Mounted in lotting/_layout.tsx so it overlays all lotting screens.
// Only renders when session.showCostHud === true.
//
// Subscribes to lottr-client's cost event stream via a simple callback
// registration. Polls for updates every 750ms as a fallback (the ring
// buffer is in-memory and synchronous — polling is cheap and avoids
// needing a full event-emitter dep).

import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getRecentCosts, type CostEvent } from '@/lib/lottr-client';
import { useLottingSession } from './SessionContext';
import { colors } from '@auction-platform/design-system';

// ── HUD inner content ─────────────────────────────────────────────────────────

function CostHudContent() {
  const insets = useSafeAreaInsets();
  const [events, setEvents] = useState<readonly CostEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Sync immediately, then poll
    setEvents(getRecentCosts());
    intervalRef.current = setInterval(() => {
      setEvents(getRecentCosts());
    }, 750);

    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  const latest = events[0] ?? null;
  const sessionTotal = events.reduce((sum, e) => sum + e.cost_usd, 0);

  function fmt(usd: number): string {
    if (usd === 0) return '$0.000';
    if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`; // sub-milli
    return `$${usd.toFixed(4)}`;
  }

  return (
    <View
      pointerEvents="none"
      style={[
        s.hud,
        {
          bottom: insets.bottom + 12,
          right: insets.right + 10,
        },
      ]}
    >
      {latest ? (
        <>
          <Text style={s.task} numberOfLines={1}>
            {latest.task}
          </Text>
          <Text style={s.cost}>
            {fmt(latest.cost_usd)}{' '}
            <Text style={[s.badge, latest.cached ? s.badgeCached : s.badgeLive]}>
              {latest.cached ? 'cached' : 'live'}
            </Text>
          </Text>
        </>
      ) : (
        <Text style={s.task}>no calls yet</Text>
      )}
      <View style={s.divider} />
      <Text style={s.total}>Session: {fmt(sessionTotal)}</Text>
    </View>
  );
}

// ── Public component — gated on session flag ──────────────────────────────────

export function CostHud() {
  const { session } = useLottingSession();
  if (!session.showCostHud) return null;
  return <CostHudContent />;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  hud: {
    position: 'absolute',
    backgroundColor: 'rgba(10,12,17,0.92)',
    borderWidth: 1,
    borderColor: colors.borderHot,
    borderRadius: 8,
    padding: 8,
    minWidth: 130,
    maxWidth: 170,
    zIndex: 9999,
    // shadow on iOS
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    // elevation on Android
    elevation: 8,
  },
  task: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  cost: {
    color: colors.winning,
    fontSize: 13,
    fontWeight: '900',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  badge: {
    fontSize: 10,
    fontWeight: '700',
  },
  badgeCached: {
    color: colors.textMuted,
  },
  badgeLive: {
    color: colors.primary,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 5,
  },
  total: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
