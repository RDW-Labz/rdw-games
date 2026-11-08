// Which Google OAuth client ID the sign-in button may use on this platform.
//
// 2026-09-24: the login screen passed EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID on
// every platform. On Android, expo-auth-session's Google provider requires
// `androidClientId` and throws at render ("Client Id property androidClientId
// must be defined to use Google auth on this platform"), so every Android build
// with the production env crashed on the sign-in screen. Play 0.1.1 shipped
// 2026-08-10; Android bidder sign-ins went from ~20/week to ~0 that week and
// have stayed there, while iOS and web carried on. Reproduced on an emulator
// running Play 0.1.1's own commit (bidder-canary-android-emu, run 36041516658).
//
// A platform with no client ID of its own gets none, so the button stays hidden
// there (the component only mounts it for a defined ID). There is no Android
// client ID configured today, so Google sign-in is simply absent on Android —
// the outcome the original "hidden if unset" comment intended.

export interface GoogleClientIds {
  ios: string | undefined;
  android: string | undefined;
}

export interface GoogleClientChoice {
  clientId: string;
  /** The expo-auth-session config key this platform requires. */
  key: 'iosClientId' | 'androidClientId';
}

export function googleClientFor(
  platform: string,
  ids: GoogleClientIds,
): GoogleClientChoice | null {
  if (platform === 'ios' && ids.ios) return { clientId: ids.ios, key: 'iosClientId' };
  if (platform === 'android' && ids.android) {
    return { clientId: ids.android, key: 'androidClientId' };
  }
  return null;
}
