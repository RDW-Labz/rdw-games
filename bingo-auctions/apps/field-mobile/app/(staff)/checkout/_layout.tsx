// Checkout sub-stack. Flat stack — no nested tabs.
// Screens: index (hub), pickup-verify, stage, queue, as-listed/[lotId] (tap a
// sold lot to see it read-only exactly as it was listed).
// Presentation mirrors the picker sub-stack pattern.

import { Stack } from 'expo-router';

export default function CheckoutLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0b0d12' },
        headerTintColor: '#e8eaf0',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Check Out' }} />
      <Stack.Screen name="pickup-verify" options={{ title: 'Verify Pickup' }} />
      <Stack.Screen name="stage" options={{ title: 'Stage lot' }} />
      <Stack.Screen name="queue" options={{ title: 'Queue' }} />
      <Stack.Screen name="as-listed/[lotId]" options={{ title: 'As Listed' }} />
    </Stack>
  );
}
