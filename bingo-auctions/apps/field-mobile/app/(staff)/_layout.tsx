// Staff stack — strictly gated on operator_users. Anyone signed in
// without an operator_users row (a regular bidder who installed the
// wrong app) is bounced to /not-staff.
//
// Routes are kept flat for now. As Phase C (warehouse capture) and
// Phase 3 (LotTR mobile) come online, this becomes a tab navigator
// with picker / lotting / layout / operator sections.

import { useEffect, useRef, useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useOperatorRole } from '@auction-platform/supabase-client';
import { getFreshAccessToken } from '../../lib/fresh-token';
import { View, Text, ActivityIndicator, Modal, Pressable } from 'react-native';
import { useShareIntent } from 'expo-share-intent';
import { colors } from '@auction-platform/design-system';
import { handleShareIntent } from '@/features/lotting/handleShareIntent';
import { startStickerBindDrain } from '@/features/lotting/stickerBindRunner';

const API_BASE =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com';
// 2026-05-20: expo-updates removed entirely from the Staff app.
// v22-v27 crashed at launch (~284ms after process start) with an unhandled
// Objective-C exception thrown out of EXUpdatesAppController's native init
// on iOS 26 + RN 0.81.5 + New Architecture. Sentry's CPPExceptionTerminate
// was masking it; once Sentry was stripped the bare exception aborted the
// process. Setting `updates.enabled: false` in app.config.ts (v25) did not
// help because the bare `import * as Updates` here still triggered the
// TurboModule registration. The fix is to remove the dependency and the
// import. Staff updates now ship exclusively via fresh EAS builds + TestFlight
// pushes (already the operational reality per the WSL ARM hermesc constraint).
// C1: hoist the lotting session + cost HUD up to (staff) so they're
// available across ALL staff screens. Previously the provider was mounted
// in lotting/_layout, which (a) caused the inventory crash before R5's
// hotfix and (b) hid the cost HUD on every non-lotting screen even
// though those screens DO incur AI costs (intake, batch put-away, etc).
import { LottingSessionProvider } from '@/features/lotting/SessionContext';
import { CostHud } from '@/features/lotting/CostHud';
// #2 (2026-07-21, revised 2026-07-23): per-worker PIN identity layered on top
// of the device's operator_users (station) login. No longer a blocking gate —
// the app opens straight to work; a header button (WorkerHeaderButton) opens the
// clock-in / switch-employee sheet (WorkerSwitcher) from any screen.
import { WorkerProvider } from '@/features/auth/WorkerContext';
import { WorkerSwitcher, WorkerHeaderButton } from '@/features/auth/WorkerSwitcher';
// Multi-location audit (2026-07-27): the app had NO warehouse concept, so bin
// lists silently merged Harrison's bins with Dodge City's. Same shape as the
// worker pill: a header button opens a picker, and the choice is persisted.
import { WarehouseProvider } from '@/features/location/WarehouseContext';
import {
  WarehouseSwitcher,
  WarehouseHeaderButton,
} from '@/features/location/WarehouseSwitcher';

