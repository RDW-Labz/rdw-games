'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { commitImport, type CommitInput } from '../actions';
import { countTrackingTokens, expandRowsByTracking } from '@/lib/imports/expand-tracking';
import { assignSourceKeys } from '@/lib/imports/source-key';
import {
  columnForField,
  findCodeCategoryProblem,
  findUrlTitleProblem,
} from '@/lib/imports/mapping-guards';
import { buttonStyle } from '@/components/Form';
// Shared normalizers — canonical implementations from domain-lotting.
// DO NOT redefine parseCents or normalizeUpcStrict locally; import from here.
import { parseCents, normalizeUpcStrict as _normalizeUpc } from '@auction-platform/domain-lotting';

// The internal field shape we map columns *to*. Mirrors importRowSchema
// in actions.ts. A source column with no fields assigned is ignored.
//
// Amazon manifests ship asin/fnsku/lpn — pickers scan these at the
// auction pickup center, so they must round-trip through import_rows
// → lots and end up indexed on the lot for fast intake_lot_to_bin
// resolution. Brand / model / pallet_id / quantity / cost are common
// across most retailers and improve filtering / margin tracking.
type FieldKey =
  | 'title'
  | 'description'
  | 'category_raw'
  | 'sub_category_raw'
  | 'product_sku'
  | 'site_sku'
  | 'manufacture_sku'
  | 'catalog_id'
  | 'order_id'
  | 'po_number'
  | 'upc'
  | 'asin'
  | 'fnsku'
  | 'lpn'
  | 'external_code'
  | 'pallet_id'
  | 'brand'
  | 'model'
  | 'msrp_cents'
  | 'cost_cents'
  | 'starting_bid_cents'
  | 'quantity'
  | 'photo_url'
  | 'condition'
  | 'return_reason'
  | 'tracking_number';

const FIELD_KEYS: FieldKey[] = [
  'title',
  'description',
  'brand',
  'model',
  'category_raw',
  'sub_category_raw',
  'upc',
  'asin',
  'fnsku',
  'lpn',
  'product_sku',
  'site_sku',
  'manufacture_sku',
  'catalog_id',
  'order_id',
  'po_number',
  'external_code',
  'pallet_id',
  'quantity',
  'msrp_cents',
  'cost_cents',
  'starting_bid_cents',
  'photo_url',
  'condition',
  'return_reason',
  'tracking_number',
];

const FIELD_LABELS: Record<FieldKey, string> = {
  title:               'Title',
  description:         'Description',
  brand:               'Brand',
  model:               'Model #',
  category_raw:        'Category (raw retailer string)',
  sub_category_raw:    'Sub-category',
  upc:                 'UPC',
  asin:                'ASIN (Amazon)',
  fnsku:               'FNSKU (Amazon)',
  lpn:                 'LPN (Amazon return unit)',
  product_sku:         'Product SKU / part #',
  site_sku:            'Site SKU (retailer listing)',
  manufacture_sku:     'Manufacturer SKU / MPN',
  catalog_id:          'Catalog / listing ID',
  order_id:            'Order ID',
  po_number:           'PO number',
  external_code:       'External code (pre-stickered ID)',
  pallet_id:           'Pallet ID',
  quantity:            'Quantity (units this row represents)',
  msrp_cents:          'MSRP / retail price',
  cost_cents:          'Cost / acquisition price',
  starting_bid_cents:  'Starting bid',
  photo_url:           'Photo URL',
  condition:           'Condition',
  return_reason:       'Return reason',
  tracking_number:     'Return tracking # (FedEx — per box)',
};

// Header-name heuristics for auto-detection. Order matters — more
// specific patterns win. "long description" must match description
// before "title" picks up the bare "description" word.
//
// Patterns run against a normalized form of the header (lowercase,
// stripped, collapsed whitespace) so we tolerate the ` Retail ` /
// `Sub Category` / `Sub-Category` / `RetailPrice` zoo we see across
// real manifests.
//
// Title denylist: certain "description-shaped" headers actually contain
// SKU/model codes or pallet IDs (e.g. a real Lowes-shaped manifest's
// `description2` column is the pallet code, not the description).
// Those are excluded from auto-
// detect of `title` and `description`; the operator can still hand-map
// if they really want.
const TITLE_DENYLIST = new Set([
  'description2',
  'pallet id',
  'pallet lpn',
  'pallet',
  'lpn',
  'fcsku',
  'fnsku',
  'model',
  'asin',
  'b00 asin',
  'x-z asin',
  'sku',
  'productsku',
  'manufacturesku',
  'sitesku',
]);

