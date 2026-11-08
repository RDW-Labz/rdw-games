/**
 * GET /api/version
 *
 * Reports the build the Worker is serving RIGHT NOW. Two consumers:
 *
 *   1. BuildSkewNotice, in the operator console. Every page carries the build
 *      that server-rendered it; when this endpoint starts reporting a
 *      different one, that tab's chunk URLs no longer exist and it is one
 *      client-side navigation away from going inert. The notice offers a
 *      reload. (2026-09-15: staff reported "the auction builder glitches out,
 *      we can't select any items" for exactly this reason.)
 *
 *   2. tests/e2e and .github/workflows/e2e.yml. The Playwright suite runs
 *      against prod, but it is triggered by the push to master, not by the
 *      deploy — so a spec asserting brand-new behaviour used to run against
 *      the PREVIOUS build and fail. On 2026-09-15 the MOB-01 suite finished
 *      4m09s before the deploy that made it pass, and the resulting red check
 *      nearly got a working fix reverted. The suite now polls here until prod
 *      is serving the commit under test.
 *
 * No auth. The response carries a build identifier and nothing else — no
 * counts, no config, no row data. Next.js already publishes its own build id
 * in every `_next/static/<buildId>/…` URL on every page, so this discloses
 * nothing that a page load does not.
 *
 * CACHING: `no-store`, and that is load-bearing. If an edge or CDN layer
 * caches this, the poller reads a stale id forever, the notice never appears,
 * and the feature fails in the one direction nobody notices — silently. If
 * you change anything here, re-check the response headers on prod, not just
 * the JSON body.
 */

import { NextResponse } from 'next/server';
import { currentBuildId } from '@/lib/build-id';

export const runtime = 'nodejs';
// The build id is inlined at build time, so there is nothing dynamic to
// render — but this endpoint exists to report change, so it must never be
// statically cached at the route level either.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type VersionResponse = {
  /** Full commit SHA of the running build, or 'dev' outside a deploy. */
  build: string;
};

export function GET(): NextResponse<VersionResponse> {
  return NextResponse.json(
    { build: currentBuildId() },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        // Belt and braces for any intermediary that honours only one of these.
        Pragma: 'no-cache',
        Expires: '0',
        // Nothing here is per-user, but a shared cache keyed on cookies would
        // still be wrong: every viewer must see the CURRENT build, not the one
        // that happened to be live when some other viewer first asked.
        Vary: '*',
      },
    },
  );
}
