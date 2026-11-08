// __tests__/condition.test.ts
//
// Vitest tests for normalizeCondition().
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect } from 'vitest';

import { normalizeCondition } from '../condition';

describe('normalizeCondition — null / empty inputs', () => {
  it('null → null', () => expect(normalizeCondition(null)).toBeNull());
  it('undefined → null', () => expect(normalizeCondition(undefined)).toBeNull());
  it('empty string → null', () => expect(normalizeCondition('')).toBeNull());
  it('whitespace only → null', () => expect(normalizeCondition('   ')).toBeNull());
  it('unknown string → null', () => expect(normalizeCondition('xyzzy gibberish')).toBeNull());
});

describe('normalizeCondition → appears_new', () => {
  it('"new" exact → appears_new', () => expect(normalizeCondition('new')).toBe('appears_new'));
  it('"NEW" all-caps → appears_new', () => expect(normalizeCondition('NEW')).toBe('appears_new'));
  it('"Like New" → appears_new', () => expect(normalizeCondition('Like New')).toBe('appears_new'));
  it('"like-new" hyphenated → appears_new', () =>
    expect(normalizeCondition('like-new')).toBe('appears_new'));
  it('"Brand New" → appears_new', () =>
    expect(normalizeCondition('Brand New')).toBe('appears_new'));
  it('"Factory Sealed" → appears_new', () =>
    expect(normalizeCondition('Factory Sealed')).toBe('appears_new'));
  it('"factory-sealed" hyphenated → appears_new', () =>
    expect(normalizeCondition('factory-sealed')).toBe('appears_new'));
  it('"New/Sealed" → appears_new', () =>
    expect(normalizeCondition('New/Sealed')).toBe('appears_new'));
  it('"Refurbished" → appears_new', () =>
    expect(normalizeCondition('Refurbished')).toBe('appears_new'));
  it('"Appears New" → appears_new', () =>
    expect(normalizeCondition('Appears New')).toBe('appears_new'));
  it('"mint condition" → appears_new', () =>
    expect(normalizeCondition('mint condition')).toBe('appears_new'));
  it('"Sealed Box" → appears_new', () =>
    expect(normalizeCondition('Sealed Box')).toBe('appears_new'));
});

describe('normalizeCondition → open_box', () => {
  it('"Open Box" → open_box', () => expect(normalizeCondition('Open Box')).toBe('open_box'));
  it('"open-box" hyphenated → open_box', () =>
    expect(normalizeCondition('open-box')).toBe('open_box'));
  it('"OPEN BOX" all-caps → open_box', () =>
    expect(normalizeCondition('OPEN BOX')).toBe('open_box'));
  it('"Opened" → open_box', () => expect(normalizeCondition('Opened')).toBe('open_box'));
  it('"Customer Return" → open_box', () =>
    expect(normalizeCondition('Customer Return')).toBe('open_box'));
  it('"customer-return" hyphenated → open_box', () =>
    expect(normalizeCondition('customer-return')).toBe('open_box'));
  it('"Store Return" → open_box', () =>
    expect(normalizeCondition('Store Return')).toBe('open_box'));
  it('"Shelf Pull" → open_box', () => expect(normalizeCondition('Shelf Pull')).toBe('open_box'));
  it('"shelf-pull" hyphenated → open_box', () =>
    expect(normalizeCondition('shelf-pull')).toBe('open_box'));
});

describe('normalizeCondition → as_is', () => {
  it('"As-Is" → as_is', () => expect(normalizeCondition('As-Is')).toBe('as_is'));
  it('"as is" with space → as_is', () => expect(normalizeCondition('as is')).toBe('as_is'));
  it('"AS IS" all-caps → as_is', () => expect(normalizeCondition('AS IS')).toBe('as_is'));
  it('"Damaged" → as_is', () => expect(normalizeCondition('Damaged')).toBe('as_is'));
  it('"For Parts" → as_is', () => expect(normalizeCondition('For Parts')).toBe('as_is'));
  it('"for-parts" hyphenated → as_is', () =>
    expect(normalizeCondition('for-parts')).toBe('as_is'));
  it('"Parts Only" → as_is', () => expect(normalizeCondition('Parts Only')).toBe('as_is'));
  it('"Broken" → as_is', () => expect(normalizeCondition('Broken')).toBe('as_is'));
  it('"Non-Functional" → as_is', () =>
    expect(normalizeCondition('Non-Functional')).toBe('as_is'));
  it('"Salvage" → as_is', () => expect(normalizeCondition('Salvage')).toBe('as_is'));
});

describe('normalizeCondition → good', () => {
  it('"good" exact → good', () => expect(normalizeCondition('good')).toBe('good'));
  it('"GOOD" all-caps → good', () => expect(normalizeCondition('GOOD')).toBe('good'));
  it('"fair" exact → good', () => expect(normalizeCondition('fair')).toBe('good'));
  it('"used" exact → good', () => expect(normalizeCondition('used')).toBe('good'));
  it('"Very Good" → good', () => expect(normalizeCondition('Very Good')).toBe('good'));
  it('"Tested" → good', () => expect(normalizeCondition('Tested')).toBe('good'));
  it('"Functional" → good', () => expect(normalizeCondition('Functional')).toBe('good'));
  it('"Working" → good', () => expect(normalizeCondition('Working')).toBe('good'));
});

describe('normalizeCondition — non-string primitives', () => {
  it('number 0 → null', () => expect(normalizeCondition(0)).toBeNull());
  it('boolean false → null', () => expect(normalizeCondition(false)).toBeNull());
  // Objects coerce to "[object Object]" which is unknown → null
  it('plain object → null', () => expect(normalizeCondition({})).toBeNull());
});
