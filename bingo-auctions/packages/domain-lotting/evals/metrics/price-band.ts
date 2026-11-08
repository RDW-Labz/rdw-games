// Price-band metric.
//
// "Pass" if the predicted MSRP is within +/-25% of the labeled MSRP.
// We also report mean absolute error in cents so we can spot models that
// are just-barely-outside-the-band vs wildly-off.
//
// Why 25%: retail prices fluctuate, and the model is reading whatever it
// found on the web. We're trying to detect "the model has the wrong product"
// not "Amazon's price differs from Lowe's by 5%". 25% is loose enough to
// tolerate retailer disagreement, tight enough to flag a wrong SKU.
//
// Edge cases:
//   - Expected MSRP is 0 (e.g. fake-UPC fixture): only pass if predicted is
//     also 0, since otherwise we'd be dividing by zero.
//   - Predicted MSRP is null/0 but expected > 0: explicit fail.

export const PRICE_BAND_TOLERANCE = 0.25;

export type PriceBandResult = {
  within_band: 0 | 1;
  mae_cents: number;
  predicted_cents: number;
  expected_cents: number;
};

export function priceBand(
  predictedCents: number | null | undefined,
  expectedCents: number,
): PriceBandResult {
  const p = Math.max(0, Math.round(predictedCents ?? 0));
  const e = Math.max(0, Math.round(expectedCents));
  const mae = Math.abs(p - e);
  if (e === 0) {
    return {
      within_band: p === 0 ? 1 : 0,
      mae_cents: mae,
      predicted_cents: p,
      expected_cents: e,
    };
  }
  const within = mae / e <= PRICE_BAND_TOLERANCE ? 1 : 0;
  return { within_band: within, mae_cents: mae, predicted_cents: p, expected_cents: e };
}

/** Aggregate helpers used by runners. */
export function meanMae(results: PriceBandResult[]): number {
  if (results.length === 0) return 0;
  const total = results.reduce((sum, r) => sum + r.mae_cents, 0);
  return Math.round(total / results.length);
}

export function withinBandRate(results: PriceBandResult[]): number {
  if (results.length === 0) return 0;
  const hits = results.filter((r) => r.within_band === 1).length;
  return hits / results.length;
}
