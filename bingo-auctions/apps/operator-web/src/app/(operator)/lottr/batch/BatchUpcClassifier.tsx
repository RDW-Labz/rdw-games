'use client';

// Batch UPC classifier client component.
//
// Workflow:
//   1. Paste UPCs / ASINs into a textarea (one per line).
//   2. Click "Look up all" → POSTs each code to /api/lottr/lookup-code
//      sequentially (avoids hammering Anthropic's rate limit).
//   3. Each result lands in a row with a checkbox; review + uncheck
//      anything you don't want.
//   4. "Save selected as draft lots" calls /api/lottr/save-draft for
//      each checked row, returns the new lot codes.

import { useState, useTransition } from 'react';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import type { LotCandidate } from '@auction-platform/domain-lotting';

type Row = {
  code: string;
  status: 'pending' | 'looking' | 'ok' | 'failed' | 'no_match';
  candidate?: LotCandidate;
  error?: string;
  selected: boolean;
  savedAs?: string;
};

export function BatchUpcClassifier() {
  const [rawInput, setRawInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [_, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  function parseCodes(): string[] {
    return rawInput
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function lookupAll() {
    const codes = parseCodes();
    if (codes.length === 0) return;
    setRows(
      codes.map((c) => ({
        code: c,
        status: 'pending' as const,
        selected: true,
      })),
    );
    setBusy(true);

    // Tier 1 backend: cache hits are sub-100ms, eBay misses ~1s. Parallel
    // with a concurrency cap of 6 keeps the UI feeling instant on warm
    // caches and stays well under eBay's 5K/day rate limit on cold ones.
    const CONCURRENCY = 6;
    let cursor = 0;

    async function lookupOne(i: number) {
      const code = codes[i]!;
      startTransition(() => {
        setRows((prev) =>
          prev.map((r, j) => (j === i ? { ...r, status: 'looking' } : r)),
        );
      });
      try {
        const res = await fetch('/api/lottr/lookup-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body = (await res.json()) as
          | { ok: true; candidate: LotCandidate }
          | { ok: false; reason: string };
        startTransition(() => {
          setRows((prev) =>
            prev.map((r, j) => {
              if (j !== i) return r;
              if (body.ok) {
                return { ...r, status: 'ok', candidate: body.candidate };
              }
              return {
                ...r,
                status: body.reason === 'no_match' ? 'no_match' : 'failed',
                error: body.reason,
              };
            }),
          );
        });
      } catch (err) {
        startTransition(() => {
          setRows((prev) =>
            prev.map((r, j) =>
              j === i
                ? { ...r, status: 'failed', error: (err as Error).message }
                : r,
            ),
          );
        });
      }
    }

    async function worker() {
      while (cursor < codes.length) {
        const i = cursor++;
        await lookupOne(i);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, codes.length) }, () => worker()),
    );

    setBusy(false);
  }

  async function saveSelected() {
    setSaving(true);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!r.selected || r.status !== 'ok' || !r.candidate || r.savedAs) {
        continue;
      }
      try {
        const res = await fetch('/api/lottr/save-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidate: r.candidate }),
        });
        const body = (await res.json()) as
          | { ok: true; lotId: string; lotCode: string }
          | { ok: false; reason: string };
        startTransition(() => {
          setRows((prev) =>
            prev.map((row, j) => {
              if (j !== i) return row;
              if (body.ok) return { ...row, savedAs: body.lotCode };
              return { ...row, status: 'failed', error: body.reason };
            }),
          );
        });
      } catch (err) {
        startTransition(() => {
          setRows((prev) =>
            prev.map((row, j) =>
              j === i
                ? { ...row, status: 'failed', error: (err as Error).message }
                : row,
            ),
          );
        });
      }
    }
    setSaving(false);
  }

  function toggleRow(i: number) {
    setRows((prev) =>
      prev.map((r, j) => (j === i ? { ...r, selected: !r.selected } : r)),
    );
  }
  function toggleAll(selected: boolean) {
    setRows((prev) =>
      prev.map((r) => (r.status === 'ok' ? { ...r, selected } : r)),
    );
  }

  const okCount = rows.filter((r) => r.status === 'ok').length;
  const selectedCount = rows.filter((r) => r.status === 'ok' && r.selected && !r.savedAs).length;
  const savedCount = rows.filter((r) => r.savedAs).length;

  return (
    <div style={{ display: 'grid', gap: '1rem', maxWidth: 1080 }}>
      <textarea
        value={rawInput}
        onChange={(e) => setRawInput(e.target.value)}
        placeholder={'Paste codes — one per line\n\n885911548632\n885911445726\nB07XYZ1234'}
        rows={6}
        style={{
          ...inputStyle,
          fontFamily: 'monospace',
          minHeight: 120,
          resize: 'vertical',
        }}
        disabled={busy}
      />

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={lookupAll}
          disabled={busy || parseCodes().length === 0}
          style={{
            ...buttonStyle,
            opacity: busy || parseCodes().length === 0 ? 0.5 : 1,
            cursor: busy || parseCodes().length === 0 ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Looking up…' : `Look up ${parseCodes().length || ''} ${parseCodes().length === 1 ? 'code' : 'codes'}`}
        </button>

        {okCount > 0 && (
          <>
            <button
              type="button"
              onClick={() => toggleAll(true)}
              style={secondaryButtonStyle}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => toggleAll(false)}
              style={secondaryButtonStyle}
            >
              Deselect all
            </button>
            <button
              type="button"
              onClick={saveSelected}
              disabled={saving || selectedCount === 0}
              style={{
                ...buttonStyle,
                background: 'var(--success, #34d39a)',
                color: '#000',
                opacity: saving || selectedCount === 0 ? 0.5 : 1,
                cursor: saving || selectedCount === 0 ? 'default' : 'pointer',
              }}
            >
              {saving
                ? 'Saving…'
                : `Save ${selectedCount} selected as draft lot${selectedCount === 1 ? '' : 's'}`}
            </button>
          </>
        )}

        {savedCount > 0 && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            {savedCount} saved.
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <Th width={32}></Th>
              <Th width={140}>Code</Th>
              <Th>Title</Th>
              <Th width={90}>Brand</Th>
              <Th width={120}>MSRP / Avg / Start</Th>
              <Th width={120}>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: '1px solid var(--border)',
                  opacity: r.status === 'failed' || r.status === 'no_match' ? 0.6 : 1,
                }}
              >
                <Td>
                  {r.status === 'ok' && !r.savedAs && (
                    <input
                      type="checkbox"
                      checked={r.selected}
                      onChange={() => toggleRow(i)}
                    />
                  )}
                </Td>
                <Td style={{ fontFamily: 'monospace' }}>{r.code}</Td>
                <Td>
                  {r.candidate?.title || r.candidate?.fullTitle || ''}
                  {r.candidate?.model && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>
                      [{r.candidate.model}]
                    </span>
                  )}
                </Td>
                <Td>{r.candidate?.brand ?? ''}</Td>
                <Td>
                  {r.candidate
                    ? `$${(r.candidate.msrp ?? 0).toFixed(2)} / $${(r.candidate.avg ?? 0).toFixed(2)} / $${(r.candidate.startBid ?? 0).toFixed(2)}`
                    : ''}
                </Td>
                <Td>
                  <StatusBadge row={r} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ row }: { row: Row }) {
  if (row.savedAs) {
    return (
      <span style={{ color: 'var(--success, #34d39a)', fontWeight: 600 }}>
        ✓ {row.savedAs}
      </span>
    );
  }
  switch (row.status) {
    case 'pending':
      return <span style={{ color: 'var(--fg-muted)' }}>queued</span>;
    case 'looking':
      return <span style={{ color: 'var(--fg-muted)' }}>looking up…</span>;
    case 'ok':
      return <span style={{ color: 'var(--accent)' }}>{row.candidate?.confidence}</span>;
    case 'no_match':
      return <span style={{ color: 'var(--fg-muted)' }}>no match</span>;
    case 'failed':
      return (
        <span style={{ color: 'var(--danger)' }} title={row.error}>
          failed
        </span>
      );
  }
}

function Th({
  children,
  width,
}: {
  children?: React.ReactNode;
  width?: number;
}) {
  return (
    <th
      style={{
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        color: 'var(--fg-muted)',
        ...(width ? { width } : {}),
      }}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        padding: '0.5rem 0.75rem',
        verticalAlign: 'top',
        ...style,
      }}
    >
      {children}
    </td>
  );
}
