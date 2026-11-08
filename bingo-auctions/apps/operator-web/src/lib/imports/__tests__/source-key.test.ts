// source-key.test.ts
//
// The failure these guard against is the one mig 0309 diagnosed and 0310
// fixed for the daily D2L feed, still open on the /imports/new path:
// commitImport upserted every row on (operator_id, tracking_number), which
// cannot fire for an untracked row because NULLs are distinct in a unique
// btree. Re-uploading a manifest without tracking numbers cloned every box
// in it — 18,297 rows standing in for 923 real units on the feed, +812/day.
//
// The assertions below are the properties the fix depends on:
//   1. the same file re-uploaded produces the same keys (dedup fires)
//   2. N identical units in one file keep N distinct keys (no over-dedup)
//   3. tracked rows carry no key (mig 0310's index is untracked-only)
//   4. chunk boundaries can't influence a key (the server sees slices)

import { describe, it, expect } from 'vitest';
import { assignSourceKeys, fnv1a64, identityTuple } from '../source-key.js';
import type { CommitInput } from '@/app/(operator)/imports/actions';

type Row = CommitInput['rows'][number];

function row(overrides: Partial<Row>): Row {
  return {
    title: 'Sample Item',
    tracking_number: null,
    quantity: 1,
    ...overrides,
  } as unknown as Row;
}

const FILE = { filename: 'wayfair_0918.csv' };

describe('fnv1a64', () => {
  it('is deterministic and 16 hex chars wide', () => {
    expect(fnv1a64('abc')).toBe(fnv1a64('abc'));
    expect(fnv1a64('abc')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates inputs that differ only in where a boundary falls', () => {
    expect(fnv1a64('a\u001fbc')).not.toBe(fnv1a64('ab\u001fc'));
  });
});

describe('identityTuple', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(identityTuple(row({ upc: ' 012345678905 ' }))).toBe(
      identityTuple(row({ upc: '012345678905' })),
    );
    expect(identityTuple(row({ title: 'DeWalt Drill' }))).toBe(
      identityTuple(row({ title: 'dewalt drill' })),
    );
  });

  it('ignores fields a manifest can restate for the same unit', () => {
    expect(identityTuple(row({ msrp_cents: 1000 }))).toBe(
      identityTuple(row({ msrp_cents: 9999 })),
    );
  });
});

describe('assignSourceKeys', () => {
  it('gives the same file the same keys on re-upload', () => {
    const rows = [row({ upc: '111' }), row({ upc: '222' }), row({ upc: '333' })];
    const first = assignSourceKeys(rows, FILE).map((r) => r.source_key);
    const second = assignSourceKeys(rows, FILE).map((r) => r.source_key);
    expect(second).toEqual(first);
    expect(first.every((k) => k?.startsWith('csv:'))).toBe(true);
  });

  it('keeps two identical units apart via the occurrence counter', () => {
    const rows = [row({ upc: '111' }), row({ upc: '111' }), row({ upc: '111' })];
    const keys = assignSourceKeys(rows, FILE).map((r) => r.source_key);
    expect(new Set(keys).size).toBe(3);
    expect(keys.map((k) => k?.split(':')[2])).toEqual(['0', '1', '2']);
  });

  it('leaves tracked rows unkeyed — mig 0310 is untracked-only', () => {
    const keyed = assignSourceKeys(
      [row({ tracking_number: '486572077526' }), row({ upc: '111' })],
      FILE,
    );
    expect(keyed[0]!.source_key).toBeNull();
    expect(keyed[1]!.source_key).not.toBeNull();
  });

  it('treats a whitespace-only tracking value as untracked', () => {
    const [only] = assignSourceKeys([row({ tracking_number: '   ' })], FILE);
    expect(only!.source_key).not.toBeNull();
  });

  it('does not depend on where the upload chunks the file', () => {
    const rows = [row({ upc: '111' }), row({ upc: '111' }), row({ upc: '222' })];
    const whole = assignSourceKeys(rows, FILE).map((r) => r.source_key);
    // Keying each chunk separately restarts the counter — the bug this
    // helper exists to prevent. Asserted so nobody "simplifies" the call
    // site into the chunk loop.
    const perChunk = [
      ...assignSourceKeys(rows.slice(0, 2), FILE),
      ...assignSourceKeys(rows.slice(2), FILE),
    ].map((r) => r.source_key);
    expect(new Set(whole).size).toBe(3);
    expect(perChunk).not.toEqual(whole);
  });

  it('scopes keys to the file, so next week’s manifest is not a duplicate', () => {
    const rows = [row({ upc: '111' })];
    const week1 = assignSourceKeys(rows, { filename: 'manifest_0911.csv' });
    const week2 = assignSourceKeys(rows, { filename: 'manifest_0918.csv' });
    expect(week2[0]!.source_key).not.toBe(week1[0]!.source_key);
  });

  it('does not mutate the rows it was handed', () => {
    const rows = [row({ upc: '111' })];
    assignSourceKeys(rows, FILE);
    expect('source_key' in rows[0]!).toBe(false);
  });
});
