// Lotting sub-stack layout.
//
// C1 NOTE: As of the C1 commit, both <LottingSessionProvider> and the
// <CostHud> overlay are mounted at the (staff) layout level — one level
// higher — so every staff screen (lotting, inventory, picker, layout)
// shares the same session state and HUD overlay. This layout used to
// own those wrappers; they were hoisted up to fix the /inventory crash
// (R5 hotfix) and to make the HUD visible on screens that incur AI
// costs but aren't under /lotting (intake, batch put-away).
//
// The Stack here still exists to give /lotting/{scan,quick,photo} their
// own modal presentation that doesn't disturb the (staff) root stack.
//
// LottingModeProvider lives at this level so the four entry screens
// (quick, photo, scan, web) share the operator's Generate-vs-Pre-stickered
// preference across navigation between them. See LottingModeContext.tsx
// for the rationale on session-only persistence.

import { Stack } from 'expo-router';
import { LottingModeProvider } from '@/features/lotting/LottingModeContext';

export default function LottingLayout() {
  return (
    <LottingModeProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0b0d12' },
          headerTintColor: '#e8eaf0',
        }}
      >
        <Stack.Screen name="index" options={{ title: 'LotTR' }} />
        <Stack.Screen
          name="scan"
          options={{ title: 'Scan', presentation: 'fullScreenModal', headerShown: false }}
        />
        <Stack.Screen
          name="quick"
          options={{ title: 'Quick lot', presentation: 'fullScreenModal', headerShown: false }}
        />
        {/* legacy route — photo was folded into scan modal */}
        <Stack.Screen name="photo" options={{ title: 'Photo scan' }} />
        <Stack.Screen
          name="manual"
          options={{ title: 'Manual lot', presentation: 'fullScreenModal', headerShown: false }}
        />
      </Stack>
    </LottingModeProvider>
  );
}
