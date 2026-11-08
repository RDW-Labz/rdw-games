// tooling-domain-defaults.test.ts
//
// Guard against a stale fallback domain in test tooling.
//
// The project renamed clovrbid.com -> bingoauctions.com, but
// playwright.config.ts kept defaulting E2E_BASE_URL to the old domain for
// months. Nothing surfaced it: CI always passes E2E_BASE_URL explicitly, so
// the default was only reachable from a local `npm run e2e` with no env var —
// which then silently pointed the entire suite at a domain this project does
// not own. A green CI run is not evidence that a default is correct, because
// CI never exercises it.
//
// This asserts the fallback itself, not the env-provided value.
//
// Deliberately NOT flagged by this test:
//   * cdn.clovrbid.com — the live CDN, still serving category imagery and
//     allowed in next.config.ts remotePatterns.
//   * playwright-e2e@clovrbid.test — a synthetic login identity matched as a
//     literal string across the e2e helpers, not a URL. Renaming it breaks
//     sign-in. `.test` is reserved and unreachable by design.
//
// Per WORKING_AGREEMENT §7c this was confirmed to fail against the old
// default before being trusted.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG = path.resolve(__dirname, '../../../playwright.config.ts');

/** Strip comments so prose about the old domain doesn't trip the scan.
 *  `(?<!:)` keeps `https://` from being eaten as a line comment — a naive
 *  strip truncates the very URL this file exists to check. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

describe('playwright base-URL default', () => {
  const code = stripComments(readFileSync(CONFIG, 'utf8'));

  it('falls back to the current domain, not the pre-rename one', () => {
    expect(code).toMatch(
      /process\.env\.E2E_BASE_URL\s*\?\?\s*'https:\/\/bingoauctions\.com'/,
    );
  });

  it('contains no clovrbid.com URL in executable config', () => {
    const urls = [...code.matchAll(/https?:\/\/[^'"`\s)]*clovrbid\.com[^'"`\s)]*/g)].map(
      (m) => m[0],
    );
    expect(
      urls,
      `Pre-rename domain in playwright.config.ts: ${urls.join(', ')}`,
    ).toEqual([]);
  });
});
