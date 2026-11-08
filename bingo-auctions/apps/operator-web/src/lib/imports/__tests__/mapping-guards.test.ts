// The import wizard's value-level mapping checks.
//
// Jared, 2026-09-18: 1,369 lots came in titled "https://www.amazon.com/dp/…"
// because the operator mapped the "Amazon Link" column onto Title, and the
// wizard's only check was whether SOMETHING was mapped there. Three of those
// lots reached a scheduled, pre-bid-enabled auction.
//
// Each case below is one thing the guard has to get right, written against
// the shape of the real batch (bf0107e4, "STL3 116SZLMSG RETAIL.csv").
//
// Moved here from lib/__tests__/import-mapping-guard.test.ts when the Smart
// Import wizard these were written for was retired. The guards now live in
// lib/imports/mapping-guards.ts and take values rather than a mapping shape,
// so /imports/new — the wizard staff are sent to now, which had no
// equivalent check — can use them.

import { describe, it, expect } from 'vitest';
import {
  columnForField,
  findCodeCategoryProblem,
  findUrlTitleProblem,
} from '../mapping-guards.js';

const TITLE_COLUMN = 'Amazon Link';
const CATEGORY_COLUMN = 'category';

describe('findUrlTitleProblem', () => {
  it('catches the batch that caused this — every title a link', () => {
    const problem = findUrlTitleProblem(
      [
        'https://www.amazon.com/dp/B09HBFQ6D9',
        'https://www.amazon.com/dp/B0FCL4LZV9',
        'https://www.amazon.com/dp/B09S1D5MDP',
      ],
      TITLE_COLUMN,
    );
    expect(problem).not.toBeNull();
    expect(problem?.matched).toBe(3);
    expect(problem?.checked).toBe(3);
    // The message names the column the operator has to go and change.
    expect(problem?.column).toBe('Amazon Link');
    expect(problem?.sample).toBe('https://www.amazon.com/dp/B09HBFQ6D9');
  });

  it('passes a normal product-title column', () => {
    expect(
      findUrlTitleProblem(
        [
          'APEXUP 20lbs Weighted Vest Men Women',
          'A-Premium Air Conditioning Condenser Compatible with Kia Sedona',
          'BOSSIMA Indoor Outdoor High Back Rocking Chair Cushions',
        ],
        TITLE_COLUMN,
      ),
    ).toBeNull();
  });

  it('does not fire on one stray link among real titles', () => {
    // 1 in 5 = 20%, which is the threshold itself, not past it. A single
    // supplier row carrying a URL is a data quirk, not a mapping mistake.
    expect(
      findUrlTitleProblem(
        [
          'https://www.amazon.com/dp/B09HBFQ6D9',
          'APEXUP 20lbs Weighted Vest',
          'Kia Sedona AC Condenser',
          'Rocking Chair Cushion',
          'Wall Mounted Shower Seat',
        ],
        TITLE_COLUMN,
      ),
    ).toBeNull();
  });

  it('fires once a mostly-bad column is past the threshold', () => {
    // 2 in 5 = 40%. A mostly-wrong mapping must not ride in on clean rows.
    const problem = findUrlTitleProblem(
      [
        'https://www.amazon.com/dp/B09HBFQ6D9',
        'https://www.amazon.com/dp/B0FCL4LZV9',
        'APEXUP 20lbs Weighted Vest',
        'Kia Sedona AC Condenser',
        'Rocking Chair Cushion',
      ],
      TITLE_COLUMN,
    );
    expect(problem).not.toBeNull();
    expect(problem?.matched).toBe(2);
  });

  it('ignores rows with no title rather than counting them against the column', () => {
    // These are the "will be skipped (missing title)" rows, a separate
    // warning already. An empty cell says nothing about the mapping.
    const problem = findUrlTitleProblem(
      ['https://www.amazon.com/dp/B09HBFQ6D9', null, undefined, '', '   '],
      TITLE_COLUMN,
    );
    expect(problem?.checked).toBe(1);
    expect(problem?.matched).toBe(1);
  });

  it('returns null when there is nothing to check', () => {
    // Nothing mapped to title at all is the pre-existing titleAssigned
    // gate's job, not this one.
    expect(findUrlTitleProblem([null, undefined], null)).toBeNull();
    expect(findUrlTitleProblem([], TITLE_COLUMN)).toBeNull();
  });

  it('catches http as well as https', () => {
    expect(
      findUrlTitleProblem(['http://example.com/a', 'HTTPS://EXAMPLE.COM/B'], TITLE_COLUMN),
    ).not.toBeNull();
  });

  it('does not fire on a title that merely mentions a link', () => {
    // The pattern is anchored: only a value that STARTS with the scheme.
    expect(
      findUrlTitleProblem(
        [
          'Router with https setup guide',
          'Cable for http server rack',
          'Network switch, see https://x for specs',
        ],
        TITLE_COLUMN,
      ),
    ).toBeNull();
  });
});

