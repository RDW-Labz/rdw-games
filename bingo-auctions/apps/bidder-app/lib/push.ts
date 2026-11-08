// Expo push registration. Idempotent: safe to call on every signed-in
// session. Stores the token on the bidder's row so the auction-engine
// notifications worker can target the device.
//
// We don't gate UI on push; if the user denies permission, everything else
// keeps working. They just won't get outbid alerts.
//
// 2026-05-20: Moved Notifications.setNotificationHandler() inside the
// registration function. Previously it was at module-load (top of file)
// which fires the moment _layout.tsx imports this module — that pattern
// is the same root cause as the expo-updates crash (TurboModule call
// during module evaluation, before Fabric is fully initialized). Apple
// Sign In bidder hangs were the symptom. Now the handler is set only
// when registerForPushNotifications() is called, which runs AFTER the
// auth state has settled and the layout has mounted.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from '@auction-platform/supabase-client';

let handlerRegistered = false;

function ensureNotificationHandlerRegistered(): void {
  if (handlerRegistered) return;
  // In-foreground behavior: show banner + play sound. Without this Expo
  // suppresses notifications when the app is open.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  handlerRegistered = true;
}

export async function registerForPushNotifications(): Promise<string | null> {
  ensureNotificationHandlerRegistered();
  if (!Device.isDevice) {
    // Push doesn't work on simulators; bail silently.
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  const projectId =
    (Constants.expoConfig?.extra?.['eas'] as { projectId?: string } | undefined)?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId;

  const tokenResp = projectId
    ? await Notifications.getExpoPushTokenAsync({ projectId })
    : await Notifications.getExpoPushTokenAsync();

  const token = tokenResp.data;
  if (!token) return null;

  // Persist the token on the bidder's row.
  const { data: u } = await supabase.auth.getUser();
  if (u.user) {
    await supabase
      .from('bidders')
      .update({ expo_push_token: token, push_registered_at: new Date().toISOString() })
      .eq('id', u.user.id);
  }

  return token;
}
