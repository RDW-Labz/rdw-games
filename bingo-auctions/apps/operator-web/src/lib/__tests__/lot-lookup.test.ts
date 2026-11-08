// #773 — lot lookup by product title. Follow-ups from the RED TEAM PASS in #775.
//
// The pure helpers carry the security-critical part (PostgREST pattern
// escaping), the resolver outcomes the page is allowed to act on, and the
// staged-bin location. The source scan locks the ordering the acceptance
// criteria name: an exact code lookup must run before, and win over, the title
// search.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  candidatesFor,
  classifyCodeLookup,
  classifyTitleSearchAuth,
  formatLookupLocation,
  LOCATION_UNAVAILABLE_LABEL,
  LOT_LOOKUP_MAX_INPUT,
  lookupLocation,
  lookupRetryHref,
  lotTitleQuery,
  LOOKUP_MESSAGES,
  parseLotLookupInput,
  toAssignmentResult,
} from '../lot-lookup';

describe('parseLotLookupInput', () => {
  it('trims and treats a missing value as empty', () => {
    expect(parseLotLookupInput('  VEVOR ice maker  ')).toBe('VEVOR ice maker');
    expect(parseLotLookupInput(undefined)).toBe('');
    expect(parseLotLookupInput('   ')).toBe('');
  });

  it('takes the first value when Next supplies an array', () => {
    expect(parseLotLookupInput(['first', 'second'])).toBe('first');
  });

  it('caps the input length', () => {
    expect(parseLotLookupInput('x'.repeat(LOT_LOOKUP_MAX_INPUT + 50))).toHaveLength(
      LOT_LOOKUP_MAX_INPUT,
    );
  });
});

describe('candidatesFor', () => {
  it('offers case and whitespace variants without duplicates', () => {
    expect(candidatesFor('pnk-485-9989')).toEqual(['pnk-485-9989', 'PNK-485-9989']);
    expect(candidatesFor('BRN:4982227')).toEqual(['BRN:4982227']);
    expect(candidatesFor('  brn: 4982227 ')).toEqual([
      'brn: 4982227',
      'BRN: 4982227',
      'brn:4982227',
      'BRN:4982227',
    ]);
  });

  it('returns no candidates for blank input', () => {
    expect(candidatesFor('   ')).toEqual([]);
  });
});

describe('classifyCodeLookup', () => {
  it('redirects only on a real lot id', () => {
    expect(classifyCodeLookup({ ok: true, lot: { id: 'lot-1' } })).toEqual({
      kind: 'lot',
      lotId: 'lot-1',
    });
  });

  it('treats lot_not_found as the only authoritative miss', () => {
    expect(classifyCodeLookup({ ok: false, reason: 'lot_not_found' })).toEqual({
      kind: 'miss',
    });
  });

  it('reports auth and nonstaff outcomes as errors, not a miss', () => {
    expect(classifyCodeLookup({ ok: false, reason: 'not_authenticated' })).toEqual({
      kind: 'error',
      message: LOOKUP_MESSAGES.session,
    });
    expect(classifyCodeLookup({ ok: false, reason: 'not_operator_staff' })).toEqual({
      kind: 'error',
      message: LOOKUP_MESSAGES.operator,
    });
  });

  it('fails closed on malformed, empty and ok-without-lot responses', () => {
    for (const result of [null, undefined, {}, { ok: true }, { ok: true, lot: null }, 'boom']) {
      expect(classifyCodeLookup(result)).toEqual({
        kind: 'error',
        message: LOOKUP_MESSAGES.code,
      });
    }
  });
});

describe('classifyTitleSearchAuth', () => {
  it('is ready only with a real user and no auth error', () => {
    expect(classifyTitleSearchAuth({ id: 'user-1' }, null)).toEqual({
      kind: 'ready',
      userId: 'user-1',
    });
  });

  it('shows an auth state for failed or expired sessions, never an empty miss', () => {
    expect(classifyTitleSearchAuth(null, new Error('network'))).toEqual({
      kind: 'error',
      message: LOOKUP_MESSAGES.session,
    });
    expect(classifyTitleSearchAuth(null, null)).toEqual({
      kind: 'error',
      message: LOOKUP_MESSAGES.session,
    });
    expect(classifyTitleSearchAuth({ id: null }, null)).toEqual({
      kind: 'error',
      message: LOOKUP_MESSAGES.session,
    });
  });
});

