'use client';

import type { CSSProperties } from 'react';
import { Button } from './Button';
import { labelStyle } from './styles';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type FilterBarProps = {
  warehouseLabel?: string;
  warehouseOptions?: { value: string; label: string }[];
  warehouseValue?: string;
  onWarehouseChange?: (value: string) => void;
  stateValue?: string;
  onStateChange?: (value: string) => void;
  loading?: boolean;
  error?: string;
  success?: string;
  disabledReason?: string;
  showReset?: boolean;
  onReset?: () => void;
  forceHover?: boolean;
  forceFocusSelect?: boolean;
  forceState?: GalleryVisualState;
  emptyWarehouses?: boolean;
};

const barStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--console-grid-gap)',
  alignItems: 'flex-end',
  padding: 'var(--console-space-3)',
  background: 'var(--console-surface)',
  border: 'var(--console-border-width) solid var(--console-border)',
  borderRadius: 'var(--console-radius-panel)',
};

export function FilterBar(props: FilterBarProps) {
  const {
    warehouseLabel = 'Warehouse',
    warehouseOptions = [],
    warehouseValue = '',
    onWarehouseChange,
    stateValue = 'all',
    onStateChange,
    loading,
    error,
    success,
    disabledReason,
    showReset,
    onReset,
    forceHover,
    forceFocusSelect,
    forceState,
    emptyWarehouses,
  } = props;

  const selectVisualState =
    forceState ?? (forceFocusSelect ? 'focus' : forceHover ? 'hover' : undefined);

  if (emptyWarehouses) {
    return (
      <div style={barStyle} aria-busy={loading || undefined}>
        <p style={{ color: 'var(--console-ink-secondary)', margin: 0 }}>No warehouses available (Sample data)</p>
      </div>
    );
  }

  return (
    <div style={barStyle} aria-busy={loading || undefined}>
      <div>
        <label htmlFor="console-filter-warehouse" style={labelStyle}>{warehouseLabel}</label>
        <select
          id="console-filter-warehouse"
          value={warehouseValue}
          disabled={!!disabledReason || loading}
          onChange={(e) => onWarehouseChange?.(e.target.value)}
          className="console-v2-field console-v2-input-fill console-v2-filter-select"
          style={{ minWidth: '160px' }}
          aria-current={warehouseValue !== 'all' ? 'true' : undefined}
          {...galleryStateProps(selectVisualState)}
        >
          {warehouseOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div>
        <span id="console-filter-state-label" style={labelStyle}>State</span>
        <div role="group" aria-labelledby="console-filter-state-label" style={{ display: 'flex', gap: 'var(--console-space-2)' }}>
          {(['all', 'live', 'scheduled'] as const).map((state) => (
            <Button
              key={state}
              type="button"
              variant="secondary"
              aria-pressed={stateValue === state}
              disabled={!!disabledReason || loading}
              onClick={() => onStateChange?.(state)}
              forceState={state === 'all' ? selectVisualState : undefined}
            >
              {state === 'all' ? 'All' : state.charAt(0).toUpperCase() + state.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      {showReset ? (
        <Button type="button" variant="secondary" onClick={onReset}>Reset filters</Button>
      ) : null}
      {loading ? <p style={{ margin: 0, color: 'var(--console-ink-dim)' }}>Applying filters…</p> : null}
      {error ? <p role="alert" style={{ margin: 0, color: 'var(--console-danger)' }}>{error}</p> : null}
      {success ? <p style={{ margin: 0, color: 'var(--console-success)' }}>{success}</p> : null}
      {disabledReason ? <p style={{ margin: 0, color: 'var(--console-ink-dim)' }}>{disabledReason}</p> : null}
    </div>
  );
}
