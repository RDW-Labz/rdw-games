// Statistical helpers for price aggregation.
//
// Ported from lookup/ebay.ts (median, average) and lookup/merge.ts
// (mostCommon). These are the canonical implementations — the originals
// in those files now import from here rather than defining their own copies.

/**
 * Median of a non-empty array of integers (e.g. cents values).
 * Returns `null` for an empty array. Result is rounded to the nearest integer.
 *
 * @example
 *   median([100, 200, 300]) → 200
 *   median([100, 200])      → 150
 *   median([])              → null
 */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid] as number;
  }
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Arithmetic mean of a non-empty array of integers (e.g. cents values).
 * Returns `null` for an empty array. Result is rounded to the nearest integer.
 *
 * @example
 *   average([100, 200, 300]) → 200
 *   average([])              → null
 */
export function average(nums: number[]): number | null {
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round(sum / nums.length);
}

/**
 * Most frequently occurring string in an array.
 * Returns `null` for an empty array. On tie the first-encountered value wins.
 *
 * @example
 *   mostCommon(["a","b","a","c"]) → "a"
 *   mostCommon([])                → null
 */
export function mostCommon(strs: string[]): string | null {
  if (!strs.length) return null;
  const counts = new Map<string, number>();
  for (const s of strs) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of counts.entries()) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? best[0] : null;
}
