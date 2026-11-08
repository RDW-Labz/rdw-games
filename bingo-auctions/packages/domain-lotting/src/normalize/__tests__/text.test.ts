// __tests__/text.test.ts
//
// Vitest tests for normalizeBrand(), normalizeModel(), normalizeTitle(),
// normalizeHeader() from text.ts.
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect } from 'vitest';

import { normalizeBrand, normalizeModel, normalizeTitle, normalizeHeader } from '../text';

// ---------------------------------------------------------------------------
// normalizeBrand
// ---------------------------------------------------------------------------

describe('normalizeBrand — null / sentinel inputs', () => {
  it('null → null', () => expect(normalizeBrand(null)).toBeNull());
  it('undefined → null', () => expect(normalizeBrand(undefined)).toBeNull());
  it('empty string → null', () => expect(normalizeBrand('')).toBeNull());
  it('"null" string → null', () => expect(normalizeBrand('null')).toBeNull());
  it('"NULL" uppercase → null', () => expect(normalizeBrand('NULL')).toBeNull());
  it('"N/A" → null', () => expect(normalizeBrand('N/A')).toBeNull());
  it('"n/a" lowercase → null', () => expect(normalizeBrand('n/a')).toBeNull());
  it('"unknown" → null', () => expect(normalizeBrand('unknown')).toBeNull());
  it('"UNKNOWN" → null', () => expect(normalizeBrand('UNKNOWN')).toBeNull());
  it('"none" → null', () => expect(normalizeBrand('none')).toBeNull());
  it('"-" dash → null', () => expect(normalizeBrand('-')).toBeNull());
  it('"--" double-dash → null', () => expect(normalizeBrand('--')).toBeNull());
  it('"not available" → null', () => expect(normalizeBrand('not available')).toBeNull());
  it('whitespace only → null', () => expect(normalizeBrand('   ')).toBeNull());
});

describe('normalizeBrand — happy path', () => {
  it('real brand preserved as-is', () => expect(normalizeBrand('DeWalt')).toBe('DeWalt'));
  it('trims leading/trailing whitespace', () =>
    expect(normalizeBrand('  Sony  ')).toBe('Sony'));
  it('preserves internal case (no lowercasing)', () =>
    expect(normalizeBrand('Black+Decker')).toBe('Black+Decker'));
  it('number coerces to string', () => expect(normalizeBrand(42)).toBe('42'));
  it('preserves special characters', () =>
    expect(normalizeBrand('AT&T')).toBe('AT&T'));
});

// ---------------------------------------------------------------------------
// normalizeModel
// ---------------------------------------------------------------------------

describe('normalizeModel — null / sentinel inputs', () => {
  it('null → null', () => expect(normalizeModel(null)).toBeNull());
  it('undefined → null', () => expect(normalizeModel(undefined)).toBeNull());
  it('empty string → null', () => expect(normalizeModel('')).toBeNull());
  it('"n/a" → null', () => expect(normalizeModel('n/a')).toBeNull());
  it('"na" → null', () => expect(normalizeModel('na')).toBeNull());
  it('"N.A." → null', () => expect(normalizeModel('N.A.')).toBeNull());
  it('"Not Applicable" → null', () => expect(normalizeModel('Not Applicable')).toBeNull());
});

describe('normalizeModel — happy path', () => {
  it('real model number preserved', () =>
    expect(normalizeModel('WH-1000XM4')).toBe('WH-1000XM4'));
  it('trims whitespace', () => expect(normalizeModel('  DCD771C2  ')).toBe('DCD771C2'));
  it('numeric string preserved', () => expect(normalizeModel('12345')).toBe('12345'));
  it('preserves slashes and dashes', () =>
    expect(normalizeModel('M18-FUEL-1/2')).toBe('M18-FUEL-1/2'));
});

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle — null / sentinel inputs', () => {
  it('null → null', () => expect(normalizeTitle(null)).toBeNull());
  it('undefined → null', () => expect(normalizeTitle(undefined)).toBeNull());
  it('empty string → null', () => expect(normalizeTitle('')).toBeNull());
  it('"null" string → null', () => expect(normalizeTitle('null')).toBeNull());
  it('"unknown" → null', () => expect(normalizeTitle('unknown')).toBeNull());
  it('whitespace only → null', () => expect(normalizeTitle('   ')).toBeNull());
});

describe('normalizeTitle — whitespace normalization', () => {
  it('trims leading/trailing', () =>
    expect(normalizeTitle('  DeWalt Drill  ')).toBe('DeWalt Drill'));
  it('collapses multiple internal spaces', () =>
    expect(normalizeTitle('DeWalt  20V   MAX  Drill')).toBe('DeWalt 20V MAX Drill'));
  it('collapses tabs as whitespace', () =>
    expect(normalizeTitle('DeWalt\t20V\tDrill')).toBe('DeWalt 20V Drill'));
  it('collapses newlines', () =>
    expect(normalizeTitle('DeWalt\n20V Drill')).toBe('DeWalt 20V Drill'));
  it('real title preserved correctly', () =>
    expect(
      normalizeTitle('Sony WH-1000XM4 Wireless Noise Cancelling Headphones'),
    ).toBe('Sony WH-1000XM4 Wireless Noise Cancelling Headphones'));
});

describe('normalizeTitle — non-string primitives', () => {
  it('number coerces to string', () => expect(normalizeTitle(42)).toBe('42'));
});

// ---------------------------------------------------------------------------
// normalizeHeader
// ---------------------------------------------------------------------------

describe('normalizeHeader — lowercasing and trim', () => {
  it('lowercases input', () => expect(normalizeHeader('Retail')).toBe('retail'));
  it('trims leading space (Amazon-style headers)', () =>
    expect(normalizeHeader(' Retail ')).toBe('retail'));
  it('trims and lowercases compound header', () =>
    expect(normalizeHeader(' Ext Retail ')).toBe('ext retail'));
  it('collapses internal spaces', () =>
    expect(normalizeHeader('Product  Title')).toBe('product title'));
  it('empty string → empty string', () => expect(normalizeHeader('')).toBe(''));
  it('already lowercase and trimmed → unchanged', () =>
    expect(normalizeHeader('lot number')).toBe('lot number'));
});

describe('normalizeHeader — zero-width character stripping', () => {
  // Zero-width space (U+200B), zero-width non-joiner (U+200C), zero-width joiner (U+200D), BOM (U+FEFF)
  it('strips zero-width space', () =>
    expect(normalizeHeader('​Retail')).toBe('retail'));
  it('strips BOM character', () =>
    expect(normalizeHeader('﻿Retail')).toBe('retail'));
  it('strips zero-width non-joiner', () =>
    expect(normalizeHeader('Re‌tail')).toBe('retail'));
  it('strips zero-width joiner', () =>
    expect(normalizeHeader('Re‍tail')).toBe('retail'));
});
