/**
 * Which build of the console this page came from, and whether that build is
 * still the one being served.
 *
 * WHY THIS EXISTS (2026-09-15)
 * ────────────────────────────
 * `wrangler deploy` replaces the Worker's `_next/static` assets wholesale —
 * there is no multi-version asset retention on this hosting. A console left
 * open from before a deploy still references the previous build's chunk URLs.
 * Those 404, the next client-side navigation fails, and the UI silently stops
 * responding: the page renders, but nothing reacts to a click.
 *
 * Staff run the console as a standalone PWA on warehouse tablets and leave it
 * open for a whole shift, so this happens to every open tablet on every
 * deploy. On 2026-09-15 it was reported as "the auction builder glitches out,
 * we can't select any items" and cost an afternoon of diagnosis, because a
 * dead UI looks like a broken feature, not a stale tab.
 *
 * The console cannot fix itself — the fix is a reload, and a reload is the
 * user's call (see BuildSkewNotice: the Auction Builder holds its selection in
 * client state, so a forced reload would throw away someone's work). What it
 * CAN do is notice and say so.
 *
 * WHY THE RAW GIT SHA
 * ───────────────────
 * Both deploy paths set NEXT_PUBLIC_BUILD_ID to the FULL commit SHA:
 *   - .github/workflows/deploy-cloudflare.yml  (${{ github.sha }})
 *   - scripts/deploy-cf.sh                     (git rev-parse HEAD)
 * They must agree exactly, or switching deploy paths at the same commit
 * produces one spurious reload prompt. Full rather than short precisely
 * because there is then no truncation length for the two to disagree about;
 * BuildSkewNotice shortens it for display only.
 *
 * It is deliberately NOT hashed/opaque. Next.js already publishes its own
 * build id in every `_next/static/<buildId>/…` URL on every page, so the
 * marginal disclosure is negligible, and a readable SHA means that when
 * something is wrong you can map what prod is serving straight to a commit.
 * NEXT_PUBLIC_* is inlined into the client bundle at build time, so hashing
 * here would not have hidden it anyway — only hashing in the deploy scripts
 * would, at the cost of that debuggability.
 */

/**
 * Stand-in build id for any build that wasn't produced by a deploy script —
 * local `next dev`, `next build` by hand, CI builds that don't deploy.
 *
 * Skew detection is DISABLED whenever either side is this value. A dev server
 * rebuilds constantly; prompting there would train people to ignore the
 * prompt, which is the one failure mode that makes this feature worthless.
 */
export const DEV_BUILD_ID = 'dev';

/**
 * The build that produced the currently-running code.
 *
 * Safe to call from a server component or a route handler. NEXT_PUBLIC_* is
 * inlined at build time, so this is a constant per deploy rather than a
 * runtime Worker lookup — which matters, because the Worker's runtime env has
 * no build id in it and adding one would mean a second place to keep in sync.
 */
export function currentBuildId(): string {
  const raw = process.env.NEXT_PUBLIC_BUILD_ID;
  if (typeof raw !== 'string') return DEV_BUILD_ID;
  const trimmed = raw.trim();
  return trimmed === '' ? DEV_BUILD_ID : trimmed;
}

/**
 * Should the open page ask the user to reload?
 *
 * @param pageBuild   the build that server-rendered the page this tab is
 *                    running — baked into the HTML at load, so it is exactly
 *                    "the build these chunk URLs belong to"
 * @param servedBuild what /api/version reports right now
 *
 * Returns false unless we are certain: an unknown value on either side, or a
 * dev build on either side, means stay quiet. A false negative costs one
 * reload the user would have done anyway; a false positive nags someone
 * mid-checkout for nothing.
 */
export function shouldPromptReload(
  pageBuild: string | null | undefined,
  servedBuild: string | null | undefined,
): boolean {
  if (typeof pageBuild !== 'string' || typeof servedBuild !== 'string') return false;

  const page = pageBuild.trim();
  const served = servedBuild.trim();
  if (page === '' || served === '') return false;
  if (page === DEV_BUILD_ID || served === DEV_BUILD_ID) return false;

  return page !== served;
}

/**
 * Does this error mean the browser asked for a chunk that no longer exists?
 *
 * The poll in BuildSkewNotice is pre-emptive and can still be beaten by a
 * navigation seconds after a deploy, so this is the safety net: when the
 * failure actually happens, say so immediately instead of waiting for the
 * next poll.
 *
 * Matched by message rather than by class because the shape differs across
 * bundlers and across how the failure surfaces (a thrown ChunkLoadError, a
 * rejected dynamic import, a script `error` event). Deliberately the SECONDARY
 * signal: if a Next upgrade changes this wording the poll still works, and
 * this degrades to "no earlier warning" rather than to a broken feature.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error == null) return false;

  const name = typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'ChunkLoadError') return true;

  const message =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '';
  if (message === '') return false;

  return (
    /ChunkLoadError/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Loading CSS chunk \S+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}
