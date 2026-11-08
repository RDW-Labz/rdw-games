// How the search box becomes a PostgREST `.or(...)` filter on /browse and
// /api/search/suggest.
//
// The first version of search-limits.ts returned nothing below 3 characters, so
// "TV" found no TVs. These tests pin the replacement: short queries match word
// prefixes, longer ones match substrings, and user text never adds a filter term.

import { describe, expect, it } from 'vitest';
import { MIN_SUBSTRING_CHARS, lotSearchFilter, searchOrFilter } from '../search-limits';

const terms = (filter: string | null) => (filter ?? '').split(',');

describe('lotSearchFilter', () => {
  it('finds TVs: a 2-character query matches word prefixes in the title', () => {
    expect(lotSearchFilter('TV')).toBe(
      'title.ilike.TV%,title.ilike.% TV%,title.ilike.%-TV%',
    );
  });

  it('a 1-character query is a word-prefix search too, not an empty page', () => {
    expect(lotSearchFilter('a')).toBe('title.ilike.a%,title.ilike.% a%,title.ilike.%-a%');
  });

  it('3+ characters search substrings across the title and both codes', () => {
    expect(MIN_SUBSTRING_CHARS).toBe(3);
    expect(lotSearchFilter('tvs')).toBe(
      'title.ilike.%tvs%,lot_code.ilike.%tvs%,sticker_code.ilike.%tvs%',
    );
  });

  it('leaves codes out of short searches (no code is that short)', () => {
    expect(lotSearchFilter('BI')).not.toMatch(/lot_code|sticker_code/);
  });

  it('measures the trimmed length', () => {
    expect(lotSearchFilter('  tv  ')).toBe(lotSearchFilter('tv'));
    expect(lotSearchFilter('  abc  ')).toBe(lotSearchFilter('abc'));
  });

  it('returns null when nothing is left to search', () => {
    expect(lotSearchFilter(null)).toBeNull();
    expect(lotSearchFilter(undefined)).toBeNull();
    expect(lotSearchFilter('   ')).toBeNull();
    expect(lotSearchFilter(',()|')).toBeNull();
  });

  it('never lets user text add a term to the or-group, at either length', () => {
    // 2026-09-20: ?q=nomatch,title.ilike. made one term `title.ilike.%` (always true).
    expect(terms(lotSearchFilter('t,'))).toHaveLength(3);
    expect(terms(lotSearchFilter('nomatch,title.ilike.'))).toHaveLength(3);
    expect(terms(lotSearchFilter('x),or(id.eq.1'))).toHaveLength(3);
    for (const f of [lotSearchFilter('t,'), lotSearchFilter('nomatch,title.ilike.')]) {
      expect(f).not.toMatch(/[()|]/);
    }
  });
});

describe('searchOrFilter', () => {
  it('builds the category-name filter the same way', () => {
    expect(searchOrFilter('tv', { text: ['name'] })).toBe(
      'name.ilike.tv%,name.ilike.% tv%,name.ilike.%-tv%',
    );
    expect(searchOrFilter('toys', { text: ['name'] })).toBe('name.ilike.%toys%');
  });
});
