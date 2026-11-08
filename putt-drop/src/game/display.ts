/** Logical game coordinate space (all layout / sim uses this). */
export const LOGICAL_W = 360;
export const LOGICAL_H = 640;

function computeRenderScale(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio || 1;
  return Math.min(Math.max(dpr, 1), 3);
}

/** min(devicePixelRatio, 3), fixed at module load in the browser. */
export const R = computeRenderScale();