describe('lotTitleQuery', () => {
  it('returns null for empty or punctuation-only input', () => {
    for (const raw of ['', '   ', '()', '---', ', | ( )', '...', '___', '*']) {
      expect(lotTitleQuery(raw)).toBeNull();
    }
  });

  it('builds a case-insensitive contains pattern for ordinary titles', () => {
    expect(lotTitleQuery('VEVOR Ice')).toEqual({ operator: 'ilike', pattern: '%VEVOR Ice%' });
  });

  it('never lets a title add PostgREST filter structure', () => {
    const query = lotTitleQuery('nomatch,title.ilike.');
    expect(query).toEqual({ operator: 'ilike', pattern: '%nomatch%title.ilike.%' });
    expect(query?.pattern).not.toMatch(/[,()|]/);
  });

  it('keeps a pasted punctuated title matching itself', () => {
    expect(lotTitleQuery('VEVOR Ice-maker (LB-Series)')).toEqual({
      operator: 'ilike',
      pattern: '%VEVOR Ice-maker %LB-Series%',
    });
    expect(lotTitleQuery('Tools, Hardware | Garden')).toEqual({
      operator: 'ilike',
      pattern: '%Tools% Hardware % Garden%',
    });
    expect(lotTitleQuery('(LB-Series)')).toEqual({ operator: 'ilike', pattern: '%LB-Series%' });
    expect(lotTitleQuery('--- VE( VOR )---')).toEqual({
      operator: 'ilike',
      pattern: '%--- VE% VOR %---%',
    });
  });

  it('escapes ILIKE wildcards and backslashes', () => {
    expect(lotTitleQuery('100%_off')).toEqual({ operator: 'ilike', pattern: '%100\\%\\_off%' });
    expect(lotTitleQuery('a\\b')).toEqual({ operator: 'ilike', pattern: '%a\\\\b%' });
  });

  it('matches a literal asterisk instead of letting PostgREST alias it to %', () => {
    expect(lotTitleQuery('a_b%c*')).toEqual({ operator: 'imatch', pattern: 'a_b%c\\*' });
    expect(lotTitleQuery('Special * (LB)')).toEqual({
      operator: 'imatch',
      pattern: 'Special \\* .*LB',
    });
  });

  it('escapes every regex metacharacter in a star title', () => {
    expect(lotTitleQuery('(v1.2) [x] a+b?*')).toEqual({
      operator: 'imatch',
      pattern: 'v1\\.2.* \\[x\\] a\\+b\\?\\*',
    });
    expect(lotTitleQuery('a\\b*')).toEqual({ operator: 'imatch', pattern: 'a\\\\b\\*' });
  });
});

describe('formatLookupLocation', () => {
  const intake = { code: 'A1', aisle: '1', bay: '2' };
  const staged = { code: 'B2', aisle: '3', bay: null };

  it('prefers the latest staged pickup bin over the intake bin', () => {
    expect(formatLookupLocation('Bentonville', intake, { status: 'staged', bins: staged })).toBe(
      'Bentonville · Bin B2 (Aisle 3) · staged for pickup',
    );
  });

  it('falls back to intake when there is no staging', () => {
    expect(formatLookupLocation('Bentonville', intake, null)).toBe(
      'Bentonville · Bin A1 (Aisle 1 / Bay 2)',
    );
  });

  it('falls back to intake after pickup', () => {
    expect(formatLookupLocation('Bentonville', intake, { status: 'picked_up', bins: staged })).toBe(
      'Bentonville · Bin A1 (Aisle 1 / Bay 2)',
    );
  });

  it("uses the staged bin's warehouse when it differs from the intake warehouse", () => {
    const stagedElsewhere = { ...staged, warehouses: { name: 'Harrison' } };
    expect(
      formatLookupLocation('Bentonville', intake, { status: 'staged', bins: stagedElsewhere }),
    ).toBe('Harrison · Bin B2 (Aisle 3) · staged for pickup');
  });

  it("never pairs another warehouse's bin with the intake warehouse name", () => {
    const duplicateCode = { code: 'A1', aisle: '1', bay: '2' };
    const stagedHarrison = { ...duplicateCode, warehouses: [{ name: 'Harrison' }] };
    expect(
      formatLookupLocation('Bentonville', intake, { status: 'staged', bins: stagedHarrison }),
    ).toBe('Harrison · Bin A1 (Aisle 1 / Bay 2) · staged for pickup');
  });

  it('handles a missing bin, warehouse and embedded array', () => {
    expect(formatLookupLocation('Bentonville', null, null)).toBe('Bentonville');
    expect(formatLookupLocation(null, null, null)).toBe('—');
    expect(formatLookupLocation(null, intake, { status: 'staged', bins: [staged] })).toBe(
      'Bin B2 (Aisle 3) · staged for pickup',
    );
  });
});

