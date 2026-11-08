import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { GalleryClient } from './GalleryClient';
import { MotionDemo } from './MotionDemo';
import { ThreeRefsDemo } from './ThreeRefsDemo';

const SURFACE_SWATCHES = [
  { name: 'page', bg: 'var(--console-bg)' },
  { name: 'rail / section', bg: 'var(--console-surface)' },
  { name: 'card', bg: 'var(--console-surface-raised)' },
  { name: 'bright', bg: 'var(--console-surface-hover)' },
  { name: 'glass', bg: 'var(--console-surface-glass)' },
];

const TEXT_SWATCHES = [
  { name: 'primary ink', fg: 'var(--console-ink)', bg: 'var(--console-bg)' },
  { name: 'secondary', fg: 'var(--console-ink-secondary)', bg: 'var(--console-bg)' },
  { name: 'muted', fg: 'var(--console-ink-dim)', bg: 'var(--console-surface)' },
];

const STAGE_SWATCHES = [
  { name: 'intake', fg: 'var(--console-stage-intake-text)', bg: 'var(--console-stage-intake-bg)' },
  { name: 'lotting', fg: 'var(--console-stage-lotting-text)', bg: 'var(--console-stage-lotting-bg)' },
  { name: 'auction', fg: 'var(--console-stage-auction-text)', bg: 'var(--console-stage-auction-bg)' },
  { name: 'paid', fg: 'var(--console-stage-paid-text)', bg: 'var(--console-stage-paid-bg)' },
  { name: 'pickup', fg: 'var(--console-stage-pickup-text)', bg: 'var(--console-stage-pickup-bg)' },
];

const STATUS_SWATCHES = [
  { name: 'paid', fg: 'var(--console-status-paid-fg)', bg: 'var(--console-status-paid-bg)' },
  { name: 'checked in', fg: 'var(--console-status-checked-in-fg)', bg: 'var(--console-status-checked-in-bg)' },
  { name: 'unpaid', fg: 'var(--console-status-unpaid-fg)', bg: 'var(--console-status-unpaid-bg)' },
  { name: 'refunded', fg: 'var(--console-status-refunded-fg)', bg: 'var(--console-status-refunded-bg)' },
  { name: 'live', fg: 'var(--console-status-live-fg)', bg: 'var(--console-status-live-bg)' },
];

const swatchGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 'var(--console-grid-gap)',
  marginBottom: 'var(--console-space-6)',
} as const;

const swatchCell = {
  border: 'var(--console-border-width) solid var(--console-border-strong)',
  borderRadius: 'var(--console-radius-panel)',
  padding: 'var(--console-space-3)',
  minHeight: 'var(--console-control-min)',
  fontSize: 'var(--console-text-sm)',
} as const;

