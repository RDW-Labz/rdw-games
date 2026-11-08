import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FINISH_PROFILE_PATH,
  finishProfileRedirect,
  nextPathFromRequest,
  safeInternalPath,
} from '../bidder-onboarding-gate';

const orphan = {
  signedIn: true,
  isOperator: false,
  hasBidderRow: false,
  bidderLookupFailed: false,
  staffLookupFailed: false,
};

describe('finishProfileRedirect', () => {
  it('sends a signed-in orphan to onboarding and preserves the destination', () => {
    expect(finishProfileRedirect(orphan, '/browse?view=auctions')).toBe(
      `${FINISH_PROFILE_PATH}?next=${encodeURIComponent('/browse?view=auctions')}`,
    );
    expect(finishProfileRedirect(orphan, '/lot/TEA-123')).toBe(
      `${FINISH_PROFILE_PATH}?next=${encodeURIComponent('/lot/TEA-123')}`,
    );
  });

  it('falls back to bare onboarding when there is no usable destination', () => {
    expect(finishProfileRedirect(orphan, null)).toBe(FINISH_PROFILE_PATH);
    expect(finishProfileRedirect(orphan, '')).toBe(FINISH_PROFILE_PATH);
    expect(finishProfileRedirect(orphan, 'https://evil.example/x')).toBe(
      FINISH_PROFILE_PATH,
    );
    expect(finishProfileRedirect(orphan, '//evil.example/x')).toBe(FINISH_PROFILE_PATH);
  });

  it('never redirects an anonymous visitor', () => {
    expect(
      finishProfileRedirect({ ...orphan, signedIn: false }, '/browse'),
    ).toBeNull();
  });

  it('never redirects staff (operator_users row)', () => {
    expect(
      finishProfileRedirect({ ...orphan, isOperator: true }, '/browse'),
    ).toBeNull();
  });

  it('never redirects a user who already has a bidders row', () => {
    expect(
      finishProfileRedirect({ ...orphan, hasBidderRow: true }, '/browse'),
    ).toBeNull();
  });

  it('does not treat a transient bidder lookup failure as a missing profile', () => {
    expect(
      finishProfileRedirect({ ...orphan, bidderLookupFailed: true }, '/browse'),
    ).toBeNull();
  });

  it('does not treat a transient staff lookup failure as proof the user is not staff', () => {
    // A staff-only account whose operator_users lookup blips must not be
    // mistaken for a bidder orphan and bounced to onboarding.
    expect(
      finishProfileRedirect({ ...orphan, staffLookupFailed: true }, '/browse'),
    ).toBeNull();
  });

  it('never builds a next back into the gate or the auth callback', () => {
    for (const path of [
      '/bidder/onboarding',
      '/bidder/onboarding?next=/lot/x',
      '/bidder/onboarding/payment-method',
      '/auth/callback',
      '/auth/handoff',
    ]) {
      expect(finishProfileRedirect(orphan, path), path).toBe(FINISH_PROFILE_PATH);
    }
  });
});

describe('safeInternalPath', () => {
  it('keeps a normal same-site path with its query string', () => {
    expect(safeInternalPath('/browse?view=auctions&page=2')).toBe(
      '/browse?view=auctions&page=2',
    );
    expect(safeInternalPath('/')).toBe('/');
  });

  it('rejects scheme, protocol-relative, backslash and control characters', () => {
    for (const path of [
      'http://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      '/\t/evil.example',
      '/path\nHX-Header: 1',
      '/path\rX',
      'browse',
      '',
      null,
      undefined,
    ]) {
      expect(safeInternalPath(path), String(path)).toBeNull();
    }
  });
});

describe('nextPathFromRequest', () => {
  it('preserves the complete query string, including encoded values', () => {
    expect(nextPathFromRequest('/browse', '?view=auctions&city=Harrison')).toBe(
      '/browse?view=auctions&city=Harrison',
    );
    expect(nextPathFromRequest('/browse', '?q=box%20of%20mugs&page=2')).toBe(
      '/browse?q=box%20of%20mugs&page=2',
    );
    expect(nextPathFromRequest('/lot/TEA-123', '?from=email')).toBe(
      '/lot/TEA-123?from=email',
    );
  });

  it('returns the bare pathname when there is no usable search', () => {
    expect(nextPathFromRequest('/browse', '')).toBe('/browse');
    expect(nextPathFromRequest('/browse', null)).toBe('/browse');
    expect(nextPathFromRequest('/browse', undefined)).toBe('/browse');
    // A search that does not start with `?` is not concatenated.
    expect(nextPathFromRequest('/browse', 'view=auctions')).toBe('/browse');
  });

  it('drops a control-character-bearing search instead of concatenating it', () => {
    expect(nextPathFromRequest('/browse', '?x=1\nHX-Header: 1')).toBe('/browse');
    expect(nextPathFromRequest('/browse', '?x=1\rY')).toBe('/browse');
    expect(nextPathFromRequest('/browse', '?x=1\u0000')).toBe('/browse');
  });

  it('returns null when there is no pathname', () => {
    expect(nextPathFromRequest(null, '?x=1')).toBeNull();
    expect(nextPathFromRequest('', '?x=1')).toBeNull();
    expect(nextPathFromRequest(undefined, '?x=1')).toBeNull();
  });
});

describe('public layout wiring', () => {
  it('applies the finish-profile gate before rendering the marketplace', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'app', '(public)', 'layout.tsx'),
      'utf8',
    );
    expect(source).toContain("from '@/lib/bidder-onboarding-gate'");
    expect(source).toContain('finishProfileRedirect(');
    expect(source).toContain('redirect(target)');
    // Both lookups must be error-aware so a blip cannot bounce a real bidder
    // or a staff member to onboarding.
    expect(source).toMatch(/bidderLookupFailed\s*[:=]/);
    expect(source).toMatch(/staffLookupFailed\s*[:=]/);
    expect(source).toContain("from('bidders')");
    expect(source).toContain("from('operator_users')");
    // The destination must include the query string, not just the pathname.
    expect(source).toContain('nextPathFromRequest(');
    expect(source).toContain("h.get('x-search')");
  });

  it('middleware exposes the query string and overwrites both headers', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'middleware.ts'),
      'utf8',
    );
    expect(source).toContain("requestHeaders.set('x-pathname'");
    expect(source).toContain("requestHeaders.set('x-search'");
    expect(source).toContain('req.nextUrl.search');
  });

  it('onboarding offers a guest escape that signs out instead of looping', () => {
    const page = readFileSync(
      join(__dirname, '..', '..', 'app', 'bidder', 'onboarding', 'page.tsx'),
      'utf8',
    );
    expect(page).toContain('GuestEscape');
    expect(page).not.toMatch(/href="\/"/);
    const escape = readFileSync(
      join(__dirname, '..', '..', 'app', 'bidder', 'onboarding', 'GuestEscape.tsx'),
      'utf8',
    );
    expect(escape).toContain("signOut({ scope: 'local' })");
    expect(escape).toContain("router.push('/')");
  });
});