describe('toAssignmentResult', () => {
  const staged = { code: 'B2', aisle: '3', bay: null };

  it('keeps a successful assignment row', () => {
    expect(toAssignmentResult([{ status: 'staged', bins: staged }], null)).toEqual({
      kind: 'ok',
      assignment: { status: 'staged', bins: staged },
    });
  });

  it('keeps a successful empty result distinct from an error', () => {
    expect(toAssignmentResult([], null)).toEqual({ kind: 'ok', assignment: null });
    expect(toAssignmentResult(null, null)).toEqual({ kind: 'ok', assignment: null });
    expect(toAssignmentResult(undefined, undefined)).toEqual({ kind: 'ok', assignment: null });
  });

  it('reports timeout, network, RLS and partial-data-plus-error responses as errors', () => {
    const errors = [
      { message: 'timeout' },
      new Error('network'),
      { message: 'permission denied for table bin_assignments', code: '42501' },
    ];
    for (const error of errors) {
      expect(toAssignmentResult([{ status: 'staged', bins: staged }], error)).toEqual({
        kind: 'error',
      });
    }
  });
});

describe('lookupLocation', () => {
  const intake = { code: 'A1', aisle: '1', bay: '2' };
  const staged = { code: 'B2', aisle: '3', bay: null };

  it('shows intake only after a successful empty assignment result', () => {
    expect(lookupLocation('Bentonville', intake, { kind: 'ok', assignment: null })).toEqual({
      kind: 'known',
      label: 'Bentonville · Bin A1 (Aisle 1 / Bay 2)',
    });
    expect(lookupLocation('Bentonville', intake, undefined)).toEqual({
      kind: 'known',
      label: 'Bentonville · Bin A1 (Aisle 1 / Bay 2)',
    });
  });

  it('marks the location unavailable when the assignment query failed', () => {
    expect(lookupLocation('Bentonville', intake, { kind: 'error' })).toEqual({
      kind: 'unavailable',
    });
  });

  it('keeps good rows good when another row failed', () => {
    const good = lookupLocation('Bentonville', intake, {
      kind: 'ok',
      assignment: { status: 'staged', bins: staged },
    });
    const bad = lookupLocation('Bentonville', intake, { kind: 'error' });
    expect(good).toEqual({
      kind: 'known',
      label: 'Bentonville · Bin B2 (Aisle 3) · staged for pickup',
    });
    expect(bad).toEqual({ kind: 'unavailable' });
    expect(LOCATION_UNAVAILABLE_LABEL).toBe('Location unavailable — retry');
  });
});

describe('lookupRetryHref', () => {
  it('retries the same lookup with an encoded value', () => {
    expect(lookupRetryHref('VEVOR & Co')).toBe('/lots/lookup?code=VEVOR%20%26%20Co');
  });
});

describe('#775 source wiring — code lookup wins, errors stay honest', () => {
  const PAGE = path.resolve(__dirname, '../../app/(operator)/lots/lookup/page.tsx');
  const source = readFileSync(PAGE, 'utf8');

  it('runs the exact code resolver before the title query', () => {
    const codeAt = source.indexOf('staff_scan_lot_owner');
    const titleAt = source.indexOf("from('lots')");
    expect(codeAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(-1);
    expect(codeAt).toBeLessThan(titleAt);
  });

  it('redirects on a code hit before reaching the title query', () => {
    const redirectAt = source.indexOf('redirect(`/lots/${resolution.lotId}`)');
    const titleAt = source.indexOf("from('lots')");
    expect(redirectAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeLessThan(titleAt);
  });

  it('only starts the title fallback when the resolver did not error', () => {
    expect(source).toContain('classifyCodeLookup(codeData)');
    expect(source).toContain('const titleQuery = lookupError ? null : lotTitleQuery(raw);');
    expect(source).toContain('classifyTitleSearchAuth(user, userError)');
  });

  it('distinguishes an operator-lookup failure from an unlinked account', () => {
    expect(source).toContain('LOOKUP_MESSAGES.operatorLookup');
    expect(source).toContain('} else if (!operatorId) {');
  });

  it('scopes title results to the signed-in operator and live rows', () => {
    expect(source).toContain(".eq('operator_id', operatorId)");
    expect(source).toContain(".is('deleted_at', null)");
    expect(source).toContain(".filter('title', titleQuery.operator, titleQuery.pattern)");
    expect(source).toContain('.limit(LOT_LOOKUP_LIMIT)');
  });

  it('reads the latest qualifying assignment per displayed lot, not one global page', () => {
    expect(source).toContain("from('bin_assignments')");
    expect(source).toContain(".eq('lot_id', lot.id)");
    expect(source).toContain(".in('status', ['staged', 'picked_up'])");
    expect(source).toContain('.limit(1)');
    expect(source).not.toContain(".in('lot_id', titleMatches.map");
    expect(source).toContain('toAssignmentResult(');
  });

  it('shows unavailable locations with a retry and reads the staged warehouse', () => {
    expect(source).toContain('lookupLocation(');
    expect(source).toContain('lookupRetryHref(raw)');
    expect(source).toContain('LOCATION_UNAVAILABLE_LABEL');
    expect(source).toContain('warehouses(name)');
  });
});
