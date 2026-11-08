// Auction Builder: carry-over candidates whose item a customer already took
// home (mig 0447 builder_collected_lot_ids, the 0357/0356 "collected item"
// rule over the relist lineage). Jared 2026-10-23: the Unpicked-Up list showed
// 7 such items. They were relist copies of lots collected before the 0356
// guard, so the builder offered them and the guard then refused them.
//
// Fail-open to "hide nothing": the list must still load if the function is
// missing (deployed before 0447) or errors. The relist guard still refuses a
// collected item at carry-over time, so nothing unsafe can happen either way.

import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadCollectedCarryoverIds(
  supabase: SupabaseClient,
  warehouseId: string | null,
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase.rpc('builder_collected_lot_ids', {
      p_warehouse_id: warehouseId,
    });
    if (error) {
      console.warn('[builder] builder_collected_lot_ids failed; not hiding collected items:', error.message);
      return new Set();
    }
    return new Set(((data ?? []) as unknown[]).map((v) => String(v)));
  } catch (err) {
    console.warn('[builder] builder_collected_lot_ids threw; not hiding collected items:', (err as Error)?.message);
    return new Set();
  }
}
