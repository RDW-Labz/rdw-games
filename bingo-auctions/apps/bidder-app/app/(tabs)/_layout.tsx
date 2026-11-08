// Bottom-tab navigation for the bidder role.
// (Picker / warehouse-staff users get a different shell — wired in Phase 4.)
//
// Role gate: only users with a `bidders` row land here. Staff
// (operator_users row) are routed to /not-bidder, which mirrors
// field-mobile's /not-staff "wrong app" fallback. Without this gate
// the (tabs) UI rendered for everyone authenticated — RLS hid every
// row from staff so the app looked broken instead of telling them
// they were in the wrong app.
//
// 2026-05-21 (migration 0105): auto-charge policy — saving a card is
// required before place_bid() accepts a bid. That enforcement is
// server-side (returns reason='no_payment_method'). The client-side
// redirect that USED to be here (routing to /profile/payment-method
// before Browse mounted) was removed 2026-05-30 so first-time bidders
// can browse inventory before committing a card. The bid-time
// rejection handler in app/lot/[id].tsx routes to /profile/payment-method
// when place_bid returns 'no_payment_method'. Defense in depth intact.

import { useEffect, useState } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@auction-platform/design-system';
import { useBidderRole, supabase } from '@auction-platform/supabase-client';
import { CustomTabBar } from '../../components/CustomTabBar';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { subscribeUnreadAlerts, refreshUnreadAlerts } from '../../lib/unread-alerts';

export default function TabsLayout() {
  const router = useRouter();
  const role = useBidderRole();
  // Pickup badge — count of paid invoices the bidder hasn't completed yet.
  // CustomTabBar reads `options.tabBarBadge` (passed below) and hides the
  // pill when 0 / undefined. Refetches every time the tab tree mounts so a
  // bidder returning to the app sees the freshest count without a polling
  // loop. The pickup screens themselves refresh via Realtime — this is
  // just the surface.
  const [pickupCount, setPickupCount] = useState<number>(0);
  // Unread-alerts badge on the "Alerts" tab. The count store (lib/unread-
  // alerts) recounts on a 60s poll and clears the instant the Alerts screen
  // marks everything seen, so tapping the tab drops the pill immediately.
  const [unreadAlerts, setUnreadAlerts] = useState<number>(0);

  useEffect(() => {
    if (role.kind === 'unauthenticated') router.replace('/login');
    else if (role.kind === 'staff_in_bidder_app') router.replace('/not-bidder' as never);
    else if (role.kind === 'pending_provision')
      // 2026-05-20: route OAuth bidders (Apple/Google) here. Their auth
      // session exists but they lack a bidders row because the 0082 DOB
      // trigger requires birth_date which OAuth providers don't supply.
      // /complete-profile collects DOB + consents and creates the row;
      // on success it navigates back to (tabs).
      router.replace('/complete-profile' as never);
  }, [role, router]);

  // Active-pickup count: paid invoices whose pickups row (if any) hasn't
  // been finalized. status='completed' = collected; status='no_show' =
  // window closed. Both are NOT active for badging purposes.
  useEffect(() => {
    if (role.kind !== 'bidder') return;
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (cancelled || !u.user) return;
      const { data } = await supabase
        .from('invoices')
        .select('id, pickups(status)')
        .eq('bidder_id', u.user.id)
        .eq('status', 'paid');
      if (cancelled) return;
      const rows = (data ?? []) as Array<{
        id: string;
        pickups: Array<{ status: string | null }> | { status: string | null } | null;
      }>;
      const active = rows.filter((r) => {
        // pickups is a to-one embed (unique on invoice_id) → object, not
        // array. Normalize both shapes (matches my-bids/queue) so a completed
        // pickup stops counting toward the active-pickup tab badge.
        const ps = (Array.isArray(r.pickups) ? r.pickups[0] : r.pickups)?.status ?? null;
        return ps !== 'completed' && ps !== 'no_show';
      }).length;
      setPickupCount(active);
    })();
    return () => {
      cancelled = true;
    };
  }, [role.kind]);

  // Unread-alerts subscription + 60s refresh (mirrors the pickup cadence).
  useEffect(() => {
    if (role.kind !== 'bidder') return;
    const unsub = subscribeUnreadAlerts(setUnreadAlerts);
    void refreshUnreadAlerts();
    const t = setInterval(() => {
      void refreshUnreadAlerts();
    }, 60 * 1000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [role.kind]);

  if (role.kind === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color="#4f8cff" />
      </View>
    );
  }

  if (role.kind !== 'bidder') {
    // Effect above routes us; render nothing in the meantime.
    return null;
  }

  return (
    // CustomTabBar replaces the stock iOS tab bar (user feedback
    // 2026-05-24: "the basic ass little triangle tabs on the ios app").
    // It reads tabBarButtonTestID + tabBarBadge + title/tabBarLabel off
    // of each Tabs.Screen's options, so the tab definitions below stay
    // intact — only the rendered chrome changes.
    //
    // ErrorBoundary wraps the whole <Tabs> tree so a render-time
    // exception in ANY tab's default export (or any descendant) lands
    // on the fallback UI with the error.message in a copyable TextInput.
    // Without this, a throw in profile.tsx (or stats.tsx, etc.) takes
    // down the JS bundle silently — which is exactly what's happening
    // on the 2026-05-24 TestFlight build per the user's "3 things that
    // insta crash" report.
    <ErrorBoundary label="Tabs">
      <Tabs
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: '#e8eaf0',
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Browse', tabBarButtonTestID: 'tab-browse' }} />
        <Tabs.Screen name="watchlist" options={{ title: 'Watchlist', tabBarButtonTestID: 'tab-watchlist' }} />
        <Tabs.Screen name="my-bids" options={{ title: 'My bids', tabBarButtonTestID: 'tab-my-bids' }} />
        <Tabs.Screen
          name="notifications"
          options={{
            title: 'Alerts',
            tabBarButtonTestID: 'tab-notifications',
            // Unread pill; capped at 9+ so a big backlog doesn't overflow
            // the badge. Clears when the bidder opens this tab.
            tabBarBadge:
              unreadAlerts > 0 ? (unreadAlerts > 9 ? '9+' : unreadAlerts) : undefined,
          }}
        />
        <Tabs.Screen name="scan" options={{ title: 'Scan', tabBarButtonTestID: 'tab-scan' }} />
        <Tabs.Screen
          name="pickup"
          options={{
            title: 'Pickup',
            tabBarButtonTestID: 'tab-pickup',
            // Badge surfaces "you have N pickups to handle" so paid invoices
            // don't sit unnoticed (user report 2026-06-01: bidders missed the
            // pickup tab entirely when no QR / no map rendered).
            tabBarBadge: pickupCount > 0 ? pickupCount : undefined,
          }}
        />
        <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarButtonTestID: 'tab-profile' }} />
      </Tabs>
    </ErrorBoundary>
  );
}
