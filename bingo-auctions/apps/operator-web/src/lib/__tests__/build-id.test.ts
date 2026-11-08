// build-id.test.ts
//
// The comparison behind the reload prompt (2026-09-15). A deploy replaces the
// Worker's _next/static assets wholesale, so a console left open from before
// it holds chunk URLs that now 404 and quietly stops responding to clicks.
// BuildSkewNotice offers a reload; this is the logic that decides when.
//
// Unit-tested rather than browser-tested because the interesting cases are the
// ones that must stay SILENT — a dev build, a missing env var, a half-
// configured deploy. Those are states a Playwright run against prod can never
// enter, and they are the states where a false positive would nag someone
// mid-checkout for nothing.
//
// Per WORKING_AGREEMENT §7c, each expectation here was confirmed to FAIL
// against a deliberately broken implementation before being trusted. Notes on
// the specific mutants used are inline.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEV_BUILD_ID,
  currentBuildId,
  isChunkLoadError,
  shouldPromptReload,
} from '@/lib/build-id';

const SHA_A = '6bb81c2f4e2a1d09b7c3e5f8a9d2b4c6e8f0a1b3';
const SHA_B = 'dcb4567a9e1f2c3d4b5a6978e0f1a2b3c4d5e6f7';

describe('currentBuildId', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports the id the deploy scripts injected', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', SHA_A);
    expect(currentBuildId()).toBe(SHA_A);
  });

  it('falls back to the dev id when the deploy never set one', () => {
    // The failure mode this guards: only ONE of the two deploy paths
    // (deploy-cloudflare.yml / deploy-cf.sh) gets updated, so a build ships
    // with no id. It must degrade to "detection off", never to a build id of
    // "undefined" that then differs from every other page and nags forever.
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '');
    expect(currentBuildId()).toBe(DEV_BUILD_ID);
  });

  it('treats a whitespace-only value as no value', () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '  \n ');
    expect(currentBuildId()).toBe(DEV_BUILD_ID);
  });
});

describe('shouldPromptReload', () => {
  it('prompts when the served build differs from the page build', () => {
    // The whole point. Mutant checked: `return false` here — this fails.
    expect(shouldPromptReload(SHA_A, SHA_B)).toBe(true);
  });

  it('stays silent when the builds match', () => {
    // The common case by far: every poll on a healthy tab. Mutant checked:
    // `return page !== served` inverted to `===` — this fails.
    expect(shouldPromptReload(SHA_A, SHA_A)).toBe(false);
  });

  it('stays silent on a dev build, on either side', () => {
    // `next dev` rebuilds constantly. Prompting locally would train people to
    // dismiss the banner on reflex, which is the one failure mode that makes
    // the whole feature worthless in prod.
    expect(shouldPromptReload(DEV_BUILD_ID, SHA_A)).toBe(false);
    expect(shouldPromptReload(SHA_A, DEV_BUILD_ID)).toBe(false);
    expect(shouldPromptReload(DEV_BUILD_ID, DEV_BUILD_ID)).toBe(false);
  });

  it('stays silent when either side is missing', () => {
    // A build where NEXT_PUBLIC_BUILD_ID was never set, or an /api/version
    // response that lost the field. Unknown must mean quiet, never "assume
    // stale" — an always-on banner is indistinguishable from a broken one.
    expect(shouldPromptReload(null, SHA_A)).toBe(false);
    expect(shouldPromptReload(SHA_A, null)).toBe(false);
    expect(shouldPromptReload(undefined, SHA_A)).toBe(false);
    expect(shouldPromptReload(SHA_A, undefined)).toBe(false);
    expect(shouldPromptReload('', SHA_A)).toBe(false);
    expect(shouldPromptReload(SHA_A, '')).toBe(false);
    expect(shouldPromptReload('   ', SHA_A)).toBe(false);
  });

  it('ignores surrounding whitespace rather than reading it as a new build', () => {
    // A trailing newline from `git rev-parse` piped through a shell is the
    // realistic way this arrives dirty. Treating it as a difference would
    // show every tablet a reload prompt on a deploy that changed nothing.
    expect(shouldPromptReload(` ${SHA_A}`, `${SHA_A}\n`)).toBe(false);
  });

  it('treats a differing prefix of the same length as a different build', () => {
    // Guards against a comparison that only looks at the first N characters —
    // plausible if someone later "shortens" the id for display and compares
    // the shortened form.
    expect(shouldPromptReload(SHA_A, SHA_A.slice(0, -1) + '0')).toBe(true);
  });
});

describe('isChunkLoadError', () => {
  it('recognises the error webpack throws for a missing chunk', () => {
    const err = new Error('Loading chunk 4821 failed.\n(missing: https://…/4821.js)');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('recognises it by name even when the message says nothing useful', () => {
    const err = new Error('');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('recognises the native ESM and CSS variants', () => {
    // Different bundler/runtime paths word this differently; the poll is the
    // primary signal precisely because this list is the fragile part.
    expect(
      isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://…/page.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 12 failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('accepts a bare string, which is what window.onerror hands over', () => {
    expect(isChunkLoadError('ChunkLoadError: Loading chunk 9 failed.')).toBe(true);
  });

  it('ignores ordinary application errors', () => {
    // The mutant that matters: a matcher loose enough to catch every Error
    // would put a reload banner in front of staff for unrelated bugs, and
    // train them to ignore it. Each of these must stay false.
    expect(isChunkLoadError(new Error('Not authenticated'))).toBe(false);
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError('Admins or managers only')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});