export default async function DesignSystemPage() {
  const cookieStore = await cookies();
  if (!isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    notFound();
  }

  return (
    <div
      data-console-v2
      style={{
        fontFamily: 'var(--console-font-body)',
        background: 'var(--console-gradient-frame)',
        color: 'var(--console-ink)',
        minHeight: '100%',
        padding: 'var(--console-page-gutter)',
        lineHeight: 'var(--console-leading-body)',
      }}
    >
      <header style={{ marginBottom: 'var(--console-space-6)' }}>
        <h1
          className="console-v2-display"
          style={{
            fontSize: 'var(--console-text-title)',
            fontWeight: 'var(--console-weight-strong)',
            lineHeight: 'var(--console-leading-tight)',
            margin: 0,
          }}
        >
          Console v2 · G Nightshift gallery
        </h1>
        <p style={{ color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-base)', marginTop: 'var(--console-space-2)' }}>
          Sample data only. Syne display + Atkinson Hyperlegible codes — Slice 1 primitives.
        </p>
      </header>

      <section aria-labelledby="surfaces-title">
        <h2 id="surfaces-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Surfaces
        </h2>
        <div style={swatchGrid}>
          {SURFACE_SWATCHES.map((s) => (
            <div key={s.name} style={{ ...swatchCell, background: s.bg, color: 'var(--console-ink)' }}>
              {s.name}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="text-title">
        <h2 id="text-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Text
        </h2>
        <div style={swatchGrid}>
          {TEXT_SWATCHES.map((s) => (
            <div key={s.name} style={{ ...swatchCell, background: s.bg, color: s.fg }}>
              {s.name}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="stage-title">
        <h2 id="stage-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Stage hues
        </h2>
        <div style={swatchGrid}>
          {STAGE_SWATCHES.map((s) => (
            <div key={s.name} style={{ ...swatchCell, background: s.bg, color: s.fg }}>
              {s.name}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="status-swatches-title">
        <h2 id="status-swatches-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Status-by-meaning
        </h2>
        <div style={swatchGrid}>
          {STATUS_SWATCHES.map((s) => (
            <div key={s.name} style={{ ...swatchCell, background: s.bg, color: s.fg }}>
              {s.name}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="primary-title" style={{ marginBottom: 'var(--console-space-8)' }}>
        <h2 id="primary-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Primary lime
        </h2>
        <div
          style={{
            ...swatchCell,
            background: 'var(--console-gradient-primary)',
            color: 'var(--console-on-action)',
            maxWidth: '320px',
            fontWeight: 'var(--console-weight-strong)',
          }}
        >
          on-lime text
        </div>
      </section>

      <section aria-labelledby="type-title" style={{ marginBottom: 'var(--console-space-8)' }}>
        <h2 id="type-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Type scale
        </h2>
        <p className="console-v2-display" style={{ fontSize: 'var(--console-text-display)', fontWeight: 600, margin: '0 0 var(--console-space-2)' }}>
          Syne display · 40px
        </p>
        <p className="console-v2-display" style={{ fontSize: '1.375rem', fontWeight: 600, margin: '0 0 var(--console-space-4)' }}>
          Section title · 22px Syne
        </p>
        <p style={{ fontSize: 'var(--console-text-base)', margin: '0 0 var(--console-space-4)' }}>
          Body · Atkinson Hyperlegible 400/700 — warehouse copy and labels (Sample data).
        </p>
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)', margin: '0 0 var(--console-space-2)' }}>
          Codes: Atkinson Hyperlegible 700
        </p>
        <p className="console-v2-code" style={{ fontSize: '40px', lineHeight: '48px', margin: '0 0 var(--console-space-2)' }}>
          BRN4982227 · BIN-031005 · 0O · 1Il · 5S · 8B
        </p>
        <p className="console-v2-code" style={{ fontSize: '15px', lineHeight: '22px', margin: 0 }}>
          BRN4982227 · BIN-031005 · 0O · 1Il · 5S · 8B
        </p>
      </section>

      <section aria-labelledby="motion-title" style={{ marginBottom: 'var(--console-space-8)' }}>
        <h2 id="motion-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Motion demo
        </h2>
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)', marginBottom: 'var(--console-space-3)' }}>
          Sections and rows step 40ms apart (<code>--console-reveal-index</code> / <code>--console-row-index</code>), capped after 12 so long lists never wait. The current stage card pulses once (600ms) in its stage hue. Spinner uses <code>console-v2-spin</code> only on{' '}
          <code>aria-busy=&quot;true&quot;</code>.
        </p>
        <MotionDemo />
      </section>

      <section aria-labelledby="three-refs-title" style={{ marginBottom: 'var(--console-space-8)' }}>
        <h2 id="three-refs-title" className="console-v2-display" style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}>
          Three refs primitives
        </h2>
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)', marginBottom: 'var(--console-space-3)' }}>
          shadcn structure, analytics warmth, hud accents used sparingly (ART-DIRECTION.md, Three refs). Classes:{' '}
          <code>console-v2-label-mono</code>, <code>console-v2-card-soft</code>, <code>console-v2-trend-pill</code>,{' '}
          <code>console-v2-frame-bracket</code>, <code>console-v2-live-chip</code>, <code>console-v2-segmented</code>,{' '}
          <code>console-v2-texture-grid</code>, <code>console-v2-scanline</code>, <code>console-v2-btn--solid</code>.
        </p>
        <ThreeRefsDemo />
      </section>

      <div style={{ maxWidth: '1200px' }}>
        <GalleryClient />
      </div>
    </div>
  );
}
