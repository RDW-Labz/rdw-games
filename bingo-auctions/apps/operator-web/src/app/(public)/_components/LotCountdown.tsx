/**
 * LotCountdown — the live, ticking countdown pill overlaid on a LotCard photo.
 *
 * Why this is its own 'use client' island:
 *   LotCard is a SERVER component (it ships zero JS per grid item, which keeps
 *   /browse and /category fast). A server component renders Date.now() exactly
 *   once at SSR time, so the segmented countdown ("3h 12m 04s") was frozen on
 *   those pages — the seconds never moved. Extracting just the pill into a tiny
 *   client component restores the second-by-second motion bidders expect
 *   (matches mac.bid / nellis) while keeping the rest of the card server-rendered.
 *
 * Hydration safety:
 *   `nowMs` starts null and is only populated after mount (useEffect). The
 *   server render and the first client (hydration) render therefore both emit
 *   nothing, so there is no SSR/client text mismatch. The pill is absolutely
 *   positioned over the photo, so its post-mount appearance causes no layout
 *   shift. The footer "3h left" line on LotCard remains the SSR-visible time
 *   indicator until this island hydrates (a few ms later).
 */

'use client';

import { useEffect, useState } from 'react';
import type React from 'react';

// ── Time formatting (ported verbatim from LotCard's prior CountdownPill) ──────

interface SegmentedTime {
  closed: boolean;
  /** Sub-2-minute window — used to flip the pill background to urgent red. */
  urgent: boolean;
  /** Trailing segments to render, e.g. ["3h", "12m", "04s"]. Capped to the
   *  two/three most significant non-leading-zero segments. */
  segments: string[];
}

/**
 * Build the segments shown in the countdown pill.
 *
 * Rules
 *   - Negative diff → { closed: true, segments: [] }.
 *   - Up to three segments, skipping leading zeros so we never show
 *     "0d 3h 12m" — that becomes "3h 12m 04s".
 *   - When only seconds remain we show JUST seconds ("23s").
 *   - Seconds use a zero-padded two-digit display ("04s") so the monospace
 *     numerals look stable in the pill.
 */
function formatSegmentedTime(closeAt: string, nowMs: number): SegmentedTime {
  const diffMs = new Date(closeAt).getTime() - nowMs;
  if (diffMs <= 0) {
    return { closed: true, urgent: false, segments: [] };
  }

  const urgent = diffMs < 2 * 60 * 1000;

  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const pad2 = (n: number): string => String(n).padStart(2, '0');

  const all: Array<{ value: number; label: string }> = [
    { value: days, label: `${days}d` },
    { value: hours, label: `${hours}h` },
    { value: mins, label: `${mins}m` },
    { value: secs, label: `${pad2(secs)}s` },
  ];

  // Drop leading-zero segments (e.g. "0d" when no days remain).
  let firstNonZero = all.findIndex((seg) => seg.value > 0);
  if (firstNonZero === -1) firstNonZero = all.length - 1; // pure-zero edge → seconds only

  const segments = all.slice(firstNonZero).slice(0, 3).map((s) => s.label);

  return { closed: false, urgent, segments };
}

// ── Pill chrome (ported verbatim from LotCard) ────────────────────────────────

const COUNTDOWN_BASE: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: 8,
  right: 8,
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 0.8,
  lineHeight: 1.4,
  color: '#fff',
  fontVariantNumeric: 'tabular-nums',
  boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
  textShadow: '0 1px 2px rgba(0,0,0,0.45)',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function LotCountdown({ closeAt }: { closeAt: string }) {
  // null until mounted → server + first-client render emit nothing (no
  // hydration mismatch). After mount we tick once per second.
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (nowMs === null) return null;

  const time = formatSegmentedTime(closeAt, nowMs);
  if (time.closed) return null;

  const background = time.urgent ? 'var(--urgent-red)' : 'rgba(10, 12, 17, 0.85)';

  return (
    <div
      aria-label={`Time remaining: ${time.segments.join(' ')}`}
      style={{ ...COUNTDOWN_BASE, background }}
    >
      {time.segments.map((seg, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>{seg}</span>
          {i < time.segments.length - 1 && (
            <span aria-hidden style={{ opacity: 0.35, fontWeight: 400 }}>
              |
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
