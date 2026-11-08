'use client';

// Client side of the manifest queue. Two paths:
//   - Pre-filled rows (cache hit on the row's UPC): land directly in
//     'review' state with a candidate ready for apply. No fetch needed.
//   - Cold rows: per-row "Enrich" button calls /api/lottr/enrich-lot,
//     which now accepts importRowId.
//
// Either way "Apply" posts the chosen fields to /api/lottr/apply-
// enrichment, which patches the import_row in place. The operator sees
// their changes locally so they don't need a refresh.

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import type { LotCandidate } from '@auction-platform/domain-lotting';

type Row = {
  id: string;
  title: string;
  description: string | null;
  upc: string | null;
  external_code: string | null;
  msrp_cents: number | null;
  starting_bid_cents: number | null;
  photo_url: string | null;
  category_raw: string | null;
  condition: string | null;
  created_at: string;
  import_filename: string;
  import_id: string;
};

type EnrichmentState =
  | { kind: 'idle' }
  | { kind: 'looking' }
  | { kind: 'failed'; reason: string }
  | {
      kind: 'review';
      candidate: LotCandidate;
      chosen: Set<string>;
      /** True if this candidate came from product_lookups (pre-filled at
       *  page load), false if from a fresh /api/lottr/enrich-lot call. */
      fromCache?: boolean;
    }
  | { kind: 'applied'; appliedCount: number };

function defaultChosenFields(c: LotCandidate): Set<string> {
  const chosen = new Set<string>();
  if (c.title) chosen.add('title');
  if (c.description || c.specs) chosen.add('description');
  if (c.category && c.category !== 'Other') chosen.add('category');
  if (c.msrp) chosen.add('msrp');
  if (c.startBid) chosen.add('startBid');
  if (c.upc) chosen.add('upc');
  if (c.stockPhotos.length > 0) chosen.add('photos');
  return chosen;
}

const FIELD_LABELS: Array<{
  key: string;
  label: string;
  describe: (c: LotCandidate) => string;
}> = [
  { key: 'title', label: 'Title', describe: (c) => c.title || '(empty)' },
  { key: 'description', label: 'Description', describe: (c) => c.description || c.specs || '(empty)' },
  { key: 'category', label: 'Category', describe: (c) => c.category || '(empty)' },
  { key: 'msrp', label: 'MSRP', describe: (c) => (c.msrp ? `$${c.msrp.toFixed(2)}` : '—') },
  { key: 'startBid', label: 'Starting bid', describe: (c) => (c.startBid ? `$${c.startBid.toFixed(2)}` : '—') },
  { key: 'upc', label: 'UPC', describe: (c) => c.upc || '—' },
  { key: 'photos', label: 'Photos', describe: (c) => `${c.stockPhotos.length} stock photo(s)` },
];

