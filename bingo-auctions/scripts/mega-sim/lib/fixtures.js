// scripts/mega-sim/lib/fixtures.js
//
// Deterministic test data. Designed to exercise every code path the
// real platform takes:
//   • UPC manifests (5 rows, mixed catalog hits + misses)
//   • Supplier-SKU-as-title manifests (10 rows, Lowe's-style)
//   • ASIN/FNSKU manifests (5 rows, Amazon-style)
//   • A few extreme-value rows (long titles, missing optional fields)
//
// Mock photos: a couple of small embedded JPGs as base64 so the sim is
// self-contained. They're not realistic product shots — just enough
// pixels to satisfy expo-image-manipulator-style checks. AI will mostly
// return low-confidence "unidentifiable" but that's fine — we're
// testing the FLOW, not whether the AI gets the right answer.

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_FILENAME = 'sim-manifest-' + Date.now() + '.csv';

// ── Manifest row generator ────────────────────────────────────────────────

function buildManifestRows() {
  const rows = [];

  // UPC rows — these are real UPCs from common products. Some likely
  // already cached in product_lookups; others are misses.
  // cost_cents added so 0063's propagation is verifiable end-to-end.
  rows.push(...[
    { title: 'DeWalt 20V MAX Cordless Drill Driver Kit',  upc: '885911633192', msrp_cents: 12999, cost_cents: 4500, condition: 'good' },
    { title: 'Milwaukee M18 Brushless Impact Driver',     upc: '045242407606', msrp_cents: 19900, cost_cents: 6800, condition: 'good' },
    { title: 'Stanley FatMax 25-foot Tape Measure',       upc: '076174339598', msrp_cents:  2499, cost_cents:  900, condition: 'good' },
    { title: 'KitchenAid Artisan Stand Mixer',            upc: '883049394787', msrp_cents: 39999, cost_cents: 14500, condition: 'open_box' },
    { title: 'Instant Pot Duo 7-in-1 6 Quart',            upc: '810028580015', msrp_cents:  9999, cost_cents: 3700, condition: 'good' },
  ]);

  // Supplier-vocab condition rows — exercise the 0062 normalizer.
  // Each of these uses a raw string that is NOT the platform enum;
  // the picker persona asserts the resulting lot.condition is the
  // expected mapping.
  rows.push(...[
    // 'New' / variants → appears_new
    { title: 'CONDNORM-NEW-SEALED-XBOX',    condition: 'New',         cost_cents: 3000, msrp_cents: 9999 },
    { title: 'CONDNORM-FACTORY-SEALED-PS5', condition: 'Factory Sealed', cost_cents: 3500, msrp_cents: 9999 },
    // 'Open Box' / customer return → open_box
    { title: 'CONDNORM-CUSTOMER-RETURN-IRON', condition: 'Customer Return', cost_cents: 2500, msrp_cents: 7900 },
    { title: 'CONDNORM-OPEN-BOX-TOSTER',      condition: 'OPEN BOX',        cost_cents: 1200, msrp_cents: 4900 },
    // 'Used' / refurb / tested → good
    { title: 'CONDNORM-USED-VACUUM',  condition: 'Used',            cost_cents: 1500, msrp_cents: 5900 },
    { title: 'CONDNORM-REFURB-CAMERA', condition: 'Refurbished',    cost_cents: 4500, msrp_cents: 12999 },
    // Salvage / damaged → as_is
    { title: 'CONDNORM-SALVAGE-LAPTOP', condition: 'Salvage',       cost_cents: 1000, msrp_cents: 9999 },
    { title: 'CONDNORM-DAMAGED-TV',     condition: 'Damaged - parts only', cost_cents: 500, msrp_cents: 5999 },
  ]);

  // Lowe's / supplier-SKU-as-title rows — no UPC, the SKU IS the title.
  // This is the case 76% of the user's real pool falls into.
  rows.push(...[
    { title: 'WSLW36IFV',          msrp_cents: 24999, condition: 'good' },
    { title: '2026VA-30-372-900L', msrp_cents:  8999, condition: 'open_box' },
    { title: '23006-SWBC4V',       msrp_cents: 14999, condition: 'as_is' },
    { title: 'W054936P2-WH',       msrp_cents:  5999, condition: 'good' },
    { title: 'BLDP-4823-XYZ',      msrp_cents: 17900, condition: 'good' },
    { title: 'SH-9921-PNK-32',     msrp_cents:  3499, condition: 'good' },
    { title: 'KIT-MORTAR-50-AB',   msrp_cents: 11999, condition: 'good' },
    { title: 'TILE-PORCELAIN-12X12-BX', msrp_cents: 4500, condition: 'good' },
    { title: 'PAINT-VALSPAR-1G-WHITE',  msrp_cents: 3499, condition: 'good' },
    { title: 'LIGHTING-LED-12V-STRIP',  msrp_cents: 2999, condition: 'open_box' },
  ]);

  // Amazon FBA-style rows — ASIN + FNSKU + LPN.
  rows.push(...[
    { title: 'Amazon Basics Bluetooth Speaker', asin: 'B07PXGQC1Q', fnsku: 'X001AB2CD3', lpn: 'LPNHA0001234', msrp_cents: 4999, condition: 'good' },
    { title: 'Echo Dot (5th Gen)',              asin: 'B09B8V1LZ3', fnsku: 'X002EF4GH5', lpn: 'LPNHA0001235', msrp_cents: 4999, condition: 'open_box' },
    { title: 'Fire TV Stick 4K',                asin: 'B08XVYZ1Y5', fnsku: 'X003IJ6KL7', lpn: 'LPNHA0001236', msrp_cents: 4999, condition: 'good' },
    { title: 'Kindle Paperwhite (11th Gen)',    asin: 'B08KTZ8249', fnsku: 'X004MN8OP9', lpn: 'LPNHA0001237', msrp_cents: 13999, condition: 'good' },
    { title: 'Ring Video Doorbell 2nd Gen',     asin: 'B08N5N6CFV', fnsku: 'X005QR0ST1', lpn: 'LPNHA0001238', msrp_cents: 9999, condition: 'as_is' },
  ]);

  // Edge case: extremely long title (tests defensive truncation).
  rows.push({
    title:
      'Industrial Grade Heavy-Duty Commercial Stainless Steel Restaurant Kitchen ' +
      'Equipment Multi-Function Heat-Resistant Anti-Corrosion Long Description ' +
      'Stretch Test Item For Sim Validation Exercise '.repeat(3),
    upc: '999999999999',
    msrp_cents: 250000,
    condition: 'good',
  });

  return rows;
}

