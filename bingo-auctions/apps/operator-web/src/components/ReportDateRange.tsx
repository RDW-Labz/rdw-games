'use client';

// Shared date-range filter for every reporting tab (owner ask 2026-07-25:
// "better date filters custom ranges on all reporting tabs").
//
// One control, one URL contract — `?from=YYYY-MM-DD&to=YYYY-MM-DD` — so a range
// picked on one tab means the same thing on the next and the tabs are directly
// comparable. Presets cover the common asks; the date inputs cover everything
// else. Other query params on the page (e.g. /reports/aging's ?cycles=) are
// preserved, so this composes with per-tab filters instead of clobbering them.
//
// Dates are plain YYYY-MM-DD and are interpreted server-side in the operator's
// warehouse timezone (see lib/datetime dayRangeInTimeZone) — NOT the browser's.
// The preset buttons compute their dates from the viewer's local clock, which is
// the same wall clock staff are looking at, so "last 7 days" means what they
// expect.

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState } from 'react';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';

type Preset = { label: string; days: number | 'mtd' | 'all' };

const PRESETS: Preset[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'MTD', days: 'mtd' },
  { label: 'All time', days: 'all' },
];

function ymd(d: Date): string {
  // Local-date YYYY-MM-DD (not toISOString, which would shift by the UTC offset
  // and silently move the boundary a day for anyone west of UTC).
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function presetRange(p: Preset): { from: string; to: string } | null {
  if (p.days === 'all') return null;
  const today = new Date();
  const to = ymd(today);
  if (p.days === 'mtd') {
    return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  }
  const start = new Date(today);
  start.setDate(start.getDate() - (p.days - 1));
  return { from: ymd(start), to };
}

export function ReportDateRange({
  from,
  to,
  /** Extra note rendered after the control (e.g. what the range is bucketed on). */
  hint,
}: {
  from: string | null;
  to: string | null;
  hint?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [f, setF] = useState(from ?? '');
  const [t, setT] = useState(to ?? '');

  // Preserve every other param on the page; only from/to are ours.
  const push = (next: { from: string; to: string } | null) => {
    const q = new URLSearchParams(params?.toString() ?? '');
    if (next) {
      q.set('from', next.from);
      q.set('to', next.to);
    } else {
      q.delete('from');
      q.delete('to');
    }
    // Legacy: /reports also supports ?month=. A range supersedes it, so drop it
    // rather than leave two competing period selectors in the URL.
    if (next) q.delete('month');
    const qs = q.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const activePreset = (p: Preset): boolean => {
    const r = presetRange(p);
    if (!r) return !from && !to;
    return from === r.from && to === r.to;
  };

  const input: React.CSSProperties = {
    padding: '0.35rem 0.5rem',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
    borderRadius: 6,
    fontSize: 13,
  };

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 11,
            color: 'var(--fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            fontWeight: 700,
          }}
        >
          Period
        </span>
        {PRESETS.map((p) => {
          const on = activePreset(p);
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                const r = presetRange(p);
                setF(r?.from ?? '');
                setT(r?.to ?? '');
                push(r);
              }}
              aria-pressed={on}
              style={{
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid',
                borderColor: on ? 'var(--accent)' : 'var(--border)',
                background: on ? 'var(--accent-dim)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--fg-muted)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          );
        })}

        <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

        <input
          type="date"
          value={f}
          max={t || undefined}
          onChange={(e) => setF(e.target.value)}
          style={input}
          aria-label="From date"
        />
        <span style={{ color: 'var(--fg-muted)' }}>→</span>
        <input
          type="date"
          value={t}
          min={f || undefined}
          onChange={(e) => setT(e.target.value)}
          style={input}
          aria-label="To date"
        />
        <button
          type="button"
          onClick={() => f && t && push({ from: f, to: t })}
          disabled={!f || !t}
          style={{
            ...buttonStyle,
            padding: '0.35rem 0.9rem',
            fontSize: 13,
            opacity: !f || !t ? 0.5 : 1,
            cursor: !f || !t ? 'not-allowed' : 'pointer',
          }}
        >
          Apply
        </button>
        {(from || to) && (
          <button
            type="button"
            onClick={() => {
              setF('');
              setT('');
              push(null);
            }}
            style={{ ...secondaryButtonStyle, padding: '0.35rem 0.9rem', fontSize: 13 }}
          >
            Clear
          </button>
        )}
      </div>
      {hint && (
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>{hint}</p>
      )}
    </div>
  );
}

// parseReportRange used to live here. It does NOT any more, and must not come
// back: this file is `'use client'`, so a server component importing a function
// from it gets a client reference proxy and throws when it calls it. That broke
// all three report tabs (2026-07-27). It now lives in @/lib/report-range, which
// both sides can import safely.
