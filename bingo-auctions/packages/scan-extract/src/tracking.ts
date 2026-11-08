// Carrier tracking number extraction — FORMAT-COUPLED, not vendor-coupled.
//
// Extracts tracking number candidates from raw scan data based on barcode
// value SHAPE only. Symbology is a vendor (camera library) implementation
// detail and is NOT used to gate extraction.
//
// Supported shapes:
//   UPS shape:          1Z[A-Z0-9]{16} — any symbology (18 chars total)
//   Numeric composite:  20-40 digits, ANY symbology
//                       → last 12 digits emitted as a candidate alongside raw.
//                       Carrier-agnostic: covers SSCC-22, USPS IMpb (20-22),
//                       FedEx Ground 96-bit outer-pack (itf-14), and longer
//                       human-readable composites (26-34+ digits with
//                       prefix/postfix AI fields). Manual input ('unknown'
//                       symbology) also benefits.
//
// Rationale for removing the LINEAR_OR_2D symbology gate:
//   vision-camera v4 reports FedEx Ground 96-bit outer-pack labels as
//   'itf-14', which was previously rejected. The numeric-composite pattern
//   itself (^\d{20,40}$) is the format gate — symbology is redundant and
//   actively harmful. Completes PR #132's generalized-length intent.

import type { Symbology } from './index';

// Pattern: starts 1Z + 16 uppercase alphanumeric chars = 18 chars total.
const UPS_PATTERN = /^1Z[A-Z0-9]{16}$/;

// Numeric composite shape: 20-40 digits all-numeric. Captures every common
// carrier-label encoding (USPS IMpb at 20-22, SSCC-22 at 22, FedEx Ground
// human-readable variants at 26-34, prefix-padded outer-pack at 30-40).
// The last 12 digits of these composites almost always = the human-readable
// shipper tracking number. Emitting that suffix alongside the raw lets the
// manifest probe match regardless of whether the operator's import_rows
// stored the long composite, the 12-digit form, or a multi-tracking string.
const NUMERIC_COMPOSITE_PATTERN = /^\d{20,40}$/;

/**
 * Extract carrier tracking candidates from a raw scan value.
 *
 * Returns extracted strings that differ from `raw` (caller prepends raw and
 * deduplicates). Returns empty array when no tracking shape is detected.
 */
export function extractTrackingCandidates(raw: string, _symbology: Symbology): string[] {
  const results: string[] = [];

  // UPS: 1Z + 16 alphanumeric — any symbology. Raw IS the tracking; no
  // additional extraction needed (caller keeps raw).
  if (UPS_PATTERN.test(raw)) {
    return results;
  }

  // Numeric composite (20-40 digits), any symbology. Always emit the
  // last 12 digits alongside the raw so the manifest probe finds matches
  // whether import_rows stored the long form or the 12-digit suffix.
  // Skip if last-12 == raw (would be a duplicate; caller already adds raw).
  if (NUMERIC_COMPOSITE_PATTERN.test(raw)) {
    const last12 = raw.slice(-12);
    if (last12 !== raw) {
      results.push(last12);
    }
  }

  return results;
}
