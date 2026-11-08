// POST /api/debug/sentry-check  — observability self-test (gated)
//
// PATCH-launch-readiness §4 calls for VERIFYING that Sentry actually fires from
// the @opennextjs/cloudflare runtime — capture there is not guaranteed just
// because the SDK is wired. This endpoint lets us confirm it from the deployed
// Worker without waiting for a real production crash.
//
// Gated behind the same CRON_SECRET as /api/cron/* so it can't be abused
// publicly. Two modes:
//
//   POST /api/debug/sentry-check            → explicit Sentry.captureException +
//                                             flush, returns { event_id }. Proves
//                                             manual capture works in this runtime.
//   POST /api/debug/sentry-check?throw=1    → throws an UNCAUGHT error. Proves the
//                                             onRequestError hook (instrumentation.ts)
//                                             routes uncaught route errors to Sentry.
//
// Verify: curl -XPOST -H "x-cron-secret: $CRON_SECRET" https://bingoauctions.com/api/debug/sentry-check
//
// ── 2026-09-20: this endpoint could not fail ────────────────────────────────
// It used to return `{ ok: true, event_id }` unconditionally and tell the
// reader to go confirm the event in Sentry. Sentry has never been configured on
// this deployment — no SENTRY_DSN reached the Worker, so `Sentry.init()` was
// never called — and the endpoint still answered `ok: true` with a plausible
// 32-character event id, every time.
//
// Measured against @sentry/nextjs 10.52.0 with no client bound:
//
//     Sentry.captureException(...)  -> '334d108f68354a6c9ca3ac009f10c032'  (truthy!)
//     Sentry.flush(2000)            -> false
//
// The id is generated locally whether or not anything is sent, so it proves
// nothing. `flush()` returning false is the honest signal, and the old code
// awaited it without reading it.
//
// A self-test that cannot fail is worse than no self-test: it is what let
// someone believe error reporting worked. Now `ok` means the event actually
// left the process, and a `configured: false` response is a 503.

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkCronSecret } from '@/lib/cron-auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const url = new URL(req.url);
  const stamp = new Date().toISOString();

  // Mode 2: uncaught throw → exercises the onRequestError instrumentation hook.
  if (url.searchParams.get('throw') === '1') {
    throw new Error(`sentry-check: deliberate uncaught throw @ ${stamp}`);
  }

  // Is an SDK client actually bound? Without init() there is none, and every
  // capture is discarded silently. getClient is called defensively because the
  // nextjs entry resolves differently per runtime.
  const client = Sentry.getClient?.();
  const configured = Boolean(client);

  // Mode 1: explicit capture → exercises Sentry.captureException + transport.
  const eventId = Sentry.captureException(
    new Error(`sentry-check: deliberate manual capture @ ${stamp}`),
    { level: 'info', tags: { self_test: 'sentry-check' } },
  );
  // Workers/serverless can tear down the isolate before the event is sent, so
  // flush and KEEP THE ANSWER. false means nothing left the process — either
  // there is no client, or the transport did not drain in time.
  const flushed = await Sentry.flush(2000);

  const ok = configured && flushed;
  return NextResponse.json(
    {
      ok,
      configured,
      flushed,
      // Present whether or not anything was sent. Useful only for correlating
      // with a Sentry issue when ok is true; meaningless otherwise.
      event_id: eventId,
      reason: ok
        ? undefined
        : !configured
          ? 'SENTRY_DSN is not set on this Worker, so Sentry.init() never ran and ' +
            'every captureException in this codebase is a silent no-op. ' +
            'See deploy-cloudflare.yml and PR #340.'
          : 'the SDK is configured but the event did not flush within 2s — ' +
            'check the DSN, the project, and network egress from the Worker.',
      checked_at: stamp,
    },
    { status: ok ? 200 : 503 },
  );
}
