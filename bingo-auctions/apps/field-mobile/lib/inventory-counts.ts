/** Worklist filter-pill counts — shape matches useInventoryList success state. */
export type StaffInventoryCounts = {
  draft: number;
  pending_intake: number;
  in_inventory: number;
  unsold: number;
  forfeited: number;
  flagged: number;
};

export const EMPTY_STAFF_INVENTORY_COUNTS: StaffInventoryCounts = {
  draft: 0,
  pending_intake: 0,
  in_inventory: 0,
  unsold: 0,
  forfeited: 0,
  flagged: 0,
};

export const INVENTORY_SEARCH_DEBOUNCE_MS = 300;

/** Map `staff_inventory_counts()` jsonb to pill numbers; missing keys → 0. */
export function mapStaffInventoryCountsJson(raw: unknown): StaffInventoryCounts {
  if (raw == null || typeof raw !== 'object') {
    return { ...EMPTY_STAFF_INVENTORY_COUNTS };
  }
  const o = raw as Record<string, unknown>;
  return {
    draft: coerceCount(o.draft),
    pending_intake: coerceCount(o.pending_intake),
    in_inventory: coerceCount(o.in_inventory),
    unsold: coerceCount(o.unsold),
    forfeited: coerceCount(o.forfeited),
    flagged: coerceCount(o.flagged),
  };
}

function coerceCount(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return 0;
}

type TimerFns = {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

/** Trailing-edge debounce for search text (testable with injected timers). */
export function createTrailingDebounce(
  delayMs: number,
  onDebounced: (value: string) => void,
  timers: TimerFns = { setTimeout, clearTimeout },
): {
  schedule: (value: string) => void;
  cancel: () => void;
  flush: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  const fire = () => {
    if (pending === null) return;
    const value = pending;
    pending = null;
    onDebounced(value);
  };

  return {
    schedule(value: string) {
      pending = value;
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = null;
        fire();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = null;
    },
    flush() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      fire();
    },
  };
}
