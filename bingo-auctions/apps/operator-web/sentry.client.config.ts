// Sentry init for the operator console browser bundle.
//
// LAUNCH_PLAN §1.7: matching secret redaction to server + edge.
// The browser bundle is where Session Replay records DOM state — the
// extra paranoia matters because a replay could capture the temp-
// password card if a session-replay capture races the user dismissing
// it. We can't redact replays via beforeSend (they go through a
// different transport) but the field-name redaction still applies to
// console / network breadcrumbs and to event extras.

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const SECRET_KEY_PATTERN = /password|temp_password|secret|api_key|apikey|jwt|access_token|refresh_token|bearer|stripe_secret|service_role/i;
const REDACTED = '[REDACTED]';

function redactInPlace(
  value: unknown,
  visited: WeakSet<object>,
  depth = 0,
  count = { n: 0 },
): void {
  if (depth > 8 || count.n > 5000) return;
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  count.n += 1;

  if (Array.isArray(value)) {
    for (const item of value) redactInPlace(item, visited, depth + 1, count);
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      obj[key] = REDACTED;
      continue;
    }
    redactInPlace(obj[key], visited, depth + 1, count);
  }
}

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.0,
    environment: process.env.NODE_ENV ?? 'development',
    // We attach the operator_id when the app loads (see Layout). Until then,
    // events are anonymous.
    sendDefaultPii: false,
    // Session Replay text masking — applied to every input by default.
    // The temp-password card uses a normal <input type="text">, which
    // Replay also masks-by-default when the input has a sensitive name;
    // we ALSO add `mask-content` data attributes on the credentials card
    // (see StaffList.tsx) but this safety net catches anything new.
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false,
        maskAllInputs: true,
        blockAllMedia: false,
      }),
    ],
    beforeSend(event) {
      redactInPlace(event, new WeakSet());
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) {
        redactInPlace(breadcrumb.data, new WeakSet());
      }
      if (
        typeof breadcrumb.message === 'string' &&
        /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(breadcrumb.message)
      ) {
        breadcrumb.message = REDACTED;
      }
      return breadcrumb;
    },
  });
}
