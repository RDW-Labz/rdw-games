// useCameraGate — global "may the camera run at all?" gate (recap 2026-07-08:
// iPads die in under an hour while lotting).
//
// Two silent battery drains this closes:
//   1. expo-router keeps stack screens MOUNTED behind pushed routes. A scanner
//      screen's `isActive={!busy}` camera kept the AVCaptureSession hot while
//      staff worked a lot-detail screen on top of it.
//   2. Backgrounding the app (or locking the iPad mid-shift) left our
//      isActive true; on wake the session re-engaged instantly and kept
//      burning even face-down on a cart.
//
// Usage: AND the result into every scanning Camera's existing isActive:
//   const gate = useCameraGate();
//   <Camera isActive={gate && <existing conditions>} ... />
//
// Idle pause (the third drain — camera hot between items during slow
// stretches) is screen-specific and lives with the lotting screen.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

export function useCameraGate(): boolean {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => sub.remove();
  }, []);

  return focused && appActive;
}
