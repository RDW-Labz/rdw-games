'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { buttonStyle, inputStyle } from '@/components/Form';
import { commitMigrationImport, type MigrateRow } from './actions';

// ── Field keys for legacy migration mapping ──────────────────────────────────

type MigrateFieldKey =
  | 'lot_code'
  | 'title'
  | 'description'
  | 'brand'
  | 'model'
  | 'category_raw'
  | 'mpn'
  | 'photo_urls'
  | 'load_number'
  | 'legacy_platform';

const MIGRATE_FIELD_KEYS: MigrateFieldKey[] = [
  'lot_code',
  'title',
  'description',
  'brand',
  'model',
  'category_raw',
  'mpn',
  'photo_urls',
  'load_number',
  'legacy_platform',
];

const MIGRATE_FIELD_LABELS: Record<MigrateFieldKey, string> = {
  lot_code: 'Lot code (legacy — preserved verbatim)',
  title: 'Title',
  description: 'Description',
  brand: 'Brand',
  model: 'Model',
  category_raw: 'Category',
  mpn: 'MPN (Manufacturer Part Number)',
  photo_urls: 'Photo URL(s)',
  load_number: 'Load / truck number',
  legacy_platform: 'Source platform name',
};

// Required fields — both must be mapped before proceeding.
const REQUIRED_FIELDS = new Set<MigrateFieldKey>(['lot_code', 'title']);

// ── Header auto-detect ───────────────────────────────────────────────────────

