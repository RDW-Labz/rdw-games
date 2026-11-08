// Next.js 15 instrumentation hook. Called once per server runtime startup.
// Loads the matching Sentry config based on which runtime is starting.

import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Observability (PATCH-launch-readiness §4): forward every UNCAUGHT server-side
// error — App Router server components, route handlers, and server actions — to
// Sentry. Next.js calls this hook with the error + request context for any
// exception that escapes a request. Without it, a 500 from a route handler is
// invisible (no human alert). The redaction beforeSend in sentry.server.config
// still strips secrets from whatever this captures.
export const onRequestError = Sentry.captureRequestError;
