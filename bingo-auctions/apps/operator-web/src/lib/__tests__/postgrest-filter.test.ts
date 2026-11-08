// The sanitiser that closes the /browse and /api/search/suggest filter
// injection (both public, unauthenticated, service-role). See
// lib/postgrest-filter.ts for the anatomy.

import { describe, expect, it } from 'vitest';
import { sanitizePostgrestPattern } from '../postgrest-filter';

describe('sanitizePostgrestPattern', () => {
  it('neutralises the proven exploit input', () => {
    // `?q=nomatch,title.ilike.` produced an always-true `title.ilike.%` OR
    // term on prod (2026-09-20). Stripping the comma is what breaks it: the
    // injected text can no longer open a new term in the or-group.
    expect(sanitizePostgrestPattern('nomatch,title.ilike.')).not.toContain(',');
  });

  it('strips every PostgREST structural metacharacter', () => {
    // `,` separates terms, `(` `)` group them, `|` is an alternate separator.
    // Any one of them left in lets a value restructure the filter.
    expect(sanitizePostgrestPattern('a,b')).toBe('a b');
    expect(sanitizePostgrestPattern('or(1.eq.1)')).toBe('or 1.eq.1 ');
    expect(sanitizePostgrestPattern('a|b')).toBe('a b');
    const out = sanitizePostgrestPattern('x,y(z)|w');
    for (const ch of [',', '(', ')', '|']) expect(out).not.toContain(ch);
  });

  it('keeps dots — they are ordinary in product names and safe in a value', () => {
    expect(sanitizePostgrestPattern('v1.2 adapter')).toBe('v1.2 adapter');
  });

  it('leaves an ordinary search untouched', () => {
    expect(sanitizePostgrestPattern('dewalt drill')).toBe('dewalt drill');
  });

  it('handles empty input', () => {
    expect(sanitizePostgrestPattern('')).toBe('');
  });
});
