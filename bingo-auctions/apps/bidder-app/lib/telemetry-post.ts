// One sender for everything that lands in client_crash_reports from the bidder
// app. Fire-and-forget, 3s cap, every error swallowed: telemetry must never be
// the thing that breaks the app.

import { Platform } from 'react-native';

const API_BASE = (
  (typeof process !== 'undefined' &&
    (process.env.EXPO_PUBLIC_API_BASE_URL || process.env.EXPO_PUBLIC_OPERATOR_WEB_URL)) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

export interface CrashReportBody {
  message: string;
  stack?: string;
  screen?: string;
  app_version?: string;
  ota_update?: string;
  is_fatal: boolean;
}

/** Resolves true only when the server accepted the report. */
export function postCrashReport(body: CrashReportBody): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  return fetch(`${API_BASE}/api/telemetry/crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'bidder',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      ...body,
      message: body.message.slice(0, 500),
      stack: body.stack?.slice(0, 8000),
      screen: body.screen?.slice(0, 200),
    }),
    signal: controller.signal,
  })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timeout));
}
