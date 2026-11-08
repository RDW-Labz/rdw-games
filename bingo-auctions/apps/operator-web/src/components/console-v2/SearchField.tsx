'use client';

import type { CSSProperties } from 'react';
import { Button } from './Button';
import { labelStyle } from './styles';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type SearchFieldProps = {
  id?: string;
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
  hint?: string;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  disabledReason?: string;
  forceHover?: boolean;
  forceFocus?: boolean;
  forceState?: GalleryVisualState;
};

export function SearchField({
  id = 'console-search',
  label = 'Search',
  value = '',
  onChange,
  onSubmit,
  onClear,
  hint = 'Search title, lot code, or sticker (Sample data fields only).',
  loading,
  error,
  disabled,
  disabledReason,
  forceHover,
  forceFocus,
  forceState,
}: SearchFieldProps) {
  const visualState = forceState ?? (forceFocus ? 'focus' : forceHover ? 'hover' : undefined);
  const row: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--console-space-2)',
    alignItems: 'flex-end',
  };

  const inputStyle: CSSProperties = {
    flex: '1 1 200px',
  };

  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={row}>
        <input
          id={id}
          type="search"
          value={value}
          disabled={disabled || loading}
          onChange={(e) => onChange?.(e.target.value)}
          className="console-v2-field console-v2-input-fill console-v2-search-input"
          style={inputStyle}
          aria-invalid={error ? true : undefined}
          {...galleryStateProps(visualState)}
        />
        <Button type="button" disabled={disabled || loading} onClick={onSubmit} loading={loading}>
          Search
        </Button>
        {value ? (
          <Button type="button" variant="secondary" aria-label="Clear search" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>
      <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0' }}>{hint}</p>
      {error ? <p role="alert" style={{ color: 'var(--console-danger)', fontSize: 'var(--console-text-sm)' }}>{error}</p> : null}
      {disabledReason ? <p style={{ color: 'var(--console-ink-dim)', fontSize: 'var(--console-text-sm)' }}>{disabledReason}</p> : null}
    </div>
  );
}
