// Best back camera for warehouse + label-reading conditions.
//
// ── iOS: prefer the virtual multi-lens device ───────────────────────────────
// expo-camera and the naive vision-camera v4 useCameraDevice('back') both
// return the device's *default* physical camera, which on most modern
// iPads is the standard wide-angle lens. That lens has a minimum focus
// distance of ~10-12 inches — closer than that, the camera can't
// converge, and tap-to-focus appears to "still focus on the distance"
// because the lens physically can't refocus at the requested point.
// This was the symptom Michael hit on Build 15 on the warehouse iPad.
//
// Passing the 3-lens filter returns a *virtual* device that auto-switches
// between the available physical cameras based on focus distance:
//   - ultra-wide-angle-camera   (close subjects — labels held a few inches away)
//   - wide-angle-camera          (medium distance — full-item shots)
//   - telephoto-camera           (longer reach — shelf overviews from across the aisle)
//
// ── Android: DON'T (2026-08-13) ─────────────────────────────────────────────
// This file used to pass that same filter on every platform, on the stated
// assumption that "on single-camera devices (older iPads, most Android),
// vision-camera falls back to whatever single physical camera exists, so this
// is a zero-cost change there."
//
// That assumption does not hold, and it is the one thing every camera screen
// in this app shares — which matches the 2026-08-13 report that the camera
// "glitches and crashes" on Android phones across ALL camera functions (not
// just Relot) while the iPad is fine.
//
// getCameraDevice() (vision-camera 4.7.3, src/devices/getCameraDevice.ts) does
// not "fall back to the single camera" when a filter is passed. It scores every
// back-facing device: +1 for each of its physicalDevices that appears in the
// filter, -1 for each that doesn't. A modern Android phone exposes several back
// camera IDs, typically including a LOGICAL_MULTI_CAMERA that reports all three
// sub-lenses — so our filter scores that logical device +3 and it always wins.
// Android logical multi-cameras are exactly the devices whose OEM drivers most
// often fail to configure a preview + photo + image-analysis session together.
//
// Note what the library does when NO filter is passed (the `else` branch): it
// adds +2 for wide-angle-camera and explicitly ranks multi-camera devices LOWER
// ("we only want a simple camera"). That default is the conservative choice, so
// on Android we take it instead of overriding it.
//
// The close-focus problem the filter solves is an iPad-lens problem; Android
// phone wide lenses focus far closer, so nothing is given up here.
//
// UNVERIFIED: this is a code-evidence diagnosis, not a reproduced one. There is
// no crash report to confirm it against — the @sentry/react-native plugin was
// removed from app.config.ts on 2026-05-20 (it was masking an unrelated iOS 26
// RNSScreen crash), so this app currently ships with no crash reporting at all,
// on either platform. If Android still crashes after this build, the next step
// is a real stack trace, not another guess: `adb logcat` while reproducing, or
// re-enabling Sentry for Android only.
//
// All camera-using screens call this instead of useCameraDevice('back')
// directly so the lens-picking policy stays in one place.

import { useMemo } from 'react';
import { Platform } from 'react-native';
import {
  getCameraDevice,
  useCameraDevices,
  type CameraDevice,
  type PhysicalCameraDeviceType,
} from 'react-native-vision-camera';

/**
 * The lens set we want iOS to combine into one virtual close-focus-capable
 * device. Android deliberately does not use this — see the header.
 */
const IOS_PHYSICAL_DEVICES: PhysicalCameraDeviceType[] = [
  'ultra-wide-angle-camera',
  'wide-angle-camera',
  'telephoto-camera',
];

export function useBackCamera(): CameraDevice | undefined {
  // One device-list subscription, then pick per platform. (Calling
  // useCameraDevice twice would work — it's just a useMemo over this same list
  // and opens no session — but it would register two devices-changed
  // listeners for no reason.)
  const devices = useCameraDevices();

  return useMemo(
    () =>
      Platform.OS === 'ios'
        ? getCameraDevice(devices, 'back', { physicalDevices: IOS_PHYSICAL_DEVICES })
        : getCameraDevice(devices, 'back'),
    [devices],
  );
}
