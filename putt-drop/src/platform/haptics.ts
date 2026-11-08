import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

export type HapticWeight = "light" | "medium" | "heavy";

function nativeImpact(weight: HapticWeight): void {
  const style =
    weight === "heavy"
      ? ImpactStyle.Heavy
      : weight === "medium"
        ? ImpactStyle.Medium
        : ImpactStyle.Light;
  void Haptics.impact({ style }).catch(() => {});
}

function webVibrate(ms: number): void {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  } catch {
    /* ignore */
  }
}

export function hapticImpact(enabled: boolean, weight: HapticWeight): void {
  if (!enabled) return;
  try {
    if (Capacitor.isNativePlatform()) {
      nativeImpact(weight);
      return;
    }
  } catch {
    /* fall through */
  }
  const ms = weight === "heavy" ? 28 : weight === "medium" ? 18 : 8;
  webVibrate(ms);
}
