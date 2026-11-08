// Make the suite say — and where it matters, insist on — WHICH build of the
// site it is testing.
//
// WHY (2026-09-15)
// ────────────────
// The suite runs against prod, but it is triggered by the push to master.
// Deploying is a separate, manually-dispatched workflow. So a spec asserting
// behaviour that has just been merged runs against the PREVIOUS build and
// fails, correctly, for a reason that has nothing to do with the code.
//
// That happened to MOB-01: the e2e run finished at 16:18:08 and the deploy
// that made those assertions true finished at 16:22:17 — four minutes and
// nine seconds later. All three specs failed, the check went red, and the fix
// was very nearly reverted off a live site where it was working fine. The
// specs were right; they were simply pointed at yesterday's build.
//
// Two levels, because the right answer differs by trigger:
//
//   ALWAYS  log the build prod is serving next to the commit under test. A
//           red run then explains itself in its own log instead of costing an
//           afternoon. This is the part that would have prevented the MOB-01
//           scare on its own.
//
//   ON DEMAND (E2E_REQUIRE_BUILD) wait until prod actually serves that commit
//           before running anything, and fail loudly if it never does. Set by
//           the workflow_run trigger in e2e.yml, which fires after a
//           successful deploy and therefore knows a specific commit is
//           supposed to be live.
//
// It must stay OFF by default. Deploys are workflow_dispatch-only, so most
// merges to master are never deployed at all — requiring the pushed SHA
// unconditionally would hang every one of them until the timeout.

/** How long to wait for a deploy to become visible before giving up. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Gap between polls. The deploy job itself takes ~6 minutes. */
const POLL_INTERVAL_MS = 15_000;

/** A single probe must not hang on a Worker that is mid-restart. */
const FETCH_TIMEOUT_MS = 10_000;

export type BuildProbe = { build: string } | { error: string };

/** Ask the deployed site which build it is serving right now. */
export async function probeBuild(baseUrl: string): Promise<BuildProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/version`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && typeof (body as { build?: unknown }).build === 'string') {
      return { build: (body as { build: string }).build };
    }
    return { error: 'response had no string `build` field' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function short(sha: string): string {
  return /^[0-9a-f]{12,40}$/i.test(sha) ? sha.slice(0, 12) : sha;
}

/**
 * Report which build is live, and — when E2E_REQUIRE_BUILD names a commit —
 * block until prod is serving it.
 *
 * Never throws for a missing/unreadable /api/version unless a specific build
 * was required. An older deploy that predates that endpoint should still be
 * testable; it just cannot be identified.
 */
export async function waitForBuild(baseUrl: string): Promise<void> {
  const required = process.env.E2E_REQUIRE_BUILD?.trim();
  const commitUnderTest = process.env.GITHUB_SHA?.trim();

  const first = await probeBuild(baseUrl);

  if (!required) {
    if ('build' in first) {
      const note =
        commitUnderTest && commitUnderTest !== first.build
          ? ` — NOTE: differs from the commit under test (${short(commitUnderTest)}). ` +
            `If a spec asserts behaviour from that commit, it is testing the OLD build and ` +
            `will fail until "Deploy Cloudflare Workers (BinGo)" has run.`
          : '';
      console.log(`[e2e setup] ${baseUrl} is serving build ${short(first.build)}${note}`);
    } else {
      console.log(
        `[e2e setup] could not read ${baseUrl}/api/version (${first.error}). ` +
          `Continuing — the build under test cannot be identified.`,
      );
    }
    return;
  }

  const timeoutMs = Number(process.env.E2E_REQUIRE_BUILD_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let last: BuildProbe = first;

  for (;;) {
    if ('build' in last && last.build === required) {
      console.log(`[e2e setup] ${baseUrl} is serving the required build ${short(required)}`);
      return;
    }
    if (Date.now() >= deadline) break;

    const seen = 'build' in last ? short(last.build) : `unreadable (${last.error})`;
    console.log(
      `[e2e setup] waiting for build ${short(required)} — currently ${seen}; ` +
        `${Math.round((deadline - Date.now()) / 1000)}s left`,
    );
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    last = await probeBuild(baseUrl);
  }

  const seen = 'build' in last ? short(last.build) : `unreadable (${last.error})`;
  throw new Error(
    `e2e: ${baseUrl} never served build ${short(required)} within ${Math.round(timeoutMs / 1000)}s ` +
      `(still on ${seen}). The deploy probably failed — check "Deploy Cloudflare Workers (BinGo)". ` +
      `Running the suite now would test the OLD build and report failures that are not real.`,
  );
}
