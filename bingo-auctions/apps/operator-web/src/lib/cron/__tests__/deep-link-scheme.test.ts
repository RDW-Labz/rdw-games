// deep-link-scheme.test.ts
//
// Guard against the bug that has now shipped twice.
//
// The bidder app's custom URL scheme has been renamed bidwizops → clovrbid →
// bingo. Both sweeps missed push producers, leaving `deep_link` values on a
// scheme no installed build registers. That is not a soft failure: the OS
// refuses the URI, and (until the 2026-09-14 fix in apps/bidder-app/app/
// _layout.tsx) the refusal also suppressed the `kind` fallback that would
// otherwise have routed the tap correctly. The notification simply did
// nothing when tapped, with no error anywhere.
//
// Nothing about a hardcoded string makes the next rename notice it, so this
// test is the thing that notices: every `deep_link` literal in the app must
// come from bidderDeepLink() / BIDDER_APP_SCHEME, not from a raw scheme typed
// inline.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BIDDER_APP_SCHEME, bidderDeepLink } from '@/lib/app-links';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments so prose mentioning an old scheme doesn't trip the scan.
 *
 * The `(?<!:)` matters more than it looks: a naive //-to-end-of-line strip
 * also eats the `//` in `clovrbid://`, truncating the very literal this file
 * exists to catch and turning the whole guard into a no-op that always passes.
 * Only treat `//` as a comment when a `:` doesn't immediately precede it.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

describe('bidderDeepLink', () => {
  it('builds a URI on the app scheme', () => {
    expect(bidderDeepLink('profile/pay-fees')).toBe(`${BIDDER_APP_SCHEME}://profile/pay-fees`);
  });

  it('normalises a leading slash so callers can pass either form', () => {
    expect(bidderDeepLink('/invoice/abc')).toBe(bidderDeepLink('invoice/abc'));
  });

  it('matches the scheme registered in the bidder app', () => {
    // Single source of truth check: apps/bidder-app/app.config.ts is what the
    // OS actually honours. If someone renames there and not here, every push
    // deep link goes dead — so fail loudly at build time instead.
    const config = readFileSync(
      path.resolve(SRC_ROOT, '../../bidder-app/app.config.ts'),
      'utf8',
    );
    const declared = config.match(/scheme:\s*'([^']+)'/)?.[1];
    expect(declared).toBe(BIDDER_APP_SCHEME);
  });
});

describe('no raw deep_link schemes in source', () => {
  // Matches `deep_link: 'foo://…'` / `deep_link: \`foo://…\`` — an inline
  // custom-scheme literal on the payload key the bidder app reads.
  const RAW_DEEP_LINK = /deep_link:\s*[`'"]([a-z][a-z0-9+.-]*):\/\//gi;

  it('every deep_link value is built from bidderDeepLink()', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(RAW_DEEP_LINK)) {
        offenders.push(`${path.relative(SRC_ROOT, file)} → ${m[1]}://`);
      }
    }

    expect(
      offenders,
      `Hardcoded deep_link scheme(s) found. Use bidderDeepLink() from ` +
        `@/lib/app-links instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no producer still emits a pre-rename scheme', () => {
    const dead = ['clovrbid://', 'bidwizops://'];
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      // The web pickup pass still encodes bidwizops:// in a QR image. That is
      // deliberately out of scope here (the staff scanner's regex is
      // scheme-agnostic, so it still scans) — this test covers push payloads.
      if (file.endsWith(path.join('profile', 'pickup', '[id]', 'page.tsx'))) continue;

      const code = stripComments(readFileSync(file, 'utf8'));
      for (const scheme of dead) {
        if (code.includes(scheme)) {
          offenders.push(`${path.relative(SRC_ROOT, file)} → ${scheme}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