export function ManifestQueue({
  initialRows,
  prefilled,
}: {
  initialRows: Row[];
  /** importRowId → cached LotCandidate. Rows with a pre-filled candidate
   *  land in 'review' state immediately, skipping the Enrich click. */
  prefilled?: Record<string, LotCandidate>;
}) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [state, setState] = useState<Record<string, EnrichmentState>>(() => {
    if (!prefilled) return {};
    const initial: Record<string, EnrichmentState> = {};
    for (const [rowId, candidate] of Object.entries(prefilled)) {
      initial[rowId] = {
        kind: 'review',
        candidate,
        chosen: defaultChosenFields(candidate),
        fromCache: true,
      };
    }
    return initial;
  });
  const [_, startTransition] = useTransition();

  function setRowState(rowId: string, s: EnrichmentState) {
    startTransition(() => {
      setState((prev) => ({ ...prev, [rowId]: s }));
    });
  }

  async function enrich(row: Row) {
    setRowState(row.id, { kind: 'looking' });
    try {
      const res = await fetch('/api/lottr/enrich-lot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importRowId: row.id }),
      });
      const body = (await res.json()) as
        | { ok: true; candidate: LotCandidate }
        | { ok: false; reason: string };
      if (!body.ok) {
        setRowState(row.id, { kind: 'failed', reason: body.reason });
        return;
      }
      const chosen = defaultChosenFields(body.candidate);
      setRowState(row.id, { kind: 'review', candidate: body.candidate, chosen });
    } catch (err) {
      setRowState(row.id, { kind: 'failed', reason: (err as Error).message });
    }
  }

  function toggleField(rowId: string, field: string) {
    const s = state[rowId];
    if (!s || s.kind !== 'review') return;
    const next = new Set(s.chosen);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    setRowState(rowId, { ...s, chosen: next });
  }

  async function apply(row: Row) {
    const s = state[row.id];
    if (!s || s.kind !== 'review') return;
    const fields = Array.from(s.chosen);
    if (fields.length === 0) {
      setRowState(row.id, { kind: 'idle' });
      return;
    }
    setRowState(row.id, { kind: 'looking' });
    try {
      const res = await fetch('/api/lottr/apply-enrichment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importRowId: row.id,
          candidate: s.candidate,
          fields,
        }),
      });
      const body = (await res.json()) as
        | { ok: true; applied: number }
        | { ok: false; reason: string };
      if (!body.ok) {
        setRowState(row.id, { kind: 'failed', reason: body.reason });
        return;
      }
      // Optimistically merge the candidate into the local row.
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== row.id) return r;
          const c = s.candidate;
          return {
            ...r,
            ...(s.chosen.has('title') && c.title ? { title: c.title } : {}),
            ...(s.chosen.has('description') && (c.description || c.specs)
              ? { description: c.description || c.specs }
              : {}),
            ...(s.chosen.has('msrp') && c.msrp ? { msrp_cents: Math.round(c.msrp * 100) } : {}),
            ...(s.chosen.has('startBid') && c.startBid
              ? { starting_bid_cents: Math.round(c.startBid * 100) }
              : {}),
            ...(s.chosen.has('upc') && c.upc ? { upc: c.upc } : {}),
            ...(s.chosen.has('category') && c.category ? { category_raw: c.category } : {}),
            ...(s.chosen.has('photos') && c.stockPhotos.length > 0
              ? { photo_url: c.stockPhotos[0] ?? null }
              : {}),
          };
        }),
      );
      setRowState(row.id, { kind: 'applied', appliedCount: body.applied });
    } catch (err) {
      setRowState(row.id, { kind: 'failed', reason: (err as Error).message });
    }
  }

  if (rows.length === 0) {
    return (
      <div
        style={{
          marginTop: '1.5rem',
          padding: '2rem',
          background: 'var(--bg-elev)',
          border: '1px dashed var(--border)',
          borderRadius: 8,
          textAlign: 'center',
          color: 'var(--fg-muted)',
        }}
      >
        No pending manifest rows are missing MSRP. Either you&apos;ve already
        enriched everything, or your manifests already had retail prices
        populated. Go to <Link href="/lottr/batch">Batch UPC lookup</Link> to
        scan UPCs ad-hoc, or <Link href="/imports/new">import a fresh CSV</Link>.
      </div>
    );
  }

  return (
    <div style={{ marginTop: '1.5rem', display: 'grid', gap: '0.75rem', maxWidth: 1080 }}>
      {rows.map((row) => {
        const s = state[row.id] ?? { kind: 'idle' as const };
        const code = row.upc ?? row.external_code;
        return (
          <div
            key={row.id}
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '1rem',
            }}
          >
            <header
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  style={{
                    color: 'var(--accent)',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                  }}
                >
                  Manifest row · {' '}
                  <Link
                    href={`/imports/${row.import_id}`}
                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                  >
                    {row.import_filename}
                  </Link>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
                  {row.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    marginTop: 4,
                  }}
                >
                  {code ? `UPC ${code} · ` : ''}
                  {row.category_raw ?? 'no category'} · {row.condition ?? 'no condition'}
                </div>
              </div>
              <RowAction
                state={s}
                onEnrich={() => enrich(row)}
                onApply={() => apply(row)}
                onCancel={() => setRowState(row.id, { kind: 'idle' })}
              />
            </header>

            {s.kind === 'failed' && (
              <div
                style={{
                  marginTop: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  background: 'rgba(255, 90, 90, 0.08)',
                  border: '1px solid var(--danger)',
                  color: 'var(--danger)',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                {s.reason}
              </div>
            )}

            {s.kind === 'applied' && (
              <div
                style={{
                  marginTop: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  background: 'rgba(34, 211, 154, 0.08)',
                  border: '1px solid var(--success, #22c55e)',
                  color: 'var(--success, #22c55e)',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                ✓ Applied {s.appliedCount} field{s.appliedCount === 1 ? '' : 's'}.
                Ready to lot from{' '}
                <Link href={`/imports/${row.import_id}`} style={{ color: 'inherit' }}>
                  the manifest pool
                </Link>
                .
              </div>
            )}

            {s.kind === 'review' && (
              <div
                style={{
                  marginTop: '0.75rem',
                  padding: '0.75rem',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--fg-muted)',
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    marginBottom: 8,
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                  }}
                >
                  <span>
                    {s.fromCache ? 'Cached candidate' : 'Fresh candidate'} ·{' '}
                    {s.candidate.confidence} confidence
                  </span>
                  {s.fromCache && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: 'rgba(34, 211, 154, 0.12)',
                        color: 'var(--success, #22c55e)',
                        border: '1px solid var(--success, #22c55e)',
                      }}
                    >
                      INSTANT
                    </span>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {FIELD_LABELS.map((f) => (
                      <tr key={f.key} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.4rem', width: 32 }}>
                          <input
                            type="checkbox"
                            checked={s.chosen.has(f.key)}
                            onChange={() => toggleField(row.id, f.key)}
                          />
                        </td>
                        <td style={{ padding: '0.4rem', color: 'var(--fg-muted)', width: 110 }}>
                          {f.label}
                        </td>
                        <td style={{ padding: '0.4rem' }}>{f.describe(s.candidate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RowAction({
  state,
  onEnrich,
  onApply,
  onCancel,
}: {
  state: EnrichmentState;
  onEnrich: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  if (state.kind === 'looking') {
    return <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>working…</span>;
  }
  if (state.kind === 'review') {
    return (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" onClick={onApply} style={buttonStyle}>
          Apply
        </button>
        <button type="button" onClick={onCancel} style={secondaryButtonStyle}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button type="button" onClick={onEnrich} style={buttonStyle}>
      {state.kind === 'applied' ? 'Re-enrich' : 'Enrich'}
    </button>
  );
}
