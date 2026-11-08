import type { Symbology } from './index';

// Which scans are real retail barcodes (a catalog miss just means "not in our
// catalog yet") vs. codes that are not product barcodes at all: Amazon FNSKU
// "X…", ASIN "B0…", LPN, roll labels like "PNK4860366", carrier labels. For
// the latter a catalog or web lookup can never be right, so a manifest miss
// stops at the No-Match picker (field-mobile quick.tsx, #353).
//
// Moved here from quick.tsx on 2026-09-28 so it can be tested, with one rule
// added: a NUMERIC code the camera read as a non-retail symbology (Code-128 and
// friends) is a label, not a GTIN. A FedEx 12-digit tracking number is UPC-A
// length; read as Code-128 it used to count as a "numeric GTIN" and fall
// through to the catalog/web lookup, which invented products for it (0372) and
// could auto-create a lot. #381 refuses most of those server-side (bad check
// digit, or on the manifest); this closes the rest on the device. Retail
// barcodes are always read as UPC/EAN/ITF, so they are unaffected. A typed
// code ('unknown') keeps the old rule: numeric 8-14 is treated as a GTIN.
const RETAIL_SYMBOLOGIES: ReadonlySet<Symbology> = new Set([
  'upc-a',
  'upc-e',
  'ean-13',
  'ean-8',
  'itf-14',
]);

export function isNonUpcCode(code: string, symbology: Symbology): boolean {
  if (RETAIL_SYMBOLOGIES.has(symbology)) return false; // real retail barcode
  if (/^\d{8,14}$/.test(code)) return symbology !== 'unknown'; // typed GTIN vs. label
  return true; // FNSKU/ASIN/LPN/roll-label/carrier/etc.
}