// ── Mock photos ────────────────────────────────────────────────────────────
// Tiny 1×1 JPEG (smallest valid JPEG) — used for --no-ai stub paths.
// The AI will return "no_identification" but that's fine; we're testing
// the FLOW, including how the platform handles AI failure modes.

const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////' +
  '////////////////////////////////////////////////////wgARCAABAAEDAREA' +
  'AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAj/' +
  '2gAMAwEAAhADEAAAAFP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAh//xAAU' +
  'EQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AR//xAAUEQEAAAAAAAAAAAAAAAAAAAAA' +
  '/9oACAECAQE/AR//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ah//xAAUEAEA' +
  'AAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IR//2gAMAwEAAgADAAAAEB//xAAUEQEAAAAA' +
  'AAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEC' +
  'AQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==';

function getMockPhotoBase64() {
  return TINY_JPEG_BASE64;
}

// ── Optional: real-product JPEG fixtures from the fixtures/mock-photos dir ─

function listRealPhotos() {
  const dir = path.join(__dirname, '..', 'fixtures', 'mock-photos');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => path.join(dir, f));
}

function readRealPhotoBase64(p) {
  const buf = fs.readFileSync(p);
  return buf.toString('base64');
}

// ── Stubbed LotCandidate for --no-ai mode ─────────────────────────────────

function makeStubCandidate({ title, upc, condition }) {
  return {
    title: title || 'Stubbed Sim Lot',
    brand: 'StubBrand',
    model: 'STUB-001',
    upc: upc || '',
    category: 'Electronics',
    condition: condition || 'good',
    description: 'AI-stubbed candidate for sim --no-ai mode.',
    confidence: 'medium',
    notes: '',
    visibleText: ['stub'],
    prices: [],
    stockPhotos: [],
    msrp: 99.99,
    avg: 89.99,
    startBid: 5,
    fullTitle: title || 'Stubbed Sim Lot',
    specs: '',
  };
}

module.exports = {
  MANIFEST_FILENAME,
  buildManifestRows,
  getMockPhotoBase64,
  listRealPhotos,
  readRealPhotoBase64,
  makeStubCandidate,
};
