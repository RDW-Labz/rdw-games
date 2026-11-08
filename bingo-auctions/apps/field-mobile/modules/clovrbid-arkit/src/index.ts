// BinGo Auctions ARKit module — JS surface.
//
// Wraps the native ClovrbidArkit Swift module (modules/clovrbid-arkit/ios/
// ClovrbidArkitModule.swift). The native module is iOS-only; on Android,
// simulator, or any device where ARKit is unavailable, `isSupported` is
// false and all functions are no-ops returning NULL_POSE.
//
// Usage (from a screen):
//
//   import { ClovrbidArkit } from '@/modules/clovrbid-arkit';
//
//   useEffect(() => {
//     if (!ClovrbidArkit.isSupported) return;
//     ClovrbidArkit.startSession();
//     return () => ClovrbidArkit.stopSession();
//   }, []);
//
//   // On bin scan:
//   const pose = ClovrbidArkit.pose();
//   if (pose.quality === 'normal') {
//     // pass pose.x, pose.z to stamp_bin_walk_position RPC
//   } else {
//     // stamp NULL coords; idealized grid fallback will render
//   }
//
// quality semantics:
//   normal               — coords are trustworthy; stamp them
//   initializing         — first few seconds of session; coords drift
//   relocalizing         — after backgrounding; coords reset
//   excessiveMotion      — operator walked too fast / waved the phone
//   insufficientFeatures — low-texture warehouse; ARKit can't track
//   notAvailable         — device doesn't support ARKit, simulator, etc

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export type PoseQuality =
  | 'normal'
  | 'initializing'
  | 'relocalizing'
  | 'excessiveMotion'
  | 'insufficientFeatures'
  | 'notAvailable';

export type Pose = {
  /** ARKit world X (right of origin), meters. */
  x: number;
  /** ARKit world Y (up from origin / floor height), meters. */
  y: number;
  /** ARKit world Z (forward from origin), meters. Mapped to bin coord_y_m. */
  z: number;
  /** Compass heading in degrees (post-MVP; 0 in v1). */
  heading: number;
  quality: PoseQuality;
};

const NULL_POSE: Pose = {
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  quality: 'notAvailable',
};

type NativeShape = {
  startSession(): void;
  pose(): Pose;
  reset(): void;
  stopSession(): void;
};

// requireNativeModule throws if the module isn't registered. That's the
// expected case on Android, simulator without ARKit, and during Jest tests.
// Catch and degrade to a no-op surface so JS callers never crash.
let native: NativeShape | null = null;
if (Platform.OS === 'ios') {
  try {
    native = requireNativeModule<NativeShape>('ClovrbidArkit');
  } catch {
    native = null;
  }
}

export const ClovrbidArkit = {
  /**
   * True only when the native module is registered and the device supports
   * ARWorldTrackingConfiguration. JS callers should gate AR-specific UI on
   * this (e.g. don't show "AR tracking" badges on Android).
   */
  isSupported: native !== null,

  startSession(): void {
    native?.startSession();
  },

  /**
   * Synchronous read of the latest camera-pose frame. Returns NULL_POSE
   * (quality: notAvailable) when AR isn't running. Safe to call from any
   * thread / any event handler.
   */
  pose(): Pose {
    return native?.pose() ?? NULL_POSE;
  },

  /**
   * Reset the session origin to the current camera position. Useful after
   * a pause/resume where the operator wants a fresh reference frame. Note:
   * the JS layer doesn't currently use this — the native module also
   * auto-resets after backgrounding via sessionInterruptionEnded. Reserved
   * for the post-MVP "re-anchor to known bin" feature.
   */
  reset(): void {
    native?.reset();
  },

  stopSession(): void {
    native?.stopSession();
  },
};
