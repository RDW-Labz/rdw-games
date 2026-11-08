'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/console-v2';
import { stageCardClassName } from '@/components/console-v2/stage-hue';

// Gallery specimens for the three-refs primitives (globals.css "v2 three-refs").
// Sample data only — nothing here reads or claims real operational numbers.
const RANGES = ['Today', '7 days', '30 days'] as const;
type Range = (typeof RANGES)[number];

// Sample series per range (fictional), drawn as a gradient-filled area.
const SAMPLE: Record<Range, number[]> = {
  Today: [4, 6, 5, 9, 12, 10, 14, 13, 17, 15, 19, 18],
  '7 days': [12, 15, 11, 18, 22, 19, 25, 21, 27, 24, 29, 26],
  '30 days': [30, 26, 34, 31, 38, 36, 42, 39, 45, 41, 48, 44],
};

function areaPath(values: number[], w: number, h: number): { line: string; area: string } {
  const max = Math.max(...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 8)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w},${h} L0,${h} Z` };
}

const labelOverValue = { display: 'grid', gap: 'var(--console-space-1)' } as const;
const valueStyle = {
  fontFamily: 'var(--console-font-display)',
  fontSize: 'var(--console-text-title)',
  lineHeight: 1.1,
  color: 'var(--console-ink)',
} as const;

export function ThreeRefsDemo() {
  const [range, setRange] = useState<Range>('7 days');
  const [scanKey, setScanKey] = useState(0);
  const { line, area } = areaPath(SAMPLE[range], 480, 120);

  return (
    <div style={{ display: 'grid', gap: 'var(--console-space-6)', maxWidth: '1200px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 'var(--console-grid-gap)',
        }}
      >
        <div className="console-v2-card-soft" style={{ padding: 'var(--console-space-5)' }}>
          <div style={labelOverValue}>
            <span className="console-v2-label-mono">Mono-style label</span>
            <span style={valueStyle}>128</span>
          </div>
          <p style={{ margin: 'var(--console-space-2) 0 0', fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)' }}>
            Warm card: 16px radius, soft elevation (Sample data).
          </p>
        </div>

        <div className="console-v2-card-soft" style={{ padding: 'var(--console-space-5)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--console-space-2)', alignItems: 'flex-start' }}>
            <span className="console-v2-label-mono">Trend pill</span>
            <span className="console-v2-trend-pill">
              <span aria-hidden="true">↑</span> 12% vs last week
            </span>
          </div>
          <span style={{ ...valueStyle, display: 'block', marginTop: 'var(--console-space-1)' }}>$12,840</span>
          <p style={{ margin: 'var(--console-space-2) 0 0', fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)' }}>
            Only where real data has a comparison period (Sample data).
          </p>
        </div>

        <article
          className={stageCardClassName('pickup', {
            current: true,
            extra: 'console-v2-stage-card--featured console-v2-frame-bracket',
          })}
        >
          <span className="console-v2-stage-card__num console-v2-label-mono">01</span>
          <h3 className="console-v2-display" style={{ margin: 0 }}>
            Pickup
          </h3>
          <p style={{ margin: 'var(--console-space-2) 0 0', fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)' }}>
            Corner brackets: the one urgent card only, in its stage hue (Sample data).
          </p>
        </article>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--console-space-4)', alignItems: 'center' }}>
        <span className="console-v2-live-chip">
          <span className="console-v2-live-chip__dot" aria-hidden="true" />
          <span className="console-v2-live-chip__label">Live</span>
          <span>· 24 at the counter (Sample data)</span>
        </span>
        <Link href="/lots/lookup" className="console-v2-btn console-v2-btn--solid console-v2-pressable">
          Look up a lot
        </Link>
      </div>

      <div className="console-v2-card-soft" style={{ padding: 'var(--console-space-5)' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--console-space-3)',
            marginBottom: 'var(--console-space-4)',
          }}
        >
          <div style={labelOverValue}>
            <span className="console-v2-label-mono">Area chart · Sample data</span>
            <span className="console-v2-display" style={{ fontSize: 'var(--console-text-section)' }}>
              Gradient fill, lime stroke
            </span>
          </div>
          <div className="console-v2-segmented" role="radiogroup" aria-label="Sample range">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={range === r}
                className="console-v2-segmented__option"
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <svg viewBox="0 0 480 120" width="100%" height="120" role="img" aria-label={`Sample area chart, ${range}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="console-v2-ds-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--console-chart-area-top)' }} />
              <stop offset="55%" style={{ stopColor: 'var(--console-chart-area-mid)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--console-chart-area-bottom)' }} />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#console-v2-ds-area)" />
          <path d={line} fill="none" style={{ stroke: 'var(--console-chart-area-stroke)' }} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>

      <div
        className="console-v2-texture-grid"
        style={{
          position: 'relative',
          minHeight: '160px',
          padding: 'var(--console-space-5)',
          borderRadius: 'var(--console-radius-card)',
          border: 'var(--console-border-width) solid var(--console-line)',
        }}
      >
        <span key={scanKey} className="console-v2-scanline" aria-hidden="true" />
        <span className="console-v2-label-mono">Grid texture · 3%</span>
        <p style={{ margin: 'var(--console-space-2) 0 var(--console-space-4)', color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-sm)' }}>
          Page root only. The scan-line sweeps once on the dashboard floor story; reduced motion shows nothing.
        </p>
        <Button type="button" variant="secondary" onClick={() => setScanKey((k) => k + 1)}>
          Replay scan-line
        </Button>
      </div>
    </div>
  );
}
