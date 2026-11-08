'use client';

// Client interactions for the GLOBAL manifest pool.
//
// Multi-select + bulk drop. No "lot N" path — lot creation is intake-only
// after migration 0059.

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { MoneyText, MonoText } from '@/components/console';
import { dropPoolRows } from './actions';

export type PoolRow = {
  id: string;
  import_id: string;
  title: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  asin: string | null;
  fnsku: string | null;
  lpn: string | null;
  external_code: string | null;
  msrp_cents: number | null;
  photo_url: string | null;
  condition: string | null;
  category_raw: string | null;
  created_at: string;
  // Supabase array-shape FK join when there's no relationship metadata
  // — same handling as the bins page.
  imports:
    | { filename: string; source_label: string | null }
    | { filename: string; source_label: string | null }[]
    | null;
};

export function ManifestPoolClient({
  canDrop,
  rows: initialRows,
}: {
  canDrop: boolean;
  rows: PoolRow[];
}) {
  const [rows, setRows] = useState<PoolRow[]>(initialRows);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size > 0) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  }

  async function handleDrop() {
    if (!canDrop) {
      setError('Only admin or manager can drop manifest rows.');
      return;
    }
    if (selected.size === 0) return;
    const reason = prompt(
      'Reason for marking these as not-sellable (max 200 chars):',
      'Damaged / not sellable',
    );
    if (reason === null) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const ids = Array.from(selected);
    const result = await dropPoolRows({
      rowIds: ids,
      reason: reason.trim() || null,
    });
    if (!result.ok) {
      setError(`Drop failed: ${result.error}`);
      setBusy(false);
      return;
    }
    startTransition(() => {
      setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
    });
    setSelected(new Set());
    setSuccess(`✓ Dropped ${result.dropped}.`);
    setBusy(false);
  }

  function importLabel(r: PoolRow): string {
    const imp = Array.isArray(r.imports) ? r.imports[0] : r.imports;
    if (!imp) return '—';
    return imp.source_label ? `${imp.source_label} · ${imp.filename}` : imp.filename;
  }

  function importId(r: PoolRow): string {
    return r.import_id;
  }

  function bestIdentifier(r: PoolRow): string {
    return r.upc ?? r.asin ?? r.fnsku ?? r.lpn ?? r.external_code ?? '—';
  }

  const selectedCount = selected.size;

  return (
    <div>
      {/* Bulk action bar — sticky so it follows scroll on long lists */}
      {selectedCount > 0 && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--accent)',
            color: '#000',
            borderRadius: 8,
            marginBottom: 10,
          }}
        >
          <strong style={{ fontSize: 14 }}>{selectedCount} selected</strong>
          <button
            type="button"
            onClick={handleDrop}
            disabled={busy || !canDrop}
            style={{
              ...buttonStyle,
              background: 'var(--danger)',
              color: '#fff',
              opacity: !canDrop ? 0.5 : 1,
            }}
            title={!canDrop ? 'Admin or manager only' : undefined}
          >
            {busy ? '…' : `✗ Drop ${selectedCount} as not-sellable`}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={busy}
            style={secondaryButtonStyle}
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--urgent-red-dim)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 6,
            marginBottom: 10,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--success-dim)',
            border: '1px solid var(--success)',
            color: 'var(--success)',
            borderRadius: 6,
            marginBottom: 10,
            fontSize: 13,
          }}
        >
          {success}
        </div>
      )}

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
            gridTemplateColumns: '32px minmax(0, 2fr) 130px 140px 120px 100px',
            gap: 10,
            padding: '10px 14px',
            background: 'var(--bg-elev)',
            borderBottom: '1px solid var(--border)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.0,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            alignItems: 'center',
          }}
        >
          <span>
            {rows.length > 0 && (
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === rows.length}
                onChange={toggleAll}
                style={{ cursor: 'pointer' }}
              />
            )}
          </span>
          <span>Title / Brand</span>
          <span>Identifier</span>
          <span>Source / import</span>
          <span>Category</span>
          <span>MSRP</span>
        </div>

        {rows.map((r) => {
          const checked = selected.has(r.id);
          return (
            <div
              key={r.id}
              onClick={() => toggleRow(r.id)}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px minmax(0, 2fr) 130px 140px 120px 100px',
                gap: 10,
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                alignItems: 'center',
                cursor: 'pointer',
                background: checked ? 'var(--accent-dim)' : 'transparent',
              }}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleRow(r.id)}
                  style={{ cursor: 'pointer' }}
                />
              </span>
              <div style={{ overflow: 'hidden' }}>
                <div
                  style={{
                    fontWeight: 600,
                    color: 'var(--fg)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.title}
                </div>
                {(r.brand || r.model) && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {[r.brand, r.model].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
              <MonoText dim style={{ fontSize: 12 }}>
                {bestIdentifier(r)}
              </MonoText>
              <Link
                href={`/imports/${importId(r)}`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textDecoration: 'none',
                }}
                title={importLabel(r)}
              >
                {importLabel(r)}
              </Link>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {r.category_raw ?? '—'}
              </span>
              {r.msrp_cents != null ? (
                <MoneyText cents={r.msrp_cents} style={{ fontSize: 13 }} />
              ) : (
                <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>—</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
