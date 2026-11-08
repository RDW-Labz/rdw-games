import { describe, it, expect } from 'vitest';
import { compareLocation, locationComparator, type LocationLike } from '../location-sort';

function loc(locationCode: string | null, warehouseName: string | null = null, tieBreak = 'T0'): LocationLike {
  return { warehouseName, locationCode, tieBreak };
}

function sorted(codes: string[]): string[] {
  return codes
    .map((c) => loc(c))
    .sort(compareLocation)
    .map((l) => l.locationCode as string);
}

describe('compareLocation — numeric segments', () => {
  it('sorts 2 before 10 (not lexicographically)', () => {
    expect(sorted(['2-01-01', '10-01-01'])).toEqual(['2-01-01', '10-01-01']);
  });

  it('sorts a run of aisle numbers numerically', () => {
    expect(sorted(['12-01-01', '2-01-01', '1-01-01', '10-01-01'])).toEqual([
      '1-01-01',
      '2-01-01',
      '10-01-01',
      '12-01-01',
    ]);
  });

  it('compares bay before shelf when aisle ties: 2-14-01 vs 2-2-01', () => {
    expect(sorted(['2-14-01', '2-2-01'])).toEqual(['2-2-01', '2-14-01']);
  });

  it('compares shelf when aisle and bay tie', () => {
    expect(sorted(['4-06-10', '4-06-02'])).toEqual(['4-06-02', '4-06-10']);
  });

  it('is stable across already-padded codes', () => {
    expect(sorted(['12-12-01', '2-14-01'])).toEqual(['2-14-01', '12-12-01']);
  });
});

describe('compareLocation — numeric vs named aisles', () => {
  it('puts numeric aisles before named aisles: Right-01-06 vs 5-07-01', () => {
    expect(sorted(['Right-01-06', '5-07-01'])).toEqual(['5-07-01', 'Right-01-06']);
  });

  it('orders named aisles alphabetically, case-insensitively', () => {
    expect(sorted(['Right-01-01', 'left-01-01', 'Middle-01-01'])).toEqual([
      'left-01-01',
      'Middle-01-01',
      'Right-01-01',
    ]);
  });

  it('mixes numeric and named aisles: numeric block first, in value order, then named alphabetically', () => {
    expect(sorted(['Right-01-01', '10-01-01', 'Left-01-01', '2-01-01'])).toEqual([
      '2-01-01',
      '10-01-01',
      'Left-01-01',
      'Right-01-01',
    ]);
  });
});

describe('compareLocation — nulls and empties', () => {
  it('sorts null location after any located row', () => {
    expect(sorted(['2-01-01', null as unknown as string])).toEqual(['2-01-01', null as unknown as string]);
  });

  it('sorts empty-string location after any located row', () => {
    const rows = [loc('5-01-01'), loc('')];
    rows.sort(compareLocation);
    expect(rows.map((r) => r.locationCode)).toEqual(['5-01-01', '']);
  });

  it('keeps multiple null-location rows in tie-break order', () => {
    const rows = [
      { warehouseName: null, locationCode: null, tieBreak: 'B' },
      { warehouseName: null, locationCode: null, tieBreak: 'A' },
    ];
    rows.sort(compareLocation);
    expect(rows.map((r) => r.tieBreak)).toEqual(['A', 'B']);
  });

  it('a less-specific code (fewer segments) sorts before a more-specific one sharing a prefix', () => {
    expect(sorted(['2-01-01', '2-01'])).toEqual(['2-01', '2-01-01']);
  });
});

describe('compareLocation — warehouse grouping', () => {
  it('groups by warehouse before location, so warehouses never interleave', () => {
    const rows: LocationLike[] = [
      loc('10-01-01', 'Springdale'),
      loc('1-01-01', 'Bentonville'),
      loc('2-01-01', 'Bentonville'),
      loc('1-01-01', 'Springdale'),
    ];
    rows.sort(compareLocation);
    expect(rows.map((r) => `${r.warehouseName}:${r.locationCode}`)).toEqual([
      'Bentonville:1-01-01',
      'Bentonville:2-01-01',
      'Springdale:1-01-01',
      'Springdale:10-01-01',
    ]);
  });

  it('sorts a missing/null warehouse name after any named warehouse', () => {
    const rows: LocationLike[] = [loc('1-01-01', null), loc('1-01-01', 'Bentonville')];
    rows.sort(compareLocation);
    expect(rows.map((r) => r.warehouseName)).toEqual(['Bentonville', null]);
  });
});

describe('compareLocation — tie-break', () => {
  it('falls back to the tie-break string when warehouse and location are equal', () => {
    const rows: LocationLike[] = [
      loc('2-01-01', 'Bentonville', 'BRN0002'),
      loc('2-01-01', 'Bentonville', 'BRN0001'),
    ];
    rows.sort(compareLocation);
    expect(rows.map((r) => r.tieBreak)).toEqual(['BRN0001', 'BRN0002']);
  });

  it('is a stable, pure function — same inputs, same result, no mutation of inputs', () => {
    const a = loc('2-01-01', 'Bentonville', 'X');
    const b = loc('2-01-01', 'Bentonville', 'X');
    expect(compareLocation(a, b)).toBe(0);
    expect(a).toEqual(loc('2-01-01', 'Bentonville', 'X'));
  });
});

describe('locationComparator', () => {
  it('adapts an arbitrary row shape to compareLocation', () => {
    type Row = { wh: string | null; code: string | null; code2: string };
    const rows: Row[] = [
      { wh: 'A', code: '10-01-01', code2: 'z' },
      { wh: 'A', code: '2-01-01', code2: 'a' },
    ];
    rows.sort(locationComparator((r) => ({ warehouseName: r.wh, locationCode: r.code, tieBreak: r.code2 })));
    expect(rows.map((r) => r.code)).toEqual(['2-01-01', '10-01-01']);
  });
});
