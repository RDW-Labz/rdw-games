// Carry-over in small requests (owner, 2026-10-23). One click used to send
// every selected lot in ONE server action; a batch of 27 ran 11 s and the
// Error Code 520 that day left Jared with a grid that no longer matched the
// database. Now the builder sends CARRYOVER_CHUNK lots per request, one
// request after another, and shows progress, so no single request runs long
// and a lost answer costs at most one small chunk. Pure helpers, unit-tested.

import type { CarryoverReport } from './actions';

export const CARRYOVER_CHUNK = 5;

export function chunkIds<T>(ids: T[], size = CARRYOVER_CHUNK): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
}

export function emptyReport(): CarryoverReport {
  return { carried: [], failed: [], already: [] };
}

export function mergeReports(a: CarryoverReport, b: CarryoverReport): CarryoverReport {
  return {
    carried: [...a.carried, ...b.carried],
    failed: [...a.failed, ...b.failed],
    already: [...(a.already ?? []), ...(b.already ?? [])],
  };
}

/** Lots never sent because the run stopped early (a target-auction error or a lost answer). */
export function notTried(
  ids: string[],
  reason: string,
  codeOf: (id: string) => string = (id) => id,
): CarryoverReport['failed'] {
  return ids.map((lotId) => ({ lotId, code: codeOf(lotId), reason: `Not tried: ${reason}` }));
}

/** What to tell staff when the run is over. ok = everything carried over now. */
export function summarize(report: CarryoverReport, total: number): { ok: boolean; message: string | null } {
  const carried = report.carried.length;
  const failed = report.failed.length;
  const already = (report.already ?? []).length;
  if (failed === 0 && already === 0) return { ok: true, message: null };
  if (failed === 0 && carried === 0) {
    return {
      ok: false,
      message: `Nothing new to add: ${already} ${already === 1 ? 'was' : 'were'} already carried over earlier — see the list below.`,
    };
  }
  if (failed === 0) {
    return {
      ok: false,
      message: `Carried over ${carried} of ${total}. ${already} ${already === 1 ? 'was' : 'were'} already carried over earlier — see the list below.`,
    };
  }
  return {
    ok: false,
    message:
      carried > 0
        ? `Carried over ${carried} of ${total}. ${failed} not added — see the list below.`
        : `Nothing was carried over. ${failed} not added — see the list below.`,
  };
}
