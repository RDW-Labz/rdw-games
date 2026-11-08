'use client';

import { Button } from './Button';
import { labelStyle } from './styles';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';
import { LotIdentity } from './LotIdentity';

export type LookupBarProps = {
  value?: string;
  onChange?: (value: string) => void;
  onLookup?: () => void;
  loading?: boolean;
  error?: string;
  disabledReason?: string;
  resolvedLot?: {
    lot_code: string;
    sticker_code?: string | null;
    display_code?: string | null;
  } | null;
  forceHover?: boolean;
  forceFocus?: boolean;
  forceState?: GalleryVisualState;
};

export function LookupBar({
  value = '',
  onChange,
  onLookup,
  loading,
  error,
  disabledReason,
  resolvedLot,
  forceHover,
  forceFocus,
  forceState,
}: LookupBarProps) {
  const visualState = forceState ?? (forceFocus ? 'focus' : forceHover ? 'hover' : undefined);

  return (
    <div>
      <label htmlFor="console-lookup" style={labelStyle}>Sticker or BIN code</label>
      <div style={{ display: 'flex', gap: 'var(--console-space-2)', flexWrap: 'wrap' }}>
        <input
          id="console-lookup"
          type="text"
          value={value}
          disabled={!!disabledReason || loading}
          onChange={(e) => onChange?.(e.target.value)}
          className="console-v2-field console-v2-input-fill console-v2-search-input"
          style={{ flex: '1 1 240px' }}
          placeholder="Use the code on the box"
          {...galleryStateProps(visualState)}
        />
        <Button type="button" disabled={!!disabledReason} loading={loading} onClick={onLookup}>
          Lookup
        </Button>
      </div>
      <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0' }}>
        Use the code on the box (Sample data).
      </p>
      {error ? <p role="alert" style={{ color: 'var(--console-danger)', fontSize: 'var(--console-text-sm)' }}>{error}</p> : null}
      {disabledReason ? <p style={{ color: 'var(--console-ink-dim)', fontSize: 'var(--console-text-sm)' }}>{disabledReason}</p> : null}
      {resolvedLot ? (
        <div style={{ marginTop: 'var(--console-space-3)' }}>
          <LotIdentity lot={resolvedLot} />
        </div>
      ) : null}
    </div>
  );
}