const HEADER_PATTERNS: Array<{ field: FieldKey; pattern: RegExp }> = [
  // Photo URL — accepts the Wayfair-shaped "Wayfair Site - Product Photos"
  // (which Lowes preprocessor pipelines also use), source_url, and the
  // generic photo/image patterns.
  {
    field: 'photo_url',
    pattern:
      /(photo|image|img|picture).*(url|link|src)?|^image$|^photo$|product\s*photos?|source[\s_-]*url|product\s*image/i,
  },
  // Return tracking number (Wayfair / FedEx). The box's carrier tracking is the
  // manifest LOOKUP key at lotting (scan box → find import_row → prefill); it is
  // NOT the lot's identity. One import_row per tracking after expansion.
  { field: 'tracking_number', pattern: /tracking|fedex/i },
  // Cost — operator's acquisition cost. Match BEFORE msrp so ` Cost `
  // doesn't accidentally fall through. "Unit cost" / "acquisition cost"
  // also match.
  {
    field: 'cost_cents',
    pattern: /^cost$|unit[\s_-]*cost|acquisition[\s_-]*cost|landed[\s_-]*cost|wholesale/i,
  },
  // MSRP — handles ` Retail `, `Retail`, `RetailPrice`, `EXT MSRP`.
  {
    field: 'msrp_cents',
    pattern:
      /msrp|retail[\s_-]*price|list[\s_-]*price|reg[\s_-]*price|original[\s_-]*price|map\b|^retail$|ext\s*msrp|ext\s*retail/i,
  },
  { field: 'starting_bid_cents', pattern: /start[\s_-]*bid|opening[\s_-]*bid|min[\s_-]*bid|reserve/i },
  // Quantity — common headers in liquidation manifests.
  { field: 'quantity', pattern: /^qty$|^quantity$|^units$|^count$|case[\s_-]*pack/i },
  // Amazon identifiers — match BEFORE generic UPC/SKU so they're not
  // mis-claimed.
  // "B00 Asin" → asin (Amazon product ASIN). "X-Z ASIN" is intentionally NOT
  // here — its values are LPN-shaped (e.g. LPNO078831457), not real ASINs.
  { field: 'asin', pattern: /^asin$|^b00\s*asin$|amazon[\s_-]*id/i },
  { field: 'fnsku', pattern: /^fnsku$|^fcsku$|^fn[\s_-]*sku$|^fc[\s_-]*sku$/i },
  // "X-Z ASIN" columns carry LPN values (Amazon return unit IDs), not ASINs.
  { field: 'lpn', pattern: /^lpn$|^x-?z\s*asin$|license[\s_-]*plate/i },
  // UPC — `ItemNumber` value-sniffs to UPC only if values are 12-13 digits.
  { field: 'upc', pattern: /\bupc\b|barcode|gtin|^ean$|item[\s_-]*number|^itemnumber$/i },
  // Pallet identifiers (Lowes-shaped, Amazon-shaped).
  { field: 'pallet_id', pattern: /^pallet$|pallet[\s_-]*(id|lpn|number|#)|skid[\s_-]*(id|number)/i },
  // Brand / model — distinct fields, often present in cleaner manifests.
  { field: 'brand', pattern: /^brand$|^manufacturer$|^mfr$|^make$/i },
  { field: 'model', pattern: /^model$|^mpn$|model[\s_-]*(number|#|no)|manufacturer[\s_-]*part/i },
  // SKU family — split the three retailer SKU columns into distinct fields
  // (Wayfair ProductSKU / SiteSKU / ManufactureSKU; Walmart/Lowe's SKU/Model;
  // Amazon MSKU/MPN). Specific patterns first so the generic product_sku
  // catch-all below doesn't swallow them. manufacture_sku also accepts MPN /
  // Model # (it doubles as the manufacturer part number).
  { field: 'site_sku', pattern: /^site[\s_-]*sku$|sitesku/i },
  { field: 'manufacture_sku', pattern: /manufacture[rd]?[\s_-]*sku|manufacturesku|^mfr[\s_-]*sku$/i },
  { field: 'catalog_id', pattern: /^catalog[\s_-]*(id|number|#)?$|catalogid|catalog[\s_-]*(id|number|#)/i },
  { field: 'order_id', pattern: /^order[\s_-]*(id|number|#)$|^orderid$|^order$/i },
  { field: 'po_number', pattern: /^po[\s_-]*(number|#|no)?$|^ponumber$|purchase[\s_-]*order/i },
  // Generic SKU / part-number / non-UPC item-number → product_sku (primary item SKU).
  { field: 'product_sku', pattern: /\bsku\b|part[\s_-]*(number|#|no)|item[\s_-]*(number|#|no)|productsku/i },
  { field: 'external_code', pattern: /external[\s_-]*(id|code)|asset[\s_-]*(id|tag)|route[\s_-]*stop|truck[\s_-]*load|tag[\s_-]*(id|code|number)/i },
  // Sub-category — match BEFORE category so the more specific wins
  // when both exist (some manifests use a two-column category shape).
  {
    field: 'sub_category_raw',
    pattern: /sub[\s_-]*category|secondary[\s_-]*category|sub[\s_-]*class/i,
  },
  // Category — picks up `Category`, `Department`, `Class`, `Group`,
  // `Aisle`, `GLDesc` (Amazon), `Product Type`, `ProductCategory`.
  {
    field: 'category_raw',
    pattern:
      /^gldesc$|gl[\s_-]*desc|^category$|department|^class$|^group$|aisle|product[\s_-]*type|product[\s_-]*category/i,
  },
  // Return reason — Amazon and Wayfair manifests both ship it.
  { field: 'return_reason', pattern: /return[\s_-]*reason|reason[\s_-]*for[\s_-]*return|return[\s_-]*disposition/i },
  { field: 'condition', pattern: /condition|grade/i },
  // Long-form description — the cleaner of the description columns.
  { field: 'description', pattern: /^long[\s_-]*desc|description$|details|^notes$/i },
  { field: 'title', pattern: /^title$|^productname$|product[\s_-]*name|^name$|item[\s_-]*desc|^description$|^product$/i },
];

// Normalize a header for matching: lowercase, strip whitespace + zero-
// width chars, collapse internal spaces. Amazon manifests ship headers
// like ` Retail ` and ` Ext Retail ` with leading/trailing spaces; this
// strips them so the regex can fire.
function normalizeHeader(header: string): string {
  return String(header).toLowerCase().replace(/[​-‍﻿]/g, '').trim().replace(/\s+/g, ' ');
}

// Sniff a sample of column values to decide if this column is actually
// what its header claims. Used to override auto-detect when the header
// is ambiguous (`description2` looks like description, but values are
// pallet codes; `ItemNumber` looks like UPC-A only when values are
// 12-13 digit numerics).
function looksLikeUpc(values: unknown[]): boolean {
  let hits = 0;
  let sampled = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    sampled++;
    if (sampled > 30) break;
    if (/^\d{12,13}$/.test(String(v).trim())) hits++;
  }
  return sampled > 0 && hits / sampled >= 0.7;
}

function looksLikePalletOrSku(values: unknown[]): boolean {
  let hits = 0;
  let sampled = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    sampled++;
    if (sampled > 30) break;
    const s = String(v).trim();
    if (/^(PAL|LPN|FN|FC)[A-Z0-9]{4,}$/i.test(s)) hits++;
    else if (/^[A-Z]{1,4}\d{6,}$/.test(s)) hits++; // generic SKU shape
    else if (s.length < 4) hits++;
  }
  return sampled > 0 && hits / sampled >= 0.6;
}

function looksLikePhotoUrl(values: unknown[]): boolean {
  let hits = 0;
  let sampled = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    sampled++;
    if (sampled > 20) break;
    if (/^https?:\/\/.*\.(jpe?g|png|webp|gif)/i.test(String(v).trim())) hits++;
  }
  return sampled > 0 && hits / sampled >= 0.5;
}

// Detect if a workbook is a "side file" — photo enrichment output rather
// than a primary manifest. Caller should warn the operator.
export function looksLikeSideFile(headers: string[]): boolean {
  const norm = headers.map(normalizeHeader);
  const hasStatusVia = norm.includes('status') && norm.includes('via');
  const hasError = norm.includes('error');
  return hasStatusVia && hasError;
}

function autoDetectField(
  header: string,
  sampleValues?: unknown[],
): FieldKey | null {
  const normalized = normalizeHeader(header);

  // Title denylist — known-bad columns that look description-ish but
  // hold SKU/pallet codes. Skip them entirely so they're never auto-
  // mapped to title or description.
  if (TITLE_DENYLIST.has(normalized)) {
    // Still allow them to be picked up as `sku`/`external_code` via the
    // patterns below — fall through.
  }

  for (const { field, pattern } of HEADER_PATTERNS) {
    if (!pattern.test(normalized)) continue;

    // Apply value-sniff overrides:
    if (sampleValues && sampleValues.length > 0) {
      // ItemNumber-style header → only treat as UPC if values look UPC-A.
      if (field === 'upc' && /item[\s_-]*number/i.test(normalized)) {
        if (!looksLikeUpc(sampleValues)) continue;
      }
      // description2 / pallet-shaped headers → don't auto-map to description.
      if (
        (field === 'description' || field === 'title') &&
        TITLE_DENYLIST.has(normalized)
      ) {
        continue;
      }
      // photo column with non-URL values → don't auto-map.
      if (field === 'photo_url' && !looksLikePhotoUrl(sampleValues)) {
        // Only skip if the values clearly aren't URLs; if no values,
        // trust the header.
        if (sampleValues.some((v) => v !== null && v !== undefined && v !== '')) {
          continue;
        }
      }
      // sku/title denylist — values that look like pallet/SKU codes
      // shouldn't claim title even if header looked title-like.
      if (field === 'title' && looksLikePalletOrSku(sampleValues)) continue;
    }

    return field;
  }
  return null;
}

// parseCents is imported from @auction-platform/domain-lotting above.
// looksLikeUpc, looksLikePalletOrSku, looksLikePhotoUrl, normalizeHeader,
// and HEADER_PATTERNS are CSV-specific UI helpers that live here intentionally
// (they encode manifest-column heuristics, not general normalization).

function parseCondition(raw: unknown): CommitInput['rows'][number]['condition'] | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).toLowerCase();
  if (/(new|sealed|appears\s*new|like\s*new)/.test(s)) return 'appears_new';
  if (/(open\s*box|opened)/.test(s)) return 'open_box';
  if (/(as[\s-]?is|damaged|parts)/.test(s)) return 'as_is';
  if (/(good|fair|used)/.test(s)) return 'good';
  return null;
}

type ParsedFile = {
  filename: string;
  headers: string[];
  rows: Record<string, unknown>[];
};

type Step = 'upload' | 'map' | 'commit';

export function ImportWizard({
  warehouses,
  recentSources = [],
}: {
  warehouses: Array<{ id: string; name: string }>;
  /** Distinct source_label values this operator has used before. Server-
   *  page loads them so the form can offer quick-pick chips +
   *  autocomplete instead of forcing free-text recall ("was it Test1?
   *  test 1? Test-1?"). Reported during dogfooding 2026-05-11. */
  recentSources?: string[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  // One-to-many: each source column maps to zero or more internal
  // fields. Empty array = "ignore this column." Operators commonly
  // need a single-column manifest where the same text becomes both
  // title and description, so multi-mapping is the common case once
  // they hit it.
  const [mapping, setMapping] = useState<Record<string, FieldKey[]>>({});
  // Warehouse is OPTIONAL. The manifest pre-dates physical arrival
  // for liquidation auctioneers — the truck might come tomorrow,
  // next week, or never. Intake scanning is the authoritative moment
  // for warehouse + bin assignment. Picking one here is just a hint.
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleFile(file: File) {
    setParseError(null);
    const ext = file.name.toLowerCase().split('.').pop();
    try {
      let headers: string[];
      let rows: Record<string, unknown>[];

      if (ext === 'csv') {
        // PapaParse: header row, autoComplete typing, skip empty lines
        const text = await file.text();
        const result = Papa.parse<Record<string, unknown>>(text, {
          header: true,
          skipEmptyLines: 'greedy',
          dynamicTyping: false, // we coerce explicitly below
        });
        if (result.errors.length > 0 && result.errors[0]) {
          throw new Error(result.errors[0].message);
        }
        rows = result.data;
        headers = result.meta.fields ?? [];
      } else if (ext === 'xlsx' || ext === 'xls') {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        if (wb.SheetNames.length === 0) throw new Error('Workbook has no sheets');

        // Multi-sheet workbooks: pick the largest non-empty sheet.
        // Some manifest exports ship a `Manifest` + `Images 1` pair
        // where the second sheet is just photo URLs. The largest is almost
        // always the real manifest. If a sheet is named "Manifest" we
        // prefer that explicitly.
        let chosenSheetName = wb.SheetNames[0]!;
        let chosenRowCount = 0;
        const explicitManifest = wb.SheetNames.find(
          (n) => n.trim().toLowerCase() === 'manifest',
        );
        if (explicitManifest) {
          chosenSheetName = explicitManifest;
        } else {
          for (const name of wb.SheetNames) {
            const s = wb.Sheets[name];
            if (!s) continue;
            const r = XLSX.utils.sheet_to_json(s, { defval: '' });
            if (r.length > chosenRowCount) {
              chosenRowCount = r.length;
              chosenSheetName = name;
            }
          }
        }
        const sheet = wb.Sheets[chosenSheetName]!;
        rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
          raw: false, // keep formatting (e.g. "$49.99" as string)
        });
        headers = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      } else {
        throw new Error(`Unsupported file type: ${ext}. Upload CSV or XLSX.`);
      }

      if (rows.length === 0) {
        throw new Error('Empty file — no data rows found.');
      }
      if (rows.length > 35_000) {
        throw new Error(
          `File has ${rows.length} rows. Max per import is 35,000 — split the file and try again.`,
        );
      }

      // Side-file detection: photo-enrichment outputs (status + via +
      // error columns) shouldn't be imported as a primary manifest.
      // Warn but still let the operator proceed if they really mean it.
      if (looksLikeSideFile(headers)) {
        setParseError(
          'This looks like a photo-enrichment output (has status / via / error columns), not a primary manifest. ' +
            'Importing it will create rows with mostly-empty fields. Continue at your own risk by re-uploading, or pick a different file.',
        );
      }

      // Auto-detect mappings — first column that matches a field wins
      // by default, but the operator can later add the same field to
      // additional columns or stack multiple fields onto one column.
      // We pass a sample of column values so value-sniffs (UPC-A
      // numerics, photo URLs, pallet codes) override ambiguous headers.
      const initialMapping: Record<string, FieldKey[]> = {};
      const used = new Set<FieldKey>();
      const sampleSize = Math.min(50, rows.length);
      for (const h of headers) {
        const sampleValues = rows.slice(0, sampleSize).map((r) => r[h]);
        const detected = autoDetectField(h, sampleValues);
        if (!detected || used.has(detected)) {
          initialMapping[h] = [];
        } else {
          initialMapping[h] = [detected];
          used.add(detected);
        }
      }

      setParsed({ filename: file.name, headers, rows });
      setMapping(initialMapping);
      setStep('map');
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  // Translate parsed.rows + mapping into the CommitInput row shape.
  const previewRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.slice(0, 10).map((raw) => buildCommitRow(raw, mapping));
  }, [parsed, mapping]);

  const totalUsableRows = useMemo(() => {
    if (!parsed) return 0;
    return parsed.rows.reduce((acc, raw) => {
      const r = buildCommitRow(raw, mapping);
      return acc + (r.title ? 1 : 0);
    }, 0);
  }, [parsed, mapping]);

  // Wayfair Option B: how many scannable boxes the import will create after
  // splitting comma-separated tracking numbers. Equals totalUsableRows when no
  // tracking column is mapped (no expansion).
  const expandedBoxCount = useMemo(() => {
    if (!parsed) return 0;
    let n = 0;
    for (const raw of parsed.rows) {
      const r = buildCommitRow(raw, mapping);
      if (!r.title) continue;
      const t = r.tracking_number?.trim();
      if (!t) {
        n += 1;
        continue;
      }
      n += countTrackingTokens(t);
    }
    return n;
  }, [parsed, mapping]);

  // Mapping sanity (#332, ported here when Smart Import was retired). Mapping
  // a link column onto Title passed every check this wizard had — it asked
  // only whether SOMETHING was mapped there, which is exactly how 1,369 lots
  // came in titled "https://www.amazon.com/dp/…". These look at the values.
  // One pass over the file, both fields, so a large manifest is scanned once.
  const { urlTitleProblem, codeCategoryProblem } = useMemo(() => {
    if (!parsed) return { urlTitleProblem: null, codeCategoryProblem: null };
    const titles: Array<string | null | undefined> = [];
    const categories: Array<string | null | undefined> = [];
    for (const raw of parsed.rows) {
      const r = buildCommitRow(raw, mapping);
      titles.push(r.title);
      categories.push(r.category_raw);
    }
    return {
      urlTitleProblem: findUrlTitleProblem(titles, columnForField(mapping, 'title')),
      codeCategoryProblem: findCodeCategoryProblem(
        categories,
        columnForField(mapping, 'category_raw'),
      ),
    };
  }, [parsed, mapping]);

  // URLs in Title block the import; coded categories only warn.
  const commitBlocked = pending || expandedBoxCount === 0 || urlTitleProblem !== null;

  function onCommit() {
    if (!parsed) {
      setCommitError('Upload a file first');
      return;
    }
    // Belt and braces: the button is disabled, but a mapping change could
    // race a click, and this is the check that was missing in the first place.
    if (urlTitleProblem) {
      setCommitError('Title is mapped to a link column — fix the mapping first.');
      return;
    }
    setCommitError(null);
    startTransition(async () => {
      const builtRows = parsed.rows
        .map((raw) => buildCommitRow(raw, mapping))
        .filter((r): r is NonNullable<ReturnType<typeof buildCommitRow>> & { title: string } =>
          r.title != null && r.title.length > 0,
        );
      // Wayfair Option B: one scannable box per tracking number. Rows with no
      // tracking pass through unchanged (tracking_number = null).
      //
      // Then key the untracked ones. This has to happen here, on the whole
      // file, and after the tracking expansion: the occurrence counter that
      // keeps two identical units apart needs to see every row at once, and
      // the server only ever sees one CHUNK_SIZE slice. Without it an
      // untracked manifest re-uploaded (a retry after a failed chunk, a
      // nervous second click) clones every box in it — mig 0309/0310, the
      // same bug the daily D2L feed had.
      const allRows = assignSourceKeys(expandRowsByTracking(builtRows), {
        filename: parsed.filename,
      });

      if (allRows.length === 0) {
        setCommitError('No rows have a usable title');
        return;
      }

      // Chunk the upload so each server-action request stays small. A 16k-box
      // manifest is ~12-16 MB in one shot (rows now carry the verbatim source
      // row in raw_data), well over the body limit. The first chunk creates the
      // import; the rest pass importId back to append to the SAME import, so the
      // whole file lands as one import. finalize=true on the last chunk.
      const CHUNK_SIZE = 800;
      let importId: string | undefined;
      let lastError: string | null = null;
      for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
        const slice = allRows.slice(i, i + CHUNK_SIZE);
        const result = await commitImport({
          filename: parsed.filename,
          source_label: sourceLabel.trim() || null,
          mapping,
          warehouse_id: warehouseId || null,
          rows: slice,
          importId,
          finalize: i + CHUNK_SIZE >= allRows.length,
        });
        if (!result.ok) {
          lastError = result.error;
          break;
        }
        importId = result.importId;
      }

      if (lastError) {
        setCommitError(lastError);
        return;
      }
      router.push('/imports');
    });
  }

  // ── UI ──
  if (step === 'upload') {
    return (
      <div style={{ maxWidth: 720 }}>
        <UploadCard onFile={handleFile} />
        {parseError && (
          <div
            role="region"
            aria-live="polite"
            style={{
              marginTop: 12,
              padding: 12,
              background: 'rgba(255, 59, 59, 0.1)',
              border: '1px solid var(--danger)',
              borderRadius: 6,
              color: 'var(--danger)',
              fontSize: 14,
            }}
          >
            {parseError}
          </div>
        )}
      </div>
    );
  }

  if (!parsed) return null;

  const fieldsAssigned = new Set<FieldKey>(
    Object.values(mapping).flatMap((arr) => arr ?? []),
  );
  const titleAssigned = fieldsAssigned.has('title');

  return (
    <div style={{ maxWidth: 1100, display: 'grid', gap: 24 }}>
      <Stepper step={step} />

      {step === 'map' && (
        <section style={{ display: 'grid', gap: 16 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
            }}
          >
            <Stat label="File" value={parsed.filename} small />
            <Stat label="Rows" value={String(parsed.rows.length)} />
            <Stat label="Columns" value={String(parsed.headers.length)} />
            <Stat
              label="Title-mapped rows"
              value={`${totalUsableRows}/${parsed.rows.length}`}
              accent={totalUsableRows < parsed.rows.length}
            />
            {expandedBoxCount !== totalUsableRows && (
              <Stat label="Scannable boxes" value={String(expandedBoxCount)} accent />
            )}
          </div>

          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.5fr)',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--bg-elev)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1.0,
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
              }}
            >
              <span>Source column</span>
              <span>Map to</span>
              <span>Sample value</span>
            </div>
            {parsed.headers.map((h) => {
              const sample = parsed.rows[0]?.[h];
              const sampleStr =
                sample == null || sample === ''
                  ? '—'
                  : String(sample).slice(0, 80) + (String(sample).length > 80 ? '…' : '');
              // Defensive: hot-reload during dev can leave stale state
              // shapes in memory. Guard against any non-array value.
              const raw = mapping[h];
              const assigned: FieldKey[] = Array.isArray(raw) ? raw : [];
              const remaining = FIELD_KEYS.filter((f) => !assigned.includes(f));
              return (
                <div
                  key={h}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.2fr)',
                    gap: 12,
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      color: 'var(--fg)',
                      fontSize: 13,
                      fontFamily: 'monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    {assigned.map((field) => (
                      <span
                        key={field}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          paddingLeft: 10,
                          paddingRight: 4,
                          paddingTop: 4,
                          paddingBottom: 4,
                          background: 'var(--accent-dim)',
                          color: 'var(--accent)',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {FIELD_LABELS[field]}
                        <button
                          type="button"
                          onClick={() =>
                            setMapping((prev) => ({
                              ...prev,
                              [h]: (prev[h] ?? []).filter((f) => f !== field),
                            }))
                          }
                          aria-label={`Remove ${FIELD_LABELS[field]} mapping`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            fontSize: 14,
                            lineHeight: 1,
                            padding: '0 4px',
                            opacity: 0.7,
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {assigned.length === 0 && (
                      <span style={{ color: 'var(--fg-dim)', fontSize: 12, fontStyle: 'italic' }}>
                        ignored
                      </span>
                    )}
                    {remaining.length > 0 && (
                      <select
                        value=""
                        aria-label={`Map column "${h}" to field`}
                        onChange={(e) => {
                          const f = e.target.value as FieldKey;
                          if (!f) return;
                          setMapping((prev) => ({
                            ...prev,
                            [h]: [...(prev[h] ?? []), f],
                          }));
                        }}
                        style={{
                          background: 'transparent',
                          color: 'var(--fg-muted)',
                          border: '1px dashed var(--border)',
                          borderRadius: 4,
                          padding: '4px 6px',
                          fontFamily: 'inherit',
                          fontSize: 12,
                        }}
                      >
                        <option value="">+ map to…</option>
                        {remaining.map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div
                    style={{
                      color: 'var(--fg-muted)',
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={sampleStr}
                  >
                    {sampleStr}
                  </div>
                </div>
              );
            })}
          </div>

          {!titleAssigned && (
            <div
              style={{
                padding: 12,
                background: 'rgba(255, 59, 59, 0.1)',
                border: '1px solid var(--danger)',
                borderRadius: 6,
                color: 'var(--danger)',
                fontSize: 14,
              }}
            >
              At least one column must be mapped to <strong>Title</strong>.
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              onClick={() => {
                setStep('upload');
                setParsed(null);
                setMapping({});
              }}
              style={{
                padding: '0.6rem 1.2rem',
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              ← Upload different file
            </button>
            <button
              type="button"
              onClick={() => setStep('commit')}
              disabled={!titleAssigned}
              style={{
                ...buttonStyle,
                color: '#000',
                fontWeight: 800,
                opacity: titleAssigned ? 1 : 0.4,
                cursor: titleAssigned ? 'pointer' : 'not-allowed',
              }}
            >
              Preview &amp; commit →
            </button>
          </div>
        </section>
      )}

      {step === 'commit' && (
        <section style={{ display: 'grid', gap: 16 }}>
          <div
            style={{
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-elev)',
              maxWidth: 720,
              fontSize: 13,
              color: 'var(--fg-muted)',
              lineHeight: 1.5,
            }}
          >
            Imported lots land as <strong style={{ color: 'var(--fg)' }}>pending intake</strong> —
            inventory records waiting on physical arrival. Pickers scan items into
            bins to flip them to <strong style={{ color: 'var(--fg)' }}>in inventory</strong>,
            and the Auction Builder is where they become live lots in an auction.
          </div>

          {/* Blocking. A row whose title is a link carries nothing to rebuild
              a real title from, so the only fix after the fact is the one the
              2026-09-11 batch got: repair or dispose, 1,369 rows at a time. */}
          {urlTitleProblem && (
            <div
              style={{
                padding: 12,
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.10)',
                maxWidth: 720,
                fontSize: 13,
                color: '#fca5a5',
                lineHeight: 1.5,
              }}
            >
              <strong>Title is mapped to a link column.</strong>{' '}
              {urlTitleProblem.matched} of {urlTitleProblem.checked} rows have a URL where the
              title should be
              {urlTitleProblem.column ? ` — the "${urlTitleProblem.column}" column` : ''}. First
              one: <code style={{ wordBreak: 'break-all' }}>{urlTitleProblem.sample}</code>. Go
              back to mapping and point Title at the product name.
            </div>
          )}

          {/* Advisory. 0220's trigger still resolves these to the right
              category_id, so the storefront is unaffected; it is the raw
              string Auction Builder renders. Not worth blocking an import. */}
          {codeCategoryProblem && (
            <div
              style={{
                padding: 12,
                border: '1px solid rgba(245, 158, 11, 0.4)',
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.10)',
                maxWidth: 720,
                fontSize: 13,
                color: '#fbbf24',
                lineHeight: 1.5,
              }}
            >
              <strong>Category looks like supplier codes.</strong>{' '}
              {codeCategoryProblem.matched} of {codeCategoryProblem.checked} rows read like
              &ldquo;{codeCategoryProblem.sample}&rdquo;. These still resolve to the right
              category, so the import is fine — the code just shows up in Auction Builder.
            </div>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              maxWidth: 720,
            }}
          >
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                Destination warehouse <span style={{ color: 'var(--fg-dim)' }}>(optional)</span>
              </span>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                style={{
                  background: 'var(--bg-elev)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '6px 8px',
                  fontFamily: 'inherit',
                  fontSize: 13,
                }}
              >
                <option value="">— decide at intake —</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                Source / truckload label{' '}
                <span style={{ color: 'var(--fg-dim)' }}>(optional)</span>
              </span>
              <input
                type="text"
                value={sourceLabel}
                onChange={(e) => setSourceLabel(e.target.value)}
                placeholder={
                  recentSources[0]
                    ? `e.g. ${recentSources[0]} or lowes / wayfair`
                    : 'lowes / wayfair / home depot'
                }
                list="recent-source-labels"
                style={{
                  background: 'var(--bg-elev)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '6px 8px',
                  fontFamily: 'inherit',
                  fontSize: 13,
                }}
              />
              {/* HTML5 datalist surfaces past values as autocomplete as
                  soon as the operator starts typing — no separate "click
                  to open" interaction needed. */}
              {recentSources.length > 0 && (
                <datalist id="recent-source-labels">
                  {recentSources.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
              {/* Quick-pick chips for one-tap re-use. Tap a chip and the
                  text input is filled in — covers the case where the
                  operator never thinks to type. Only renders when there
                  are prior labels to pick from. */}
              {recentSources.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    marginTop: 4,
                  }}
                >
                  {recentSources.slice(0, 8).map((s) => {
                    const active = sourceLabel.trim() === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSourceLabel(s)}
                        style={{
                          padding: '3px 8px',
                          background: active ? 'var(--accent-dim)' : 'transparent',
                          color: active ? 'var(--accent)' : 'var(--fg-muted)',
                          border: '1px solid',
                          borderColor: active ? 'var(--accent)' : 'var(--border)',
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                          letterSpacing: 0.3,
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              )}
            </label>
          </div>

          <div>
            {expandedBoxCount !== totalUsableRows && (
              <div
                style={{
                  marginBottom: 10,
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--accent)',
                  background: 'var(--accent-dim)',
                  color: 'var(--accent)',
                  fontSize: 13,
                }}
              >
                {totalUsableRows.toLocaleString()} manifest rows →{' '}
                <strong>{expandedBoxCount.toLocaleString()}</strong> scannable boxes
                {' '}(one import row per tracking #).
              </div>
            )}
            <h3 style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 8 }}>
              Preview — first 10 rows after mapping
            </h3>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'auto',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-elev)' }}>
                    {['Title', 'Category (raw)', 'MSRP', 'UPC', 'External', 'Photo'].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: 8,
                          borderBottom: '1px solid var(--border)',
                          color: 'var(--fg-muted)',
                          textAlign: 'left',
                          fontWeight: 800,
                          fontSize: 11,
                          letterSpacing: 0.8,
                          textTransform: 'uppercase',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td
                        style={{
                          padding: 8,
                          color: r.title ? 'var(--fg)' : 'var(--danger)',
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.title || <em>(no title — will be skipped)</em>}
                      </td>
                      <td style={{ padding: 8, color: 'var(--fg-muted)' }}>
                        {r.category_raw ?? '—'}
                      </td>
                      <td style={{ padding: 8, color: 'var(--fg)' }}>
                        {r.msrp_cents != null ? `$${(r.msrp_cents / 100).toFixed(2)}` : '—'}
                      </td>
                      <td style={{ padding: 8, color: 'var(--fg-muted)' }}>{r.upc ?? '—'}</td>
                      <td
                        style={{
                          padding: 8,
                          color: r.external_code ? 'var(--accent)' : 'var(--fg-dim)',
                          fontFamily: r.external_code ? 'monospace' : 'inherit',
                          fontSize: r.external_code ? 11 : 12,
                        }}
                      >
                        {r.external_code ?? '—'}
                      </td>
                      <td style={{ padding: 8, color: r.photo_url ? 'var(--success)' : 'var(--fg-dim)' }}>
                        {r.photo_url ? '✓' : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {commitError && (
            <div
              role="alert"
              style={{
                padding: 12,
                background: 'rgba(255, 59, 59, 0.1)',
                border: '1px solid var(--danger)',
                borderRadius: 6,
                color: 'var(--danger)',
                fontSize: 14,
              }}
            >
              {commitError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              onClick={() => setStep('map')}
              style={{
                padding: '0.6rem 1.2rem',
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              ← Back to mapping
            </button>
            <button
              type="button"
              onClick={onCommit}
              disabled={commitBlocked}
              style={{
                ...buttonStyle,
                color: '#000',
                fontWeight: 800,
                opacity: commitBlocked ? 0.4 : 1,
                cursor: commitBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              {pending ? 'Importing…' : `Import ${expandedBoxCount} → inventory`}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ── Helpers ──

function buildCommitRow(
  raw: Record<string, unknown>,
  mapping: Record<string, FieldKey[]>,
): CommitInput['rows'][number] {
  const out: Partial<Record<FieldKey, unknown>> = {};
  for (const [col, fields] of Object.entries(mapping)) {
    if (!fields || fields.length === 0) continue;
    const val = raw[col];
    if (val == null || val === '') continue;
    // Each source column can populate multiple internal fields. First
    // non-empty value per target field wins if multiple source
    // columns happen to map to the same target.
    for (const field of fields) {
      if (out[field] == null) out[field] = val;
    }
  }

  // Helper: trim a string field if present.
  const str = (k: FieldKey): string | null => {
    const v = out[k];
    if (v == null || v === '') return null;
    return String(v).trim() || null;
  };
  // Helper: trim and cap to N chars.
  const strN = (k: FieldKey, n: number): string | null => {
    const s = str(k);
    return s == null ? null : s.slice(0, n);
  };

  const title = str('title') ?? '';

  // Quantity: integer >= 1, default 1.
  let quantity = 1;
  if (out.quantity != null && out.quantity !== '') {
    const q = Number(String(out.quantity).replace(/[,\s]/g, ''));
    if (Number.isFinite(q) && q >= 1) quantity = Math.floor(q);
  }

  return {
    title,
    description: str('description'),
    brand: strN('brand', 120),
    model: strN('model', 120),
    category_raw: str('category_raw'),
    sub_category_raw: str('sub_category_raw'),
    product_sku: strN('product_sku', 64),
    site_sku: strN('site_sku', 64),
    manufacture_sku: strN('manufacture_sku', 64),
    catalog_id: strN('catalog_id', 64),
    order_id: strN('order_id', 64),
    po_number: strN('po_number', 64),
    upc: _normalizeUpc(out.upc) ?? strN('upc', 32),
    asin: strN('asin', 32),
    fnsku: strN('fnsku', 32),
    lpn: strN('lpn', 64),
    external_code: strN('external_code', 120),
    pallet_id: strN('pallet_id', 64),
    quantity,
    msrp_cents: parseCents(out.msrp_cents),
    cost_cents: parseCents(out.cost_cents),
    starting_bid_cents: parseCents(out.starting_bid_cents),
    photo_url:
      typeof out.photo_url === 'string' && /^https?:\/\//.test(out.photo_url)
        ? out.photo_url
        : null,
    condition: parseCondition(out.condition),
    return_reason: strN('return_reason', 200),
    // Raw (possibly comma-separated) tracking value; expandRowsByTracking
    // splits it into one row per tracking before commit.
    tracking_number: str('tracking_number'),
    // Preserve the verbatim source row so manifest columns without a dedicated
    // field (e.g. Wayfair's ProductSKU / SiteSKU / ManufactureSKU) survive into
    // import_rows.raw_data and can surface at lotting. Shared across the per-box
    // copies that expandRowsByTracking produces — fine, it's source provenance.
    raw_data: raw,
  };
}

// Wayfair multi-tracking split moved to a unit-testable module — see
// `apps/operator-web/src/lib/imports/expand-tracking.ts`. That module also
// broadens the split regex from comma-only to `[\s,]+` and adds a 12-14
// digit token filter (fixes the ~97 dirty BinGo rows where vendors packed
// space-separated trackings or tracking+note into one cell).

// ── Subcomponents ──

function Stepper({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'upload', label: '1. Upload' },
    { key: 'map', label: '2. Map columns' },
    { key: 'commit', label: '3. Preview & commit' },
  ];
  return (
    <nav aria-label="Import progress">
      <div style={{ display: 'flex', gap: 24 }}>
        {steps.map((s) => {
          const active = s.key === step;
          return (
            <div
              key={s.key}
              aria-current={active ? 'step' : undefined}
              style={{
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 1.0,
                textTransform: 'uppercase',
                color: active ? 'var(--accent)' : 'var(--fg-dim)',
              }}
            >
              {s.label}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function Stat({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: small ? 13 : 22,
          fontWeight: 900,
          color: accent ? 'var(--accent)' : 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function UploadCard({ onFile }: { onFile: (f: File) => void }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      htmlFor="import-file-input"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      style={{
        display: 'block',
        padding: 48,
        border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
        background: dragOver ? 'var(--accent-dim)' : 'var(--bg-elev)',
        borderRadius: 12,
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>📥</div>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Drop a CSV or XLSX file here</div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>or click to browse</div>
      <input
        id="import-file-input"
        type="file"
        accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
        style={{ display: 'none' }}
      />
    </label>
  );
}
