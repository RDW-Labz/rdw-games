'use client';

// Client-side form for /lotting/stickers. POSTs to /api/lots/blank-qr-sheet
// and downloads the resulting PDF via a blob URL → window.open(_blank).
// We pull the batch id off the response header (x-blank-qr-batch-id) and
// surface it inline so the operator can correlate the PDF with the "recent
// batches" table below without refreshing.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Size = 'avery_5160' | 'avery_5163' | 'thermal_2x4';

const SIZE_LABELS: Record<Size, string> = {
  avery_5160: 'Avery 5160 — 30 per sheet (1" × 2.625")',
  avery_5163: 'Avery 5163 — 10 per sheet (2" × 4")',
  thermal_2x4: 'Thermal 2" × 4" — one per page (direct print)',
};

const SIZE_HINTS: Record<Size, string> = {
  avery_5160:
    'Small. Best for compact lots — most density per sheet.',
  avery_5163: 'Large. Easier to scan in dim warehouses.',
  thermal_2x4: 'For direct label printers (Brother / Zebra / Rollo).',
};

const MAX_COUNT = 500;

export function BlankStickerForm() {
  const router = useRouter();
  const [count, setCount] = useState<number>(50);
  const [size, setSize] = useState<Size>('avery_5160');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      setError(`Count must be between 1 and ${MAX_COUNT}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/lots/blank-qr-sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count, size }),
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; detail?: string };
          if (body.detail) detail = body.detail;
          else if (body.error) detail = body.error;
        } catch {
          // Non-JSON error body — fall back to status code.
        }
        throw new Error(detail);
      }
      const batchId = res.headers.get('x-blank-qr-batch-id');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Open in a new tab so the operator can hit print from the
      // browser's PDF viewer. Revoke after a delay — closing too
      // early breaks Safari, which loads the PDF lazily.
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setLastBatchId(batchId);
      // Refresh the server-rendered "recent batches" table so the
      // freshly-minted batch appears at the top.
      startTransition(() => router.refresh());
    } catch (err) {
      setError((err as Error).message || 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
        background: 'var(--bg-elev)',
        maxWidth: 720,
        display: 'grid',
        gap: 12,
      }}
    >
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={labelStyle}>How many stickers</span>
        <input
          type="number"
          min={1}
          max={MAX_COUNT}
          step={1}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          disabled={busy}
          style={inputStyle}
        />
        <span style={hintStyle}>1–{MAX_COUNT} per batch.</span>
      </label>

      <fieldset
        style={{
          border: 0,
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 6,
        }}
      >
        <legend style={labelStyle}>Sticker size</legend>
        {(Object.keys(SIZE_LABELS) as Size[]).map((s) => (
          <label
            key={s}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              alignItems: 'start',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background:
                size === s ? 'var(--accent-dim)' : 'var(--bg)',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="radio"
              name="size"
              value={s}
              checked={size === s}
              onChange={() => setSize(s)}
              disabled={busy}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {SIZE_LABELS[s]}
              </span>
              <span
                style={{
                  display: 'block',
                  color: 'var(--fg-muted)',
                  fontSize: 12,
                  marginTop: 2,
                }}
              >
                {SIZE_HINTS[s]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid var(--danger, #b91c1c)',
            background: 'var(--danger-dim, rgba(185,28,28,0.1))',
            color: 'var(--danger, #b91c1c)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '10px 18px',
            background: busy ? 'var(--bg)' : 'var(--accent-dim)',
            color: busy ? 'var(--fg-muted)' : 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 6,
            cursor: busy ? 'wait' : 'pointer',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          {busy ? 'Minting…' : 'Generate PDF'}
        </button>
        {lastBatchId && !busy && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            Last printed batch:{' '}
            <code style={{ fontSize: 12 }}>
              {lastBatchId.slice(0, 8)}…
            </code>
          </span>
        )}
      </div>
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-muted)',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 14,
  width: 120,
};
