'use client';

// Manifest pool client — view of expected items from a CSV import. The
// operator can multi-select pending rows and DROP them (mark as
// not-sellable: damaged, never arrived, etc.).
//
// Architectural note (migration 0059):
//   There is no "Lot N selected" button anymore. Lots come into existence
//   at physical intake — the picker scans the item's UPC/ASIN/FNSKU/LPN +
//   a bin QR, and the platform mints a fully-populated lot directly into
//   `in_inventory` at that moment. Manifest rows here are pure intent
//   until they're scanned in.
//
// Pending rows just sit until either:
//   • A picker scans the item against a bin → row.status flips to 'lotted'
//   • The operator clicks Drop → row.status flips to 'dropped'

import { useMemo, useState, useTransition } from 'react';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { StatusPill, MoneyText, MonoText } from '@/components/console';
import { dropSelectedRows } from './actions';

type Row = {
  id: string;
  title: string;
  description: string | null;
  category_raw: string | null;
  upc: string | null;
  external_code: string | null;
  msrp_cents: number | null;
  starting_bid_cents: number | null;
  photo_url: string | null;
  condition: string | null;
  status: 'pending' | 'lotted' | 'dropped';
  lot_id: string | null;
  lotted_at: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
  created_at: string;
};

export function ManifestPool({
  importId,
  initialRows,
}: {
  importId: string;
  initialRows: Row[];
}) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'pending' | 'lotted' | 'dropped'>(
    'pending',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [_, startTransition] = useTransition();

  const visibleRows = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const selectablePending = useMemo(
    () => visibleRows.filter((r) => r.status === 'pending'),
    [visibleRows],
  );

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectablePending.map((r) => r.id)));
    }
  }

  async function handleDrop() {
    if (selected.size === 0) return;
    const reason = prompt('Reason (optional, max 200 chars):', 'Damaged / not sellable');
    if (reason === null) return; // user cancelled
    setBusy(true);
    setError(null);
    setSuccess(null);
    const ids = Array.from(selected);
    const result = await dropSelectedRows({
      importId,
      rowIds: ids,
      reason: reason.trim() || null,
    });
    if (!result.ok) {
      setError(`Drop failed: ${result.error}`);
      setBusy(false);
      return;
    }
    startTransition(() => {
      setRows((prev) =>
        prev.map((r) =>
          ids.includes(r.id) && r.status === 'pending'
            ? {
                ...r,
                status: 'dropped' as const,
                dropped_at: new Date().toISOString(),
                dropped_reason: reason.trim() || null,
              }
            : r,
        ),
      );
    });
    setSelected(new Set());
    setSuccess(`✓ Dropped ${result.dropped}.`);
    setBusy(false);
  }

  const selectedCount = selected.size;

  return (
    <div>
      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['pending', 'lotted', 'dropped', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            type="button"
            style={{
              ...secondaryButtonStyle,
              background: filter === f ? 'var(--accent)' : 'var(--bg-elev)',
              color: filter === f ? '#000' : 'var(--fg)',
              fontWeight: filter === f ? 700 : 500,
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Bulk action bar */}
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
          <strong style={{ fontSize: 14 }}>
            {selectedCount} selected
          </strong>
          <button
            type="button"
            onClick={handleDrop}
            disabled={busy}
            style={{
              ...buttonStyle,
              background: 'var(--danger)',
              color: '#fff',
            }}
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

      {visibleRows.length === 0 ? (
        <div
          style={{
            padding: 24,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
          }}
        >
          {filter === 'pending'
            ? 'No pending rows in this manifest.'
            : `No ${filter} rows.`}
        </div>
      ) : (
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
              gridTemplateColumns: '32px minmax(0, 2fr) 110px 110px 100px 110px',
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
              {filter === 'pending' && selectablePending.length > 0 && (
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={
                    selected.size > 0 && selected.size === selectablePending.length
                  }
                  onChange={toggleAll}
                  style={{ cursor: 'pointer' }}
                />
              )}
            </span>
            <span>Title</span>
            <span>UPC</span>
            <span>Category</span>
            <span>MSRP</span>
            <span>Status</span>
          </div>

          {visibleRows.map((r) => {
            const isPending = r.status === 'pending';
            const checked = selected.has(r.id);
            return (
              <div
                key={r.id}
                onClick={() => isPending && toggleRow(r.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '32px minmax(0, 2fr) 110px 110px 100px 110px',
                  gap: 10,
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  cursor: isPending ? 'pointer' : 'default',
                  opacity: isPending ? 1 : 0.55,
                  background: checked ? 'var(--accent-dim)' : 'transparent',
                }}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  {isPending && (
                    <input
                      type="checkbox"
                      aria-label={`Select row ${r.title || r.id}`}
                      checked={checked}
                      onChange={() => toggleRow(r.id)}
                      style={{ cursor: 'pointer' }}
                    />
                  )}
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
                  {r.dropped_reason && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                      Dropped: {r.dropped_reason}
                    </div>
                  )}
                </div>
                <MonoText dim style={{ fontSize: 12 }}>
                  {r.upc ?? r.external_code ?? '—'}
                </MonoText>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {r.category_raw ?? '—'}
                </span>
                {r.msrp_cents != null ? (
                  <MoneyText cents={r.msrp_cents} style={{ fontSize: 13 }} />
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>—</span>
                )}
                <span>
                  <StatusPill status={r.status} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
