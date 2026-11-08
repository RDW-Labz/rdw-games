'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { createBin, createBinsBulk } from './actions';

// User feedback 2026-05-20: most operators don't carve bins down to a
// per-shelf "position" level — aisle/bay/level is enough. We hide the
// position input by default; an "Advanced: include position" toggle is
// available for operators who do need that fourth axis.

export function BinForm({ warehouseId }: { warehouseId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'single' | 'bulk'>('bulk');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // single
  const [code, setCode] = useState('');
  const [aisle, setAisle] = useState('A');
  const [bay, setBay] = useState('');
  const [level, setLevel] = useState('');
  const [position, setPosition] = useState('');
  // 0108: optional named zone (e.g. "Cold Storage"). Free-text.
  const [section, setSection] = useState('');
  const [x, setX] = useState('100');
  const [y, setY] = useState('100');

  // bulk
  const [bulkAisle, setBulkAisle] = useState('A');
  const [bulkBays, setBulkBays] = useState('1-10');
  const [bulkLevels, setBulkLevels] = useState('1-3');
  const [bulkPositions, setBulkPositions] = useState('');
  // Applies to every bin in the batch. Operators can override per-row via
  // the BinsTable edit form.
  const [bulkSection, setBulkSection] = useState('');
  const [skipExisting, setSkipExisting] = useState(true);

  function preview(): string | null {
    if (mode !== 'bulk') return null;
    const bays = parseSpec(bulkBays);
    const levels = parseSpec(bulkLevels);
    const positions = bulkPositions.trim()
      ? parseSpec(bulkPositions)
      : [null];
    if (!bays.length || !levels.length || !positions.length) return null;
    const total = bays.length * levels.length * positions.length;
    const sampleFirst =
      positions[0] == null
        ? `${bulkAisle}-${String(bays[0]).padStart(2, '0')}-${levels[0]}`
        : `${bulkAisle}-${String(bays[0]).padStart(2, '0')}-${levels[0]}-${String(positions[0]).padStart(2, '0')}`;
    const sampleLast =
      positions[positions.length - 1] == null
        ? `${bulkAisle}-${String(bays[bays.length - 1]).padStart(2, '0')}-${levels[levels.length - 1]}`
        : `${bulkAisle}-${String(bays[bays.length - 1]).padStart(2, '0')}-${levels[levels.length - 1]}-${String(positions[positions.length - 1]).padStart(2, '0')}`;
    return `${total} bin${total === 1 ? '' : 's'}: ${sampleFirst} through ${sampleLast}`;
  }

  async function onSingle(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSummary(null);
    setLoading(true);

    const autoCode = advanced && position
      ? `${aisle}-${bay.padStart(2, '0')}-${level || '1'}-${position.padStart(2, '0')}`
      : `${aisle}-${bay.padStart(2, '0')}-${level || '1'}`;

    const result = await createBin({
      warehouseId,
      code: code || autoCode,
      aisle,
      bay: bay || undefined,
      level: level ? Number(level) : undefined,
      position: advanced && position ? Number(position) : undefined,
      section: section.trim() ? section.trim() : undefined,
      xPx: Number(x),
      yPx: Number(y),
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCode('');
    setSummary('Bin added.');
    router.refresh();
  }

  async function onBulk(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSummary(null);
    setLoading(true);
    const result = await createBinsBulk({
      warehouseId,
      aisle: bulkAisle,
      bays: bulkBays,
      levels: bulkLevels,
      positions: advanced ? bulkPositions : undefined,
      section: bulkSection.trim() || undefined,
      skipExisting,
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSummary(
      result.created === 0
        ? `0 bins added — all ${result.skipped} codes already existed.`
        : `${result.created} bin${result.created === 1 ? '' : 's'} added${result.skipped ? ` · ${result.skipped} skipped (already existed)` : ''}.`,
    );
    router.refresh();
  }

  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setMode('bulk')}
          style={mode === 'bulk' ? buttonStyle : secondaryButtonStyle}
        >
          Bulk add
        </button>
        <button
          type="button"
          onClick={() => setMode('single')}
          style={mode === 'single' ? buttonStyle : secondaryButtonStyle}
        >
          Single bin
        </button>
        <label style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--fg-muted)' }}>
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvanced(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Advanced: include position
        </label>
      </div>

      {mode === 'single' ? (
        <form onSubmit={onSingle} style={{ display: 'grid', gap: '0.75rem' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: advanced ? 'repeat(5, 1fr)' : 'repeat(4, 1fr)',
              gap: '0.5rem',
            }}
          >
            <Field label="Aisle">
              <input style={inputStyle} value={aisle} onChange={(e) => setAisle(e.target.value)} required />
            </Field>
            <Field label="Bay">
              <input style={inputStyle} value={bay} onChange={(e) => setBay(e.target.value)} />
            </Field>
            <Field label="Level">
              <input style={inputStyle} value={level} onChange={(e) => setLevel(e.target.value)} />
            </Field>
            {advanced && (
              <Field label="Position">
                <input style={inputStyle} value={position} onChange={(e) => setPosition(e.target.value)} />
              </Field>
            )}
            <Field label="Code (auto if blank)">
              <input style={inputStyle} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          </div>
          <Field label="Section (optional — names a printable zone)">
            <input
              style={inputStyle}
              value={section}
              onChange={(e) => setSection(e.target.value)}
              placeholder="e.g. Cold Storage"
              maxLength={60}
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <Field label="x (pixels on floor plan)">
              <input style={inputStyle} type="number" value={x} onChange={(e) => setX(e.target.value)} required />
            </Field>
            <Field label="y (pixels on floor plan)">
              <input style={inputStyle} type="number" value={y} onChange={(e) => setY(e.target.value)} required />
            </Field>
          </div>
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          {summary && <div style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>{summary}</div>}
          <div>
            <button type="submit" disabled={loading} style={buttonStyle}>
              {loading ? 'Adding…' : 'Add bin'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={onBulk} style={{ display: 'grid', gap: '0.75rem' }}>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>
            Generates bins for an aisle × bays × levels{advanced ? ' × positions' : ''} grid.
            Then drag them onto the floor plan to set their physical positions.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: advanced ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)',
              gap: '0.5rem',
            }}
          >
            <Field label="Aisle">
              <input style={inputStyle} value={bulkAisle} onChange={(e) => setBulkAisle(e.target.value)} required />
            </Field>
            <Field label="Bays (e.g. 1-10)">
              <input style={inputStyle} value={bulkBays} onChange={(e) => setBulkBays(e.target.value)} required />
            </Field>
            <Field label="Levels (e.g. 1-3)">
              <input style={inputStyle} value={bulkLevels} onChange={(e) => setBulkLevels(e.target.value)} required />
            </Field>
            {advanced && (
              <Field label="Positions (e.g. 1-2)">
                <input style={inputStyle} value={bulkPositions} onChange={(e) => setBulkPositions(e.target.value)} />
              </Field>
            )}
          </div>
          {preview() && (
            <div style={{ color: 'var(--fg-muted)', fontSize: 12, fontStyle: 'italic' }}>
              Preview: {preview()}
            </div>
          )}
          <Field label="Section (optional — applies to every bin in the batch)">
            <input
              style={inputStyle}
              value={bulkSection}
              onChange={(e) => setBulkSection(e.target.value)}
              placeholder="e.g. Cold Storage"
              maxLength={60}
            />
          </Field>
          <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Skip codes that already exist (don&apos;t error on duplicates)
          </label>
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          {summary && <div style={{ color: 'var(--success, #4ade80)', fontSize: 13 }}>{summary}</div>}
          <div>
            <button type="submit" disabled={loading} style={buttonStyle}>
              {loading ? 'Generating…' : 'Generate bins'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function parseSpec(spec: string): Array<number> {
  const t = spec.trim();
  if (t.includes(',')) {
    return t
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m && m[1] && m[2]) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > hi) return [];
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  const n = Number(t);
  return Number.isFinite(n) ? [n] : [];
}
