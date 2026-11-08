import { describe, expect, it } from 'vitest';
import {
  buildDailyReport,
  unshelvedColumnCopy,
  type DailyCell,
} from '../worker-report-unshelved';

// Simulates worker_daily_productivity() (mig 0420) over a fixed set of lots, so
// the page helper is checked against the same rule the SQL test pins:
//   All locations = sum of every location + Unshelved, per worker.
type Lot = { worker: string; day: string; warehouse: string | null };
const WORKERS = [
  { id: 'w-tim', name: 'Tim' },
  { id: 'w-lane', name: 'Lane' },
  { id: 'w-idle', name: 'Idle' },
];
const DAYS = ['2026-10-12', '2026-10-13'];

function rpc(lots: Lot[], warehouseId: string | null): DailyCell[] {
  return WORKERS.flatMap((w) =>
    DAYS.map((day) => {
      const mine = lots.filter((l) => l.worker === w.id && l.day === day);
      return {
        worker_id: w.id,
        display_name: w.name,
        is_active: true,
        day,
        // bigint arrives as a string from PostgREST on some paths
        lots: String(mine.filter((l) => warehouseId === null || l.warehouse === warehouseId).length),
        unshelved: mine.filter((l) => l.warehouse === null).length,
      };
    }),
  );
}

function lotsOf(worker: string, day: string, warehouse: string | null, n: number): Lot[] {
  return Array.from({ length: n }, () => ({ worker, day, warehouse }));
}

// The Oct 13 shape: Tim 36 Crandall + 5 drafts = 41; Lane 30 + 6 = 36; 11 drafts.
const LOTS: Lot[] = [
  ...lotsOf('w-tim', '2026-10-13', 'crandall', 36),
  ...lotsOf('w-tim', '2026-10-13', null, 5),
  ...lotsOf('w-lane', '2026-10-13', 'crandall', 30),
  ...lotsOf('w-lane', '2026-10-13', null, 6),
  ...lotsOf('w-lane', '2026-10-12', 'harrison', 4),
  ...lotsOf('w-tim', '2026-10-12', null, 2),
];
const WAREHOUSES = ['crandall', 'harrison'];

describe('buildDailyReport — unshelved invariant', () => {
  const all = buildDailyReport(rpc(LOTS, null));
  const perWh = WAREHOUSES.map((id) => buildDailyReport(rpc(LOTS, id)));

  it('sum(locations) + unshelved = All locations, per worker', () => {
    for (const row of all.rows) {
      const whSum = perWh.reduce(
        (s, r) => s + (r.rows.find((x) => x.workerId === row.workerId)?.total ?? 0),
        0,
      );
      expect(whSum + row.unshelved).toBe(row.total);
    }
  });

  it('sum(locations) + unshelved = All locations, grand total', () => {
    const whSum = perWh.reduce((s, r) => s + r.grandTotal, 0);
    expect(whSum + all.unshelvedTotal).toBe(all.grandTotal);
    expect(all.grandTotal).toBe(83);
    expect(all.unshelvedTotal).toBe(13);
  });

  it('reproduces the Oct 13 numbers and does not fold drafts into a location', () => {
    const crandall = perWh[0]!;
    const tim = (r: typeof all) => r.rows.find((x) => x.name === 'Tim')!;
    expect(tim(all).counts.get('2026-10-13')).toBe(41);
    expect(tim(crandall).counts.get('2026-10-13')).toBe(36);
    // unshelved is the same whichever location is selected
    expect(tim(crandall).unshelved).toBe(tim(all).unshelved);
    expect(tim(all).unshelved).toBe(7);
  });

  it('keeps zero-lot workers, busiest first', () => {
    expect(all.rows.map((r) => r.name)).toEqual(['Tim', 'Lane', 'Idle']);
    expect(all.dayList).toEqual(DAYS);
    expect(all.hasUnshelved).toBe(true);
  });
});

describe('buildDailyReport — before mig 0420', () => {
  it('reports hasUnshelved=false when the field is absent', () => {
    const cells = rpc(LOTS, null).map(({ unshelved: _u, ...c }) => c);
    const r = buildDailyReport(cells);
    expect(r.hasUnshelved).toBe(false);
    expect(r.unshelvedTotal).toBe(0);
    expect(r.grandTotal).toBe(83);
  });
});

describe('unshelvedColumnCopy', () => {
  it('says "not counted" on a location and "included" on All', () => {
    expect(unshelvedColumnCopy(true).header).toBe('+ Unshelved');
    expect(unshelvedColumnCopy(true).title).toMatch(/NOT counted/);
    expect(unshelvedColumnCopy(false).header).toBe('of which unshelved');
    expect(unshelvedColumnCopy(false).title).toMatch(/Included/);
  });
});
