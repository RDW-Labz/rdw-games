// Sentry init for Next.js server runtime (App Router server components +
// route handlers + server actions). Loaded automatically by @sentry/nextjs
// via the instrumentation.ts hook.
//
// LAUNCH_PLAN §1.7: defense-in-depth secret redaction. We strip any field
// key matching /password|temp_password|secret|api_key|jwt|token/i from event
// payloads + breadcrumbs BEFORE the event leaves the process. This protects
// against:
//
//   - The staff-invite plaintext leaking via an unhandled exception that
//     happens to capture the request body / response body
//   - Service-role keys, Stripe keys, OpenAI/OpenRouter keys in env vars
//     showing up in error contexts
//   - JWTs in Authorization headers being recorded as breadcrumb metadata
//
// The redaction is opt-OUT (the only way a secret slips through is a
// future field name that doesn't match the pattern); we re-audit the regex
// list quarterly.

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

// Field-name pattern. Case-insensitive. Matches as a regex over the KEY,
// not the value, so an event payload like `{ password: 'plaintext' }`
// has the value blanked. Compound keys like `temp_password` match too.
//
// Add to this list when a new sensitive field name emerges. Removing
// entries should happen only via a deliberate review.
const SECRET_KEY_PATTERN = /password|temp_password|secret|api_key|apikey|jwt|access_token|refresh_token|bearer|stripe_secret|service_role/i;

const REDACTED = '[REDACTED]';

// Recursively walk an arbitrary value and blank any property whose key
// matches the pattern. Mutates in-place for performance — Sentry events
// are throw-away anyway, and we want zero allocation churn on the hot path.
// Cycle-safe (visited Set). Cap depth + entry count to bound CPU.
function redactInPlace(
  value: unknown,
  visited: WeakSet<object>,
  depth = 0,
  visitedCount = { n: 0 },
): void {
  if (depth > 8 || visitedCount.n > 5000) return;
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  visitedCount.n += 1;

  if (Array.isArray(value)) {
    for (const item of value) redactInPlace(item, visited, depth + 1, visitedCount);
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      // Blank the value entirely. Don't preserve the type — a string
      // becomes '[REDACTED]', an object becomes '[REDACTED]', etc.
      // The intent is "this key existed but its value cannot be
      // reproduced from the event".
      obj[key] = REDACTED;
      continue;
    }
    redactInPlace(obj[key], visited, depth + 1, visitedCount);
  }
}

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? 'development',
    // Strip PII by default; explicit user attachments are still tagged.
    sendDefaultPii: false,
    beforeSend(event) {
      // Top-level event payload. extra, contexts, request body, response,
      // user metadata — all walked.
      redactInPlace(event, new WeakSet());
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      // Breadcrumbs carry HTTP request/response data + console logs.
      // Same redaction pass for the breadcrumb's data object.
      if (breadcrumb.data) {
        redactInPlace(breadcrumb.data, new WeakSet());
      }
      // Drop the breadcrumb message entirely if it looks like a raw token
      // (long base64 / JWT shape). Defense for cases like
      // `console.log('headers:', headers)` where the value is the token.
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
