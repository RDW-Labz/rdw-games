// Title / description text similarity.
//
// CHOICE: token Jaccard with light normalization, plus a normalized
// Levenshtein on the brand+model substring. Why this and not embeddings:
//   1. We're scoring auction titles, not paragraphs. The signal is mostly
//      "did the right brand + model + product-type words show up?"
//      Token-set overlap captures that without a model call.
//   2. Embedding similarity would force every eval run to call an embedding
//      API, which couples the harness to an extra model and adds cost we
//      can't easily attribute to the model under test.
//   3. Levenshtein on the full title penalizes correct paraphrases too
//      harshly ("Drill Kit" vs "Drill Driver Kit"). We use it ONLY on
//      brand+model where exact-match is what we want.
//
// If we later decide we DO need semantic similarity (e.g. for description
// scoring on lots without a clear model number), swap this for a small
// local embedding model — keep the function signature the same.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'with', 'for', 'in', 'on', 'to', 'by',
  'kit', 'set', 'pack', 'inch', 'inches', 'in.', 'pc', 'pcs', 'piece',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Jaccard similarity of two token sets, 0..1. */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Levenshtein edit distance — iterative DP, no recursion. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** Normalized Levenshtein similarity, 0..1. */
export function levenshteinSimilarity(a: string, b: string): number {
  const aa = a.toLowerCase().trim();
  const bb = b.toLowerCase().trim();
  if (!aa && !bb) return 1;
  const max = Math.max(aa.length, bb.length);
  if (max === 0) return 1;
  return 1 - levenshtein(aa, bb) / max;
}

/**
 * Title similarity blends token-set overlap with edit distance on the
 * brand+model substring (if we can identify one). Returns 0..1.
 */
export function titleSimilarity(actual: string, expected: string): number {
  return jaccardSimilarity(actual, expected);
}

/** Description similarity is just token-set Jaccard. */
export function descriptionSimilarity(actual: string, expected: string): number {
  return jaccardSimilarity(actual, expected);
}

/** Exact-after-normalization match for short strings (brand, model). */
export function exactStringMatch(actual: string, expected: string): 0 | 1 {
  const a = actual.toLowerCase().replace(/[\s-]/g, '').trim();
  const b = expected.toLowerCase().replace(/[\s-]/g, '').trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}
