'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, secondaryButtonStyle, Field } from '@/components/Form';
import { updateBin, retireBin, unretireBin } from './actions';

export type BinRow = {
  id: string;
  code: string;
  aisle: string;
  bay: string | null;
  level: number | null;
  position: number | null;
  // 0108: optional named zone (e.g. "Cold Storage"). NULL = unsectioned.
  section: string | null;
  x_px: number;
  y_px: number;
  retired_at: string | null;
  // 0102: walk-mode scan timestamp. NULL = never physically verified.
  scanned_at: string | null;
};

type EditDraft = {
  binId: string;
  code: string;
  aisle: string;
  bay: string;
  level: string;
  section: string;
};

export function BinsTable({
  warehouseId,
  bins,
}: {
  warehouseId: string;
  bins: BinRow[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printAisle, setPrintAisle] = useState('');
  const [printSection, setPrintSection] = useState('');
  const [printing, setPrinting] = useState(false);

  // Filter: search by code/aisle, hide retired by default.
  // Sort: natural-numeric so "Right-01-2" comes before "Right-01-10" instead
  // of after it. The page query (.order('code')) only does lex sort, which
  // scrambles ranges where numeric segment widths differ. Migration 0107
  // renormalizes existing data to a fixed 2-digit width, but this sort is
  // defensive against any future drift or hand-typed codes.
  const f = filter.trim().toLowerCase();
  const visible = bins
    .filter((b) => showRetired || !b.retired_at)
    .filter((b) => {
      if (!f) return true;
      return b.code.toLowerCase().includes(f) || b.aisle.toLowerCase().includes(f);
    })
    .slice()
    .sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' }),
    );

  const activeCount = bins.filter((b) => !b.retired_at).length;
  const retiredCount = bins.length - activeCount;
  // Surface the position column only when some bin actually uses it. For
  // operators who skip position entirely (most), this hides a column of
  // ems.
  const anyPosition = bins.some((b) => b.position != null);
  const anySection = bins.some((b) => b.section);

  // Distinct aisles + sections among ACTIVE bins (the print pickers
  // shouldn't list values that exist only on retired bins).
  const distinctAisles = Array.from(
    new Set(bins.filter((b) => !b.retired_at).map((b) => b.aisle)),
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const distinctSections = Array.from(
    new Set(
      bins
        .filter((b) => !b.retired_at && b.section)
        .map((b) => b.section as string),
    ),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const unverifiedActiveCount = bins.filter(
    (b) => !b.retired_at && !b.scanned_at,
  ).length;

  function startEdit(b: BinRow) {
    setError(null);
    setEditing({
      binId: b.id,
      code: b.code,
      aisle: b.aisle,
      bay: b.bay ?? '',
      level: b.level == null ? '' : String(b.level),
      section: b.section ?? '',
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(visible.map((b) => b.id)));
  }
  function clearSelected() {
    setSelected(new Set());
  }

  // Open the resulting PDF in a new tab. The route returns
  // Content-Disposition: inline so it renders in the browser.
  async function openPrintPdf(filters: {
    bin_ids?: string[];
    aisles?: string[];
    sections?: string[];
    unverified_only?: boolean;
    search?: string;
  }) {
    setError(null);
    setPrinting(true);
    try {
      const res = await fetch(`/api/warehouses/${warehouseId}/qr-sheet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(filters),
      });
      if (!res.ok) {
        const detail = await res
          .json()
          .then((j) => (j as { error?: string }).error)
          .catch(() => null);
        setError(`Print failed${detail ? `: ${detail}` : ''}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      // Revoke after the new tab has a chance to load. Don't revoke
      // synchronously — Safari drops the open() target if you do.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!w) setError('Pop-up blocked — allow pop-ups to print labels.');
    } catch (e) {
      setError(`Print failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setPrinting(false);
    }
  }

  function cancelEdit() {
    setEditing(null);
    setError(null);
  }

  function onSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    startTransition(async () => {
      const result = await updateBin({
        binId: editing.binId,
        code: editing.code,
        aisle: editing.aisle,
        bay: editing.bay.trim() === '' ? null : editing.bay.trim(),
        level: editing.level.trim() === '' ? null : Number(editing.level),
        // Empty section input clears the column.
        section: editing.section.trim() === '' ? null : editing.section.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      router.refresh();
    });
  }

  function onRetire(b: BinRow) {
    if (!confirm(`Retire bin ${b.code}? It will stop accepting new staging but existing pickups continue to work. You can restore it later.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await retireBin(b.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function onRestore(b: BinRow) {
    setError(null);
    startTransition(async () => {
      const result = await unretireBin(b.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
          marginBottom: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <input
          placeholder="Search code or aisle…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 260 }}
        />
        <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Show retired ({retiredCount})
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--fg-muted)' }}>
          {visible.length} shown · {activeCount} active{retiredCount > 0 ? ` · ${retiredCount} retired` : ''}
        </span>
      </div>

      {/* Print toolbar — POSTs filtered bin_ids/aisles/sections to the
          qr-sheet route. Each button opens the resulting PDF in a new tab.
          Replaces the old single "Print QR sheet" link that printed every
          active bin in the warehouse. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 10px',
          marginBottom: '0.75rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          flexWrap: 'wrap',
          fontSize: 12,
        }}
      >
        <strong style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Print labels:</strong>
        <button
          type="button"
          disabled={printing || selected.size === 0}
          onClick={() => openPrintPdf({ bin_ids: Array.from(selected) })}
          style={{
            ...secondaryButtonStyle,
            padding: '4px 10px',
            fontSize: 12,
            opacity: selected.size === 0 ? 0.5 : 1,
          }}
          title={
            selected.size === 0
              ? 'Tick the rows you want to print first'
              : `Print ${selected.size} selected bin${selected.size === 1 ? '' : 's'}`
          }
        >
          Selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={printing || visible.length === 0}
          onClick={() =>
            openPrintPdf(
              filter.trim()
                ? { search: filter.trim() }
                : {
                    // No search term means "print every visible row" which
                    // is the same as printing the whole warehouse. Send
                    // the explicit bin_ids so retired rows the user toggled
                    // into view are still excluded if they want active-only.
                    bin_ids: visible.filter((b) => !b.retired_at).map((b) => b.id),
                  },
            )
          }
          style={{ ...secondaryButtonStyle, padding: '4px 10px', fontSize: 12 }}
          title="Print bins matching the current search filter"
        >
          Filtered ({visible.filter((b) => !b.retired_at).length})
        </button>
        <select
          value={printAisle}
          onChange={(e) => {
            const v = e.target.value;
            setPrintAisle(v);
            if (v) {
              openPrintPdf({ aisles: [v] });
              setPrintAisle('');
            }
          }}
          disabled={printing || distinctAisles.length === 0}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 12, maxWidth: 160 }}
        >
          <option value="">By aisle…</option>
          {distinctAisles.map((a) => (
            <option key={a} value={a}>
              Aisle {a}
            </option>
          ))}
        </select>
        <select
          value={printSection}
          onChange={(e) => {
            const v = e.target.value;
            setPrintSection(v);
            if (v) {
              openPrintPdf({ sections: [v] });
              setPrintSection('');
            }
          }}
          disabled={printing || distinctSections.length === 0}
          title={
            distinctSections.length === 0
              ? 'No sections defined yet — assign sections via Edit'
              : 'Print one named section'
          }
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 12, maxWidth: 200 }}
        >
          <option value="">By section…</option>
          {distinctSections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={printing || unverifiedActiveCount === 0}
          onClick={() => openPrintPdf({ unverified_only: true })}
          style={{
            ...secondaryButtonStyle,
            padding: '4px 10px',
            fontSize: 12,
            opacity: unverifiedActiveCount === 0 ? 0.5 : 1,
          }}
          title={
            unverifiedActiveCount === 0
              ? 'Every active bin has been walk-verified'
              : 'Print bins that have never been physically scanned via walk mode'
          }
        >
          Unverified ({unverifiedActiveCount})
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={clearSelected}
            style={{
              ...secondaryButtonStyle,
              padding: '4px 8px',
              fontSize: 11,
              marginLeft: 4,
            }}
          >
            Clear selection
          </button>
        )}
        <a
          href={`/api/warehouses/${warehouseId}/qr-sheet`}
          target="_blank"
          rel="noreferrer"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--fg-muted)',
            textDecoration: 'underline',
          }}
        >
          Print everything
        </a>
      </div>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: '0.5rem', fontSize: 13 }}>{error}</div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 13 }}>
            <th style={{ ...th, width: 28 }}>
              <input
                type="checkbox"
                aria-label="select all visible"
                checked={selected.size > 0 && visible.every((b) => selected.has(b.id))}
                ref={(el) => {
                  if (el) {
                    el.indeterminate =
                      selected.size > 0 &&
                      !visible.every((b) => selected.has(b.id));
                  }
                }}
                onChange={(e) => {
                  if (e.target.checked) selectAllVisible();
                  else clearSelected();
                }}
              />
            </th>
            <th style={th}>Code</th>
            <th style={th}>Aisle</th>
            <th style={th}>Bay</th>
            <th style={th}>Level</th>
            {anyPosition && <th style={th}>Pos</th>}
            {anySection && <th style={th}>Section</th>}
            <th style={th}>Verified</th>
            <th style={th}>Status</th>
            <th style={{ ...th, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((b) => {
            const isEditing = editing?.binId === b.id;
            const isRetired = !!b.retired_at;
            return (
              <tr key={b.id} style={{ opacity: isRetired ? 0.55 : 1 }}>
                {isEditing ? (
                  // colSpan accounts for: checkbox + code + aisle + bay + level +
                  // (position?) + (section?) + verified + status + actions.
                  <td
                    colSpan={
                      9 + (anyPosition ? 1 : 0) + (anySection ? 1 : 0)
                    }
                    style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}
                  >
                    <form onSubmit={onSaveEdit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <Field label="Code">
                        <input
                          style={{ ...inputStyle, width: 160 }}
                          value={editing.code}
                          onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                          required
                        />
                      </Field>
                      <Field label="Aisle">
                        <input
                          style={{ ...inputStyle, width: 80 }}
                          value={editing.aisle}
                          onChange={(e) => setEditing({ ...editing, aisle: e.target.value })}
                          required
                        />
                      </Field>
                      <Field label="Bay">
                        <input
                          style={{ ...inputStyle, width: 80 }}
                          value={editing.bay}
                          onChange={(e) => setEditing({ ...editing, bay: e.target.value })}
                        />
                      </Field>
                      <Field label="Level">
                        <input
                          style={{ ...inputStyle, width: 80 }}
                          value={editing.level}
                          onChange={(e) => setEditing({ ...editing, level: e.target.value })}
                        />
                      </Field>
                      <Field label="Section (optional)">
                        <input
                          style={{ ...inputStyle, width: 160 }}
                          value={editing.section}
                          onChange={(e) => setEditing({ ...editing, section: e.target.value })}
                          placeholder="e.g. Cold Storage"
                          maxLength={60}
                        />
                      </Field>
                      <button type="submit" disabled={pending} style={buttonStyle}>
                        {pending ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" onClick={cancelEdit} style={secondaryButtonStyle}>
                        Cancel
                      </button>
                    </form>
                  </td>
                ) : (
                  <>
                    <td style={{ ...td, width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label={`select ${b.code}`}
                        checked={selected.has(b.id)}
                        onChange={() => toggleSelected(b.id)}
                        disabled={isRetired}
                      />
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{b.code}</td>
                    <td style={td}>{b.aisle}</td>
                    <td style={td}>{b.bay ?? '—'}</td>
                    <td style={td}>{b.level ?? '—'}</td>
                    {anyPosition && <td style={td}>{b.position ?? '—'}</td>}
                    {anySection && (
                      <td style={{ ...td, fontSize: 12, color: 'var(--fg-muted)' }}>
                        {b.section ?? '—'}
                      </td>
                    )}
                    <td style={{ ...td, fontSize: 12 }}>
                      {b.scanned_at ? (
                        <span
                          style={{ color: 'var(--success, #4ade80)' }}
                          title={`Walk-verified ${new Date(b.scanned_at).toLocaleString()}`}
                        >
                          ✓
                        </span>
                      ) : (
                        <span
                          style={{ color: 'var(--fg-muted)' }}
                          title="Never scanned in walk mode"
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td style={td}>
                      {isRetired ? (
                        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Retired</span>
                      ) : (
                        <span style={{ color: 'var(--success, #4ade80)', fontSize: 12 }}>Active</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        {!isRetired ? (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(b)}
                              disabled={pending}
                              style={{ ...secondaryButtonStyle, padding: '0.25rem 0.6rem', fontSize: 12 }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => onRetire(b)}
                              disabled={pending}
                              style={{
                                ...secondaryButtonStyle,
                                padding: '0.25rem 0.6rem',
                                fontSize: 12,
                                borderColor: 'var(--danger, #f87171)',
                                color: 'var(--danger, #f87171)',
                              }}
                            >
                              Retire
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onRestore(b)}
                            disabled={pending}
                            style={{ ...secondaryButtonStyle, padding: '0.25rem 0.6rem', fontSize: 12 }}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr>
              <td
                colSpan={9 + (anyPosition ? 1 : 0) + (anySection ? 1 : 0)}
                style={{ padding: '1rem', textAlign: 'center', color: 'var(--fg-muted)' }}
              >
                {filter ? 'No bins match the filter.' : showRetired ? 'No bins yet.' : 'No active bins.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const th = {
  padding: '0.5rem',
  borderBottom: '1px solid var(--border)',
};
const td = {
  padding: '0.5rem',
  borderBottom: '1px solid var(--border)',
};
