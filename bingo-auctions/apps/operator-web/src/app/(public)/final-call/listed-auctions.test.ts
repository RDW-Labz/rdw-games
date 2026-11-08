import { describe, it, expect } from 'vitest';
import { isFromListedAuction } from './listed-auctions';

describe('isFromListedAuction', () => {
  const listed = new Set(['a-real']);
  it('shows a lot from a listed auction', () => {
    expect(isFromListedAuction('a-real', listed)).toBe(true);
  });
  it('hides a lot from an unlisted test or demo auction (not in the set)', () => {
    expect(isFromListedAuction('a-test', listed)).toBe(false);
  });
  it('hides a lot with no auction', () => {
    expect(isFromListedAuction(null, listed)).toBe(false);
    expect(isFromListedAuction(undefined, listed)).toBe(false);
  });
  it('hides everything when no auction is listed', () => {
    expect(isFromListedAuction('a-real', new Set())).toBe(false);
  });
});
