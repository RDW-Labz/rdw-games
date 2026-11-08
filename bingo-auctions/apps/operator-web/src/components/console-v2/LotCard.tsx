import type { CSSProperties } from 'react';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';
import { LotIdentity } from './LotIdentity';
import { StatusPill } from './StatusPill';
import type { ConsoleGalleryStatus } from './status';

export type LotCardProps = {
  lot: {
    lot_code: string;
    sticker_code?: string | null;
    display_code?: string | null;
  };
  title?: string;
  status?: ConsoleGalleryStatus | string;
  location?: string | null;
  selected?: boolean;
  loading?: boolean;
  error?: boolean;
  href?: string;
  forceHover?: boolean;
  forceFocus?: boolean;
  forceState?: GalleryVisualState;
  disabledActionReason?: string;
};

const cardBase: CSSProperties = {
  display: 'block',
  padding: 'var(--console-space-4)',
  background: 'var(--console-surface)',
  border: 'var(--console-border-width) solid var(--console-border)',
  borderRadius: 'var(--console-radius-panel)',
  minHeight: 'var(--console-row-min)',
  textDecoration: 'none',
  color: 'inherit',
  transition: `border-color var(--console-duration-fast) var(--console-ease-standard), background var(--console-duration-fast) var(--console-ease-standard)`,
};

export function LotCard({
  lot,
  title = 'Sample lot title',
  status = 'in_inventory',
  location,
  selected,
  loading,
  error,
  href = '#sample',
  forceHover,
  forceFocus,
  forceState,
  disabledActionReason,
}: LotCardProps) {
  const visualState = forceState ?? (forceFocus ? 'focus' : forceHover ? 'hover' : undefined);
  const borderAccent = selected ? 'var(--console-action)' : 'var(--console-border)';

  const inner = (
    <>
      <LotIdentity lot={lot} />
      <h3
        style={{
          fontSize: 'var(--console-text-base)',
          fontWeight: 'var(--console-weight-label)',
          margin: 'var(--console-space-2) 0',
          color: 'var(--console-ink)',
        }}
      >
        {loading ? 'Loading…' : title}
      </h3>
      <div style={{ marginBottom: 'var(--console-space-2)' }}>
        <StatusPill status={status} loading={loading} error={error} />
      </div>
      {location ? (
        <p style={{ margin: 0, fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)' }}>
          Location: {location}
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)' }}>
          {loading ? 'Loading location…' : 'Photo placeholder'}
        </p>
      )}
      {error ? (
        <p style={{ color: 'var(--console-danger)', fontSize: 'var(--console-text-sm)' }}>Could not load lot (Sample data)</p>
      ) : null}
      {disabledActionReason ? (
        <p style={{ color: 'var(--console-ink-dim)', fontSize: 'var(--console-text-sm)' }}>{disabledActionReason}</p>
      ) : null}
    </>
  );

  const style: CSSProperties = {
    ...cardBase,
    borderColor: borderAccent,
    ...(selected ? { boxShadow: `inset 0 0 0 var(--console-border-width) var(--console-action)` } : {}),
  };

  const stateProps = galleryStateProps(visualState);
  const className = 'console-v2-lot-card';

  if (href && !error) {
    return (
      <a href={href} onClick={(e) => e.preventDefault()} className={className} style={style} {...stateProps}>
        {inner}
      </a>
    );
  }

  return (
    <div className={className} style={style} {...stateProps}>
      {inner}
    </div>
  );
}
