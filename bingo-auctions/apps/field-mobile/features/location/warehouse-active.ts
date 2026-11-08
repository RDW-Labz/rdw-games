/** Treat missing `active` (pre-0406 deploy) as still active. */
export function isWarehouseActive(w: { active?: boolean | null }): boolean {
  return w.active !== false;
}
