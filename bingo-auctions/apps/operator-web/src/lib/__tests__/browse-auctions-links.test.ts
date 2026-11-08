// browse-auctions-links.test.ts
//
// WEB-01 guard: every link that PROMISES auctions must land on the auctions
// view.
//
// Background. /browse defaults to the cross-auction lot firehose — see
// isLotsMode() in (public)/browse/page.tsx, where `view !== 'auctions'` means
// lots. That default is deliberate (lots-first landing, mac.bid / nellis
// pattern) and is NOT what this test defends. What it defends is the three
// links whose visible label says "auctions" while their href said bare
// /browse, so a customer clicking "Browse Auctions" got a flat lot grid with
// no auction on screen.
//
// Why a source scan rather than a render test: vitest here is scoped to pure
// logic (see vitest.config.ts — "Next.js App Router internals are NOT tested
// here"). These are static JSX hrefs, so reading them off disk is both
// sufficient and cheap. The Playwright suite covers rendered behavior.
//
// Each assertion below was verified to FAIL by reverting its href to bare
// /browse before being trusted (WORKING_AGREEMENT §7c, "test the negative
// case").

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../app');

const HOMEPAGE = path.join(APP, '(public)', 'page.tsx');
const PUBLIC_LAYOUT = path.join(APP, '(public)', 'layout.tsx');

const read = (p: string): string => readFileSync(p, 'utf8');

/** Collapse whitespace so a wrapped JSX attribute still matches. */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

describe('WEB-01 — auction-labeled links land on the auctions view', () => {
  it('homepage hero CTA "Browse Auctions" carries view=auctions', () => {
    const src = flat(read(HOMEPAGE));
    // The hero is the literal surface WEB-01 names.
    expect(src).toMatch(/ctaLabel="Browse Auctions"/);
    expect(src).toMatch(/ctaHref="\/browse\?view=auctions"/);
  });

  it('nav link "Auctions" carries view=auctions', () => {
    const src = flat(read(PUBLIC_LAYOUT));
    expect(src).toMatch(
      /<NavLink href="\/browse\?view=auctions">\s*Auctions\s*<\/NavLink>/,
    );
  });

  it('footer link "Live auctions" carries view=auctions', () => {
    const src = flat(read(PUBLIC_LAYOUT));
    expect(src).toMatch(
      /<FooterLink href="\/browse\?view=auctions">\s*Live auctions\s*<\/FooterLink>/,
    );
  });

  it('no bare /browse link remains in the public layout', () => {
    // Both of this file's /browse links are auction-labeled (nav + footer),
    // so a bare one here is always the regression. Deliberately NOT applied
    // to page.tsx, which has a legitimate bare /browse under "Shop by
    // category" — that one is lots-oriented and must stay on the default.
    const src = read(PUBLIC_LAYOUT);
    const bare = [...src.matchAll(/href="\/browse"/g)];
    expect(
      bare.length,
      'A /browse link in (public)/layout.tsx lost its ?view=auctions. ' +
        'Bare /browse renders the lots firehose — see isLotsMode in ' +
        '(public)/browse/page.tsx.',
    ).toBe(0);
  });
});

describe('WEB-01 — the lots-first default is intentionally untouched', () => {
  it('isLotsMode still treats anything but view=auctions as lots', () => {
    // Pins the decision this ticket deliberately did NOT reverse. If someone
    // later flips the global default, this fails and forces the ~25 bare
    // /browse callers (auth callback, onboarding, profile empty states, the
    // city picker) to be re-reviewed rather than silently redirected.
    const src = flat(read(path.join(APP, '(public)', 'browse', 'page.tsx')));
    expect(src).toMatch(/function isLotsMode\([^)]*\)[^{]*\{ return sp\.view !== 'auctions'; \}/);
  });
});
