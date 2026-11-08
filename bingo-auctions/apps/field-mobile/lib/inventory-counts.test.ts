import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTrailingDebounce,
  mapStaffInventoryCountsJson,
  EMPTY_STAFF_INVENTORY_COUNTS,
  INVENTORY_SEARCH_DEBOUNCE_MS,
} from './inventory-counts';

describe('mapStaffInventoryCountsJson', () => {
  it('maps full rpc payload', () => {
    expect(
      mapStaffInventoryCountsJson({
        draft: 2,
        pending_intake: 5,
        in_inventory: 10,
        unsold: 3,
        forfeited: 1,
        flagged: 4,
      }),
    ).toEqual({
      draft: 2,
      pending_intake: 5,
      in_inventory: 10,
      unsold: 3,
      forfeited: 1,
      flagged: 4,
    });
  });

  it('missing keys → 0', () => {
    expect(mapStaffInventoryCountsJson({ draft: 1 })).toEqual({
      ...EMPTY_STAFF_INVENTORY_COUNTS,
      draft: 1,
    });
  });

  it('null / non-object → all zeros', () => {
    expect(mapStaffInventoryCountsJson(null)).toEqual(EMPTY_STAFF_INVENTORY_COUNTS);
    expect(mapStaffInventoryCountsJson('x')).toEqual(EMPTY_STAFF_INVENTORY_COUNTS);
  });

  it('coerces numeric strings', () => {
    expect(mapStaffInventoryCountsJson({ unsold: '7' }).unsold).toBe(7);
  });
});

describe('createTrailingDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`fires after ${INVENTORY_SEARCH_DEBOUNCE_MS}ms with the latest value`, () => {
    const onDebounced = vi.fn();
    const debounce = createTrailingDebounce(INVENTORY_SEARCH_DEBOUNCE_MS, onDebounced);

    debounce.schedule('a');
    debounce.schedule('ab');
    expect(onDebounced).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INVENTORY_SEARCH_DEBOUNCE_MS - 1);
    expect(onDebounced).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDebounced).toHaveBeenCalledTimes(1);
    expect(onDebounced).toHaveBeenCalledWith('ab');
  });

  it('cancel prevents a scheduled fire', () => {
    const onDebounced = vi.fn();
    const debounce = createTrailingDebounce(INVENTORY_SEARCH_DEBOUNCE_MS, onDebounced);
    debounce.schedule('x');
    debounce.cancel();
    vi.advanceTimersByTime(INVENTORY_SEARCH_DEBOUNCE_MS);
    expect(onDebounced).not.toHaveBeenCalled();
  });
});