export default function StaffLayout() {
  const router = useRouter();
  const role = useOperatorRole();

  // 2026-05-21: iOS Share Extension — receive URLs shared from
  // Safari/Amazon/eBay/Google. Mount at (staff) so it's only active
  // when role===staff, avoiding the need to duplicate the auth gate.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [scrapeBusy, setScrapeBusy] = useState(false);
  const processingShareRef = useRef(false);

  useEffect(() => {
    if (role.kind === 'unauthenticated') router.replace('/login');
    else if (role.kind === 'not_staff') router.replace('/not-staff');
  }, [role, router]);

  // Stickers that bad wifi kept from attaching after a save (2026-10-08) are
  // retried in the background once a staff session exists; never awaited.
  useEffect(() => {
    if (role.kind === 'staff') startStickerBindDrain();
  }, [role.kind]);

  // 2026-05-21: drain incoming share-extension URLs.
  // hasShareIntent flips true on (a) cold launch from share sheet and
  // (b) warm foreground from share sheet. We snapshot the URL, clear the
  // intent immediately so a re-foreground doesn't replay, and fire the
  // scrape via the pure handleShareIntent helper. On success we push to
  // /lotting/import-review with the scraped payload; on failure we push
  // to /lotting/web with the URL pre-filled + an error banner.
  useEffect(() => {
    if (!hasShareIntent) return;
    const url = shareIntent?.webUrl ?? null;
    if (!url || processingShareRef.current) {
      resetShareIntent();
      return;
    }
    processingShareRef.current = true;
    resetShareIntent();
    void (async () => {
      setScrapeBusy(true);
      try {
        const result = await handleShareIntent({
          url,
          apiBase: API_BASE,
          getToken: () => getFreshAccessToken(),
        });
        if (result.action === 'navigate' || result.action === 'fallback') {
          router.push({ pathname: result.pathname as never, params: result.params });
        }
        // unauthenticated + invalid_url drop silently — the role gate
        // above will route signed-out users to /login on the next render.
        // W2-rest: navigate now points to /lotting/web (not import-review).
      } finally {
        setScrapeBusy(false);
        processingShareRef.current = false;
      }
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent, router]);

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
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </View>
    );
  }

  if (role.kind === 'error') {
    // #770: the role check failed all bounded attempts. The old contract left
    // the app on "Loading…" forever here (fail-open with no prior role to keep),
    // so a phone whose session could not be read had no way back except a
    // force-quit — which repeated the same failure. Show what happened and give
    // staff a Retry action.
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 12,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>
          Can&apos;t reach the server
        </Text>
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 14,
            textAlign: 'center',
            lineHeight: 20,
          }}
        >
          {role.message}
        </Text>
        <Pressable
          onPress={role.retry}
          accessibilityRole="button"
          accessibilityLabel="Retry checking staff access"
          style={{
            backgroundColor: colors.primary,
            borderRadius: 10,
            paddingHorizontal: 20,
            paddingVertical: 12,
            marginTop: 4,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (role.kind !== 'staff') {
    // Effect above will route us; render nothing in the meantime.
    return null;
  }

  return (
    <WarehouseProvider>
    <WorkerProvider>
    <LottingSessionProvider>
    <View style={{ flex: 1 }}>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0b0d12' },
        headerTintColor: '#e8eaf0',
        // Persistent clock-in / switch-employee control on every staff screen.
        headerRight: () => (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <WarehouseHeaderButton />
            <WorkerHeaderButton />
          </View>
        ),
      }}
    >
      <Stack.Screen name="index" options={{ title: 'BinGo Staff' }} />
      <Stack.Screen name="put-away/index" options={{ title: 'Put-away' }} />
      <Stack.Screen name="put-away/single" options={{ title: 'Single' }} />
      <Stack.Screen name="put-away/batch" options={{ title: 'Batch' }} />
      <Stack.Screen
        name="put-away/shelf-scan"
        options={{ title: 'Shelf scan', presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen name="checkout/index" options={{ title: 'Check Out' }} />
      <Stack.Screen name="checkout/pickup-verify" options={{ title: 'Verify Pickup' }} />
      <Stack.Screen name="checkout/stage" options={{ title: 'Stage lot' }} />
      <Stack.Screen name="checkout/queue" options={{ title: 'Queue' }} />
      <Stack.Screen name="layout/index" options={{ title: 'Warehouse layout' }} />
      <Stack.Screen
        name="layout/walk"
        options={{ title: 'Walk warehouse', presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="layout/bin-landmarks"
        options={{ title: 'Bin landmarks' }}
      />
      {/* layout/floorplan-photo and layout/sketch were deleted 2026-05-21
          when the floor-plan model was replaced by walk-and-scan
          (layout/walk above). */}
      <Stack.Screen name="lotting/index" options={{ title: 'LotTR' }} />
      {/* lotting sub-stack now has its own _layout.tsx which handles
          fullScreenModal presentation for scan / quick. The screens
          below are declared here only as fallbacks for deep-link resolution;
          actual presentation options live in lotting/_layout.tsx. */}
      <Stack.Screen name="lotting/scan" options={{ headerShown: false }} />
      <Stack.Screen name="lotting/quick" options={{ headerShown: false }} />
      <Stack.Screen name="lotting/photo" options={{ title: 'Photo scan' }} />
      {/* lotting/import-review deleted in W2-rest — manager review flow
          lives exclusively on operator-web. Share-extension now falls back
          to /lotting/web for all scrape outcomes. */}
      {/* R5: mobile inventory + per-lot edit. Bare Stack.Screen entries
          (no _layout under /inventory) — we want a flat presentation, no
          tabs, and the parent Stack handles the back chrome. */}
      <Stack.Screen name="inventory/index" options={{ title: 'Inventory' }} />
      <Stack.Screen name="inventory/[id]" options={{ title: 'Edit lot' }} />
      <Stack.Screen name="inventory/[id]/label" options={{ title: 'Label' }} />
      {/* Bins QR list — print/scan-ready cards for every bin in the
          operator's warehouses. Used during put-away when physical
          labels haven't been printed yet. */}
      <Stack.Screen name="bins/index" options={{ title: 'Bins' }} />
      <Stack.Screen
        name="bins/new"
        options={{ title: 'New bins', presentation: 'modal' }}
      />
      {/* Bin lookup — READ-ONLY inventory-location search. Scan a bin QR or
          type a bin code → list every lot currently in that bin. */}
      <Stack.Screen name="bins/contents" options={{ title: 'Bin lookup' }} />
      {/* Tester feedback (2026-08-13). Reachable from the home screen; the
          route is flat so a future deep link (e.g. from a TestFlight release
          note) can land on it directly. */}
      <Stack.Screen name="feedback" options={{ title: 'Feedback' }} />
    </Stack>
    {/* C1: Cost HUD overlays every staff screen when the session toggle
        is on. Mounted here at the (staff) level so /inventory, /picker,
        and the home tile all see costs incurred by their AI calls — not
        just the lotting sub-stack. */}
    <CostHud />
    {/* Clock-in / switch-employee sheet — opened by the header button on any
        staff screen (or the home pill). Mounted once here so it overlays the
        whole staff app. */}
    <WorkerSwitcher />
    <WarehouseSwitcher />
    {/* 2026-05-21: Share-extension loading overlay. Shown while the
        scrape RPC is in flight after the user shares a product URL from
        Safari/Amazon/eBay. Auto-dismisses when handleShareIntent returns
        and the router pushes to /lotting/web. */}
    <Modal visible={scrapeBusy} transparent animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator size="large" color={colors.primary} />
        <Text
          style={{
            color: '#fff',
            fontWeight: '700',
            fontSize: 14,
            marginTop: 12,
          }}
        >
          Fetching product data…
        </Text>
      </View>
    </Modal>
    </View>
    </LottingSessionProvider>
    </WorkerProvider>
    </WarehouseProvider>
  );
}
