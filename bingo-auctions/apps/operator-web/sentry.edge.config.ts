// Sentry init for Next.js edge runtime (middleware + edge route handlers).
//
// LAUNCH_PLAN §1.7: matching secret redaction to the server runtime
// (sentry.server.config.ts). Edge runtime hits middleware which carries
// Authorization headers + cookie state, so the same pattern matters here.

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

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
    environment: process.env.NODE_ENV ?? 'development',
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
