// Arguments for the duplicate_lot RPC (mig 0299 → 0326 → 0416).
//
// 0416: the copy is credited to the clocked-in PIN worker, the same way the
// create-draft and relist paths stamp lotted_by_worker. Before it the app sent
// p_lot_id alone and the copy was credited to nobody — on Oct 13, 40 of 108
// Crandall lots. The server validates the worker against the operator and
// falls back to the source lot's worker when this is null or invalid.
//
// Pure (no React, no native modules) so it is unit-testable.

export interface DuplicateLotArgs {
  p_lot_id: string;
  p_lotted_by_worker: string | null;
}

export function duplicateLotArgs(lotId: string, workerId: string | null | undefined): DuplicateLotArgs {
  const w = typeof workerId === 'string' && workerId.trim() ? workerId : null;
  return { p_lot_id: lotId, p_lotted_by_worker: w };
}