describe('findCodeCategoryProblem', () => {
  it('catches the supplier codes from the same batch', () => {
    const problem = findCodeCategoryProblem(
      ['3000 Health Care', '32000 Woodworking', '0100 Pet Food & Feeding Supplies'],
      CATEGORY_COLUMN,
    );
    expect(problem).not.toBeNull();
    expect(problem?.column).toBe('category');
    expect(problem?.sample).toBe('3000 Health Care');
  });

  it('passes plain category names', () => {
    expect(
      findCodeCategoryProblem(['Home & Kitchen', 'Tools', 'Pet Supplies'], CATEGORY_COLUMN),
    ).toBeNull();
  });

  it('passes an Amazon breadcrumb path, which 0220 resolves leaf-first', () => {
    expect(
      findCodeCategoryProblem(
        ['Home & Kitchen › Furniture', 'Tools & Home Improvement › Hardware'],
        CATEGORY_COLUMN,
      ),
    ).toBeNull();
  });

  it('does not fire on a name that simply opens with a number', () => {
    // "2 Pack …" is a product category label, not a code. The pattern wants
    // 3-5 digits, so two-digit and single-digit leads stay clear.
    expect(
      findCodeCategoryProblem(['2 Pack Storage', '12 Volt Batteries'], CATEGORY_COLUMN),
    ).toBeNull();
  });
});

describe('columnForField', () => {
  // The manifest wizard maps one source column to MANY internal fields, so a
  // file with a single "Description" column can feed both title and
  // description. The guards have to be able to name the offending header
  // under that shape, not just the retired wizard's one-column-one-field.
  const MAPPING: Record<string, string[]> = {
    'Amazon Link': ['title'],
    Description: ['description'],
    category: ['category_raw'],
    'Item Number': ['upc', 'external_code'],
  };

  it('finds the column feeding a field', () => {
    expect(columnForField(MAPPING, 'title')).toBe('Amazon Link');
    expect(columnForField(MAPPING, 'category_raw')).toBe('category');
  });

  it('finds a column that feeds several fields', () => {
    expect(columnForField(MAPPING, 'external_code')).toBe('Item Number');
  });

  it('returns null when nothing feeds the field', () => {
    expect(columnForField(MAPPING, 'msrp_cents')).toBeNull();
    expect(columnForField({}, 'title')).toBeNull();
  });

  it('names the column end-to-end, the way the wizard calls it', () => {
    const titles = [
      'https://www.amazon.com/dp/B09HBFQ6D9',
      'https://www.amazon.com/dp/B0FCL4LZV9',
    ];
    const categories = ['21000 Outdoor Furniture', '5100 Women’s Contemporary'];
    expect(findUrlTitleProblem(titles, columnForField(MAPPING, 'title'))?.column).toBe(
      'Amazon Link',
    );
    expect(
      findCodeCategoryProblem(categories, columnForField(MAPPING, 'category_raw'))?.column,
    ).toBe('category');
  });
});
