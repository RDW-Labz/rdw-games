// Unshelved drafts on the staff worker reports (mig 0420).
//
// A draft lotted but not yet put away (pending_intake, no warehouse) counts
// under "All locations" and under no warehouse. Oct 13: Tim read 41 under All
// and 36 under Crandall, Lane 36 vs 30, with 11 drafts unshelved. Both RPCs now
// return the worker's unshelved count independently of the location filter, so
// for every worker:
//
//   All locations = sum of every location + Unshelved
//
// On a location view the unshelved number is shown BESIDE the location's
// numbers, labelled, never added into them. Before 0420 is applied the field
// is absent; `hasUnshelved` is then false and the pages hide the column, so the
// page and the migration can ship in either order.

/** One worker × day cell from worker_daily_productivity(). */
export interface DailyCell {
  worker_id: string;
  display_name: string;
  is_active: boolean;
  day: string;
  lots: number | string;
  /** 0420+. The worker's lots that day with no warehouse, whatever location is selected. */
  unshelved?: number | string | null;
}

export interface DailyWorkerRow {
  workerId: string;
  name: string;
  active: boolean;
  counts: Map<string, number>;
  /** Sum of `counts` over the window — the selected location's lots. */
  total: number;
  /** The worker's unshelved drafts over the window. */
  unshelved: number;
}

export interface DailyReport {
  dayList: string[];
  rows: DailyWorkerRow[];
  dayTotals: Map<string, number>;
  grandTotal: number;
  unshelvedTotal: number;
  /** False when the function predates 0420 (no unshelved field). */
  hasUnshelved: boolean;
}

export function buildDailyReport(cells: DailyCell[]): DailyReport {
  const dayList = [...new Set(cells.map((c) => c.day))].sort();
  const hasUnshelved = cells.some((c) => c.unshelved !== undefined);
  const byWorker = new Map<string, DailyWorkerRow>();
  for (const c of cells) {
    let w = byWorker.get(c.worker_id);
    if (!w) {
      w = {
        workerId: c.worker_id,
        name: c.display_name,
        active: c.is_active,
        counts: new Map(),
        total: 0,
        unshelved: 0,
      };
      byWorker.set(c.worker_id, w);
    }
    const n = Number(c.lots) || 0;
    w.counts.set(c.day, n);
    w.total += n;
    w.unshelved += Number(c.unshelved ?? 0) || 0;
  }

  const rows = [...byWorker.values()]
    // Busiest first, but anyone who lotted nothing in the window drops to the
    // bottom rather than being hidden — a picker on zero for a fortnight is
    // exactly what a supervisor wants to notice.
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const dayTotals = new Map(
    dayList.map((d) => [d, rows.reduce((sum, r) => sum + (r.counts.get(d) ?? 0), 0)]),
  );
  return {
    dayList,
    rows,
    dayTotals,
    grandTotal: rows.reduce((s, r) => s + r.total, 0),
    unshelvedTotal: rows.reduce((s, r) => s + r.unshelved, 0),
    hasUnshelved,
  };
}

/** Header + tooltip for the Unshelved column. On All locations the drafts are
 *  already inside the totals; on a location they are not, and the label has to
 *  say so or a supervisor will add them in (or think they were). */
export function unshelvedColumnCopy(locationSelected: boolean): { header: string; title: string } {
  return locationSelected
    ? {
        header: '+ Unshelved',
        title:
          'Drafts this worker lotted that have no location yet (not put away). NOT counted in ' +
          "this location's numbers. All locations = every location + Unshelved.",
      }
    : {
        header: 'of which unshelved',
        title:
          'Drafts with no location yet (not put away). Included in the totals here, and in no ' +
          'single location — so All locations = every location + Unshelved.',
      };
}