const MIGRATE_HEADER_PATTERNS: Array<{
  field: MigrateFieldKey;
  pattern: RegExp;
}> = [
  {
    field: 'lot_code',
    pattern:
      /^lot[\s_-]*(code|number|#|id)$|^lot$|^legacy[\s_-]*code|^item[\s_-]*code$|^label[\s_-]*code|^sticker/i,
  },
  {
    field: 'photo_urls',
    pattern:
      /(photo|image|img|picture).*(url|link|src)?|^image$|^photo$|product\s*photos?|source[\s_-]*url/i,
  },
  { field: 'mpn', pattern: /^mpn$|manufacturer[\s_-]*part|^mfr[\s_-]*part/i },
  { field: 'load_number', pattern: /^load[\s_-]*(number|#|id)?$|^truck[\s_-]*(number|#|id)?$|^load$/i },
  { field: 'legacy_platform', pattern: /^legacy[\s_-]*platform|^source[\s_-]*platform|^platform$/i },
  { field: 'brand', pattern: /^brand$|^manufacturer$|^mfr$|^make$/i },
  { field: 'model', pattern: /^model$|model[\s_-]*(number|#|no)|manufacturer[\s_-]*part/i },
  { field: 'category_raw', pattern: /^category$|department|^class$|product[\s_-]*type/i },
  { field: 'description', pattern: /^long[\s_-]*desc|description$|details|^notes$/i },
  { field: 'title', pattern: /^title$|^productname$|product[\s_-]*name|^name$|item[\s_-]*desc|^product$/i },
];

function normalizeHeader(h: string): string {
  return String(h).toLowerCase().replace(/[​-‍﻿]/g, '').trim().replace(/\s+/g, ' ');
}

function autoDetectMigrateField(header: string): MigrateFieldKey | null {
  const n = normalizeHeader(header);
  for (const { field, pattern } of MIGRATE_HEADER_PATTERNS) {
    if (pattern.test(n)) return field;
  }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

type ParsedFile = {
  filename: string;
  headers: string[];
  rows: Record<string, unknown>[];
};

type Step = 'upload' | 'map' | 'confirm';

// ── Row builder ──────────────────────────────────────────────────────────────

function buildMigrateRow(
  raw: Record<string, unknown>,
  mapping: Record<string, MigrateFieldKey[]>,
  photoDelimiter: string,
  fallbackPlatform: string,
): Partial<MigrateRow> & { lot_code?: string; title?: string } {
  const out: Partial<Record<MigrateFieldKey, unknown>> = {};
  for (const [col, fields] of Object.entries(mapping)) {
    if (!fields || fields.length === 0) continue;
    const val = raw[col];
    if (val == null || val === '') continue;
    for (const field of fields) {
      if (out[field] == null) out[field] = val;
    }
  }

  const str = (k: MigrateFieldKey): string | null => {
    const v = out[k];
    if (v == null || v === '') return null;
    return String(v).trim() || null;
  };
  const strN = (k: MigrateFieldKey, n: number): string | null => {
    const s = str(k);
    return s == null ? null : s.slice(0, n);
  };

  // photo_urls: split on comma or pipe depending on operator choice.
  let photoUrls: string[] | null = null;
  const rawPhotos = str('photo_urls');
  if (rawPhotos) {
    const delim = photoDelimiter === 'pipe' ? '|' : ',';
    const parts = rawPhotos.split(delim).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
    if (parts.length > 0) photoUrls = parts;
  }

  return {
    lot_code: strN('lot_code', 64) ?? undefined,
    title: str('title') ?? undefined,
    description: strN('description', 5000),
    brand: strN('brand', 120),
    model: strN('model', 120),
    category_raw: strN('category_raw', 200),
    mpn: strN('mpn', 120),
    photo_urls: photoUrls,
    load_number: strN('load_number', 120),
    legacy_platform: strN('legacy_platform', 100) ?? fallbackPlatform,
  };
}

// ── Main component ───────────────────────────────────────────────────────────

export function MigrateWizard({
  warehouses,
}: {
  warehouses: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();

  const [step, setStep] = useState<Step>('upload');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, MigrateFieldKey[]>>({});
  const [sourceLabel, setSourceLabel] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [photoDelimiter, setPhotoDelimiter] = useState<'comma' | 'pipe'>('comma');
  const [parseError, setParseError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    batchId: string;
    inserted: number;
    skipped: number;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  // ── Step 1: file parsing ────────────────────────────────────────────────

  async function handleFile(file: File) {
    setParseError(null);
    const ext = file.name.toLowerCase().split('.').pop();
    try {
      let headers: string[];
      let rows: Record<string, unknown>[];

      if (ext === 'csv') {
        const text = await file.text();
        const r = Papa.parse<Record<string, unknown>>(text, {
          header: true,
          skipEmptyLines: 'greedy',
          dynamicTyping: false,
        });
        if (r.errors.length > 0 && r.errors[0]) throw new Error(r.errors[0].message);
        rows = r.data;
        headers = r.meta.fields ?? [];
      } else if (ext === 'xlsx' || ext === 'xls') {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        if (wb.SheetNames.length === 0) throw new Error('Workbook has no sheets');
        let chosenSheet = wb.SheetNames[0]!;
        const explicit = wb.SheetNames.find(
          (n) => n.trim().toLowerCase() === 'manifest',
        );
        if (explicit) {
          chosenSheet = explicit;
        } else {
          let maxRows = 0;
          for (const name of wb.SheetNames) {
            const s = wb.Sheets[name];
            if (!s) continue;
            const r2 = XLSX.utils.sheet_to_json(s, { defval: '' });
            if (r2.length > maxRows) { maxRows = r2.length; chosenSheet = name; }
          }
        }
        const sheet = wb.Sheets[chosenSheet]!;
        rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
          raw: false,
        });
        headers = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      } else {
        throw new Error(`Unsupported file type: ${ext}. Upload CSV or XLSX.`);
      }

      if (rows.length === 0) throw new Error('Empty file — no data rows found.');
      if (rows.length > 35_000) {
        throw new Error(
          `File has ${rows.length} rows. Max is 35,000 — split the file and try again.`,
        );
      }

      // Auto-detect column mapping.
      const initialMapping: Record<string, MigrateFieldKey[]> = {};
      const used = new Set<MigrateFieldKey>();
      for (const h of headers) {
        const detected = autoDetectMigrateField(h);
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

  // ── Derived state ───────────────────────────────────────────────────────

  const assignedFields = useMemo(
    () => new Set<MigrateFieldKey>(Object.values(mapping).flatMap((a) => a ?? [])),
    [mapping],
  );

  const requiredMet = useMemo(
    () => [...REQUIRED_FIELDS].every((f) => assignedFields.has(f)),
    [assignedFields],
  );

  const previewRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.slice(0, 3).map((raw) =>
      buildMigrateRow(raw, mapping, photoDelimiter, sourceLabel),
    );
  }, [parsed, mapping, photoDelimiter, sourceLabel]);

  const totalUsableRows = useMemo(() => {
    if (!parsed) return 0;
    return parsed.rows.reduce((acc, raw) => {
      const r = buildMigrateRow(raw, mapping, photoDelimiter, sourceLabel);
      return acc + (r.lot_code && r.title ? 1 : 0);
    }, 0);
  }, [parsed, mapping, photoDelimiter, sourceLabel]);

  // ── Step 3: commit ──────────────────────────────────────────────────────

  function onCommit() {
    if (!parsed) { setCommitError('Upload a file first.'); return; }
    if (!sourceLabel.trim()) { setCommitError('Source platform name is required.'); return; }
    setCommitError(null);

    startTransition(async () => {
      const allRows = parsed.rows
        .map((raw) => buildMigrateRow(raw, mapping, photoDelimiter, sourceLabel))
        .filter(
          (r): r is MigrateRow => !!(r.lot_code && r.title),
        );

      const res = await commitMigrationImport({
        sourceLabel: sourceLabel.trim(),
        filename: parsed.filename,
        columnMapping: mapping,
        rows: allRows,
        warehouseId: warehouseId || undefined,
      });

      if (!res.ok) {
        setCommitError(res.error);
        return;
      }
      setResult({ batchId: res.batchId, inserted: res.inserted, skipped: res.skipped });
    });
  }

  // ── Result screen ───────────────────────────────────────────────────────

  if (result) {
    return (
      <div style={{ maxWidth: 640, display: 'grid', gap: 20 }}>
        <div
          style={{
            padding: 20,
            background: 'rgba(0,200,80,0.08)',
            border: '1px solid rgba(0,200,80,0.3)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>
            Migration committed
          </div>
          <div style={{ fontSize: 14, color: 'var(--fg-muted)', display: 'grid', gap: 4 }}>
            <span>Lots inserted: <strong style={{ color: 'var(--fg)' }}>{result.inserted}</strong></span>
            <span>Rows skipped: <strong style={{ color: result.skipped > 0 ? 'var(--accent)' : 'var(--fg)' }}>{result.skipped}</strong></span>
            {result.skipped > 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
                Skipped rows have details in the batch record (duplicate codes, missing titles, etc.).
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <a
            href={`/imports/${result.batchId}`}
            style={{
              ...buttonStyle,
              color: '#000',
              fontWeight: 800,
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            View batch record →
          </a>
          <button
            type="button"
            onClick={() => router.push('/imports')}
            style={{
              padding: '0.6rem 1.2rem',
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Back to imports
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: upload ──────────────────────────────────────────────────────

  if (step === 'upload') {
    return (
      <div style={{ maxWidth: 720 }}>
        <UploadCard onFile={handleFile} />
        {parseError && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: 12,
              background: 'rgba(255,59,59,0.1)',
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

  // ── Step 2: column mapping ─────────────────────────────────────────────

  if (step === 'map') {
    return (
      <div style={{ maxWidth: 1100, display: 'grid', gap: 24 }}>
        <Stepper step={step} />

        {/* Source label */}
        <div style={{ maxWidth: 480 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              Source platform name{' '}
              <span style={{ color: 'var(--danger)' }}>*</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              e.g. BinGo, Prior CSV, Legacy Platform 2023
            </span>
            <input
              type="text"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              placeholder="BinGo"
              style={inputStyle}
            />
          </label>
        </div>

        {/* Stats */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          <StatCard label="File" value={parsed.filename} small />
          <StatCard label="Rows" value={String(parsed.rows.length)} />
          <StatCard label="Columns" value={String(parsed.headers.length)} />
          <StatCard
            label="Usable rows"
            value={`${totalUsableRows}/${parsed.rows.length}`}
            accent={totalUsableRows < parsed.rows.length}
          />
        </div>

        {/* Mapping table */}
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
              gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.5fr)',
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
            const raw = mapping[h];
            const assigned: MigrateFieldKey[] = Array.isArray(raw) ? raw : [];
            const remaining = MIGRATE_FIELD_KEYS.filter((f) => !assigned.includes(f));

            return (
              <div
                key={h}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr) minmax(0,1.2fr)',
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {assigned.map((field) => {
                    const isRequired = REQUIRED_FIELDS.has(field);
                    return (
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
                          background: isRequired ? 'rgba(255,59,59,0.1)' : 'var(--accent-dim)',
                          color: isRequired ? 'var(--danger)' : 'var(--accent)',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {MIGRATE_FIELD_LABELS[field]}
                        <button
                          type="button"
                          onClick={() =>
                            setMapping((prev) => ({
                              ...prev,
                              [h]: (prev[h] ?? []).filter((f) => f !== field),
                            }))
                          }
                          aria-label={`Remove ${MIGRATE_FIELD_LABELS[field]} mapping`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'currentColor',
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
                    );
                  })}
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
                        const f = e.target.value as MigrateFieldKey;
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
                          {MIGRATE_FIELD_LABELS[f]}
                          {REQUIRED_FIELDS.has(f) ? ' *' : ''}
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

        {/* Photo URL delimiter */}
        {assignedFields.has('photo_urls') && (
          <div style={{ maxWidth: 360 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                Photo URL delimiter
              </span>
              <select
                value={photoDelimiter}
                onChange={(e) => setPhotoDelimiter(e.target.value as 'comma' | 'pipe')}
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
                <option value="comma">Comma ( , )</option>
                <option value="pipe">Pipe ( | )</option>
              </select>
            </label>
          </div>
        )}

        {/* Validation messages */}
        {!assignedFields.has('lot_code') && (
          <ValidationWarning>
            Map a column to <strong>Lot code (legacy)</strong> — this is required to preserve
            existing physical labels.
          </ValidationWarning>
        )}
        {!assignedFields.has('title') && assignedFields.has('lot_code') && (
          <ValidationWarning>
            Map a column to <strong>Title</strong>.
          </ValidationWarning>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            type="button"
            onClick={() => { setStep('upload'); setParsed(null); setMapping({}); }}
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
            onClick={() => setStep('confirm')}
            disabled={!requiredMet || !sourceLabel.trim()}
            style={{
              ...buttonStyle,
              color: '#000',
              fontWeight: 800,
              opacity: requiredMet && sourceLabel.trim() ? 1 : 0.4,
              cursor: requiredMet && sourceLabel.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Review &amp; confirm →
          </button>
        </div>
      </div>
    );
  }

  // ── Step 3: confirm ────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 800, display: 'grid', gap: 20 }}>
      <Stepper step={step} />

      {/* Warning banner */}
      <div
        role="region"
        aria-label="Migration warning"
        style={{
          padding: 16,
          background: 'rgba(220,38,38,0.08)',
          border: '2px solid var(--danger)',
          borderRadius: 8,
          color: 'var(--danger)',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        <strong>Warning — legacy lot codes will be preserved verbatim.</strong> These lots will be
        created with the codes from your CSV exactly as-is. Make sure the codes do not collide with
        existing operator inventory. Rows with duplicate codes will be skipped automatically, but
        you should verify your CSV against current inventory before committing.
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        <StatCard label="Source platform" value={sourceLabel} small />
        <StatCard label="File" value={parsed.filename} small />
        <StatCard label="Total rows" value={String(parsed.rows.length)} />
        <StatCard
          label="Rows to import"
          value={String(totalUsableRows)}
          accent={totalUsableRows < parsed.rows.length}
        />
      </div>

      {/* Warehouse picker */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          maxWidth: 600,
        }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Destination warehouse{' '}
            <span style={{ color: 'var(--fg-dim)' }}>(optional)</span>
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
            <option value="">— decide at put-away —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Preview table — first 3 rows */}
      <div>
        <h3 style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 8 }}>
          Preview — first 3 mapped rows
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
                {['Lot code', 'Title', 'Brand', 'Category', 'Photos'].map((h) => (
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
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: r.lot_code ? 'var(--accent)' : 'var(--danger)',
                    }}
                  >
                    {r.lot_code ?? <em>(missing)</em>}
                  </td>
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
                    {r.title ?? <em>(missing)</em>}
                  </td>
                  <td style={{ padding: 8, color: 'var(--fg-muted)' }}>
                    {r.brand ?? '—'}
                  </td>
                  <td style={{ padding: 8, color: 'var(--fg-muted)' }}>
                    {r.category_raw ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: 8,
                      color:
                        r.photo_urls && r.photo_urls.length > 0
                          ? 'var(--success)'
                          : 'var(--fg-dim)',
                    }}
                  >
                    {r.photo_urls && r.photo_urls.length > 0
                      ? `${r.photo_urls.length} photo${r.photo_urls.length > 1 ? 's' : ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Initial status note */}
      <div
        style={{
          padding: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
          maxWidth: 640,
        }}
      >
        Lots will be created as{' '}
        <strong style={{ color: 'var(--fg)' }}>pending intake</strong> — physically present but
        not yet bin-assigned. Staff run put-away scans to flip them to{' '}
        <strong style={{ color: 'var(--fg)' }}>in inventory</strong>.
      </div>

      {commitError && (
        <div
          role="alert"
          style={{
            padding: 12,
            background: 'rgba(255,59,59,0.1)',
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
          disabled={pending || totalUsableRows === 0}
          style={{
            padding: '0.6rem 1.4rem',
            background: 'var(--danger)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: pending || totalUsableRows === 0 ? 'not-allowed' : 'pointer',
            fontWeight: 800,
            fontSize: 14,
            opacity: pending || totalUsableRows === 0 ? 0.5 : 1,
          }}
        >
          {pending
            ? 'Committing migration…'
            : `Commit migration — ${totalUsableRows} lot${totalUsableRows !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'upload', label: '1. Upload' },
    { key: 'map', label: '2. Map columns' },
    { key: 'confirm', label: '3. Confirm & commit' },
  ];
  return (
    <nav aria-label="Migration progress">
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

function StatCard({
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

function ValidationWarning({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        background: 'rgba(255,59,59,0.1)',
        border: '1px solid var(--danger)',
        borderRadius: 6,
        color: 'var(--danger)',
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

function UploadCard({ onFile }: { onFile: (f: File) => void }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      htmlFor="migrate-file-input"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
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
      <div style={{ fontSize: 32, marginBottom: 12 }}>📦</div>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        Drop a legacy-platform CSV or XLSX here
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
        Must include a lot code column and a title column
      </div>
      <input
        id="migrate-file-input"
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
