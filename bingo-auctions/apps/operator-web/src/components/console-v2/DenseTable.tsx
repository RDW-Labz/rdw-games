'use client';

import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { LotIdentity } from './LotIdentity';
import {
  ariaSortValue,
  compareSortValues,
  nextSortDirection,
  type SortDirection,
  type SortableValue,
} from './dense-table-sort';
import { buttonSecondary } from './styles';

export type DenseTableColumn<T> = {
  id: string;
  header: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  getSortValue?: (row: T) => SortableValue;
  render: (row: T) => ReactNode;
};

export type DenseTableProps<T> = {
  caption: string;
  columns: DenseTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  identityForRow?: (row: T) => {
    lot_code: string;
    sticker_code?: string | null;
    display_code?: string | null;
    title?: string;
  };
  loading?: boolean;
  error?: string;
  emptyMessage?: string;
  staleLabel?: string;
  selectedKeys?: Set<string>;
  onToggleRow?: (key: string) => void;
  rowActionDisabledReason?: (row: T) => string | null;
  forceRowHoverKey?: string | null;
  scrollRegionId?: string;
};

const tableWrap: CSSProperties = {
  maxHeight: '320px',
  overflow: 'auto',
  border: 'var(--console-border-width) solid var(--console-border)',
  borderRadius: 'var(--console-radius-panel)',
  background: 'var(--console-surface)',
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: 'var(--console-space-2) var(--console-space-3)',
  fontSize: 'var(--console-text-xs)',
  fontWeight: 'var(--console-weight-label)',
  letterSpacing: 'var(--console-tracking-label)',
  textTransform: 'uppercase',
  color: 'var(--console-ink-secondary)',
  borderBottom: 'var(--console-border-width) solid var(--console-border)',
  background: 'var(--console-surface-raised)',
  position: 'sticky',
  top: 'var(--console-sticky-offset)',
  zIndex: 'var(--console-z-sticky)',
};

export function DenseTable<T>(props: DenseTableProps<T>) {
  const {
    caption,
    columns,
    rows,
    getRowKey,
    identityForRow,
    loading,
    error,
    emptyMessage = 'No matching records (Sample data).',
    staleLabel,
    selectedKeys,
    onToggleRow,
    rowActionDisabledReason,
    forceRowHoverKey,
    scrollRegionId: scrollRegionIdProp,
  } = props;
  // Unique per table so two tables on one page never share an id (axe duplicate-id).
  const generatedScrollId = useId();
  const scrollRegionId = scrollRegionIdProp ?? `console-dense-table-scroll-${generatedScrollId}`;

  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('none');

  const indexed = useMemo(() => rows.map((row, i) => ({ row, originalIndex: i })), [rows]);

  const sorted = useMemo(() => {
    if (!sortColumn || sortDirection === 'none') return indexed;
    const col = columns.find((c) => c.id === sortColumn);
    if (!col?.getSortValue) return indexed;
    return [...indexed].sort((a, b) =>
      compareSortValues(
        col.getSortValue!(a.row),
        col.getSortValue!(b.row),
        sortDirection as 'ascending' | 'descending',
        a.originalIndex,
        b.originalIndex,
      ),
    );
  }, [indexed, sortColumn, sortDirection, columns]);

  const selectionCount = selectedKeys?.size ?? 0;

  return (
    <div aria-busy={loading || undefined}>
      {selectionCount > 0 ? (
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)' }}>
          {selectionCount} selected (Sample data)
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--console-danger)' }}>
          Could not load results. {error}
        </p>
      ) : null}
      {staleLabel ? (
        <p style={{ color: 'var(--console-warning)', fontSize: 'var(--console-text-sm)' }}>{staleLabel}</p>
      ) : null}
      <div id={scrollRegionId} style={tableWrap}>
        <table className="console-v2-dense-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--console-text-sm)' }}>
          <caption style={{ captionSide: 'top', textAlign: 'left', padding: 'var(--console-space-2)', color: 'var(--console-ink)' }}>
            {caption}
          </caption>
          <thead>
            <tr>
              {onToggleRow ? (
                <th scope="col" style={{ ...thStyle, width: '48px' }} aria-label="Select row">
                  {' '}
                </th>
              ) : null}
              {columns.map((col) => {
                const active = sortColumn === col.id;
                const dir = active ? sortDirection : 'none';
                const sortable = col.sortable && col.getSortValue;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    style={{ ...thStyle, textAlign: col.align === 'right' ? 'right' : 'left' }}
                    aria-sort={sortable ? ariaSortValue(dir) : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => {
                          const next = nextSortDirection(dir, col.id, sortColumn);
                          setSortColumn(next.direction === 'none' ? null : next.columnId);
                          setSortDirection(next.direction);
                        }}
                        style={{
                          ...buttonSecondary,
                          minHeight: 'var(--console-control-min)',
                          padding: '0 var(--console-space-2)',
                          fontSize: 'inherit',
                          textTransform: 'inherit',
                          letterSpacing: 'inherit',
                          color: 'var(--console-ink-secondary)',
                          border: 'none',
                          background: 'transparent',
                        }}
                      >
                        {col.header}
                        {dir === 'ascending' ? ' ↑' : dir === 'descending' ? ' ↓' : ''}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length + (onToggleRow ? 1 : 0)} style={{ padding: 'var(--console-space-4)', color: 'var(--console-ink-dim)' }}>
                  Loading results…
                  <span aria-hidden="true" style={{ display: 'block', marginTop: 'var(--console-space-2)', height: 'var(--console-row-min)', background: 'var(--console-surface-hover)' }} />
                </td>
              </tr>
            ) : null}
            {!loading && sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (onToggleRow ? 1 : 0)} style={{ padding: 'var(--console-space-4)', color: 'var(--console-ink-dim)' }}>
                  {emptyMessage}
                </td>
              </tr>
            ) : null}
            {!loading &&
              sorted.map(({ row }) => {
                const key = getRowKey(row);
                const hover = forceRowHoverKey === key;
                const disabledReason = rowActionDisabledReason?.(row);
                return (
                  <tr
                    key={key}
                    data-state={hover ? 'hover' : undefined}
                    style={{
                      minHeight: 'var(--console-row-min)',
                      borderBottom: 'var(--console-border-width) solid var(--console-border)',
                    }}
                  >
                    {onToggleRow ? (
                      <td style={{ padding: 'var(--console-space-2)', verticalAlign: 'middle' }}>
                        <input
                          type="checkbox"
                          aria-label={`Select row ${key}`}
                          checked={selectedKeys?.has(key) ?? false}
                          onChange={() => onToggleRow(key)}
                          style={{ width: '20px', height: '20px', accentColor: 'var(--console-action)' }}
                        />
                      </td>
                    ) : null}
                    {columns.map((col, colIndex) => {
                      const isIdentity = colIndex === 0 && identityForRow;
                      const identity = isIdentity ? identityForRow(row) : null;
                      return (
                        <td
                          key={col.id}
                          style={{
                            padding: 'var(--console-space-2) var(--console-space-3)',
                            verticalAlign: 'middle',
                            textAlign: col.align === 'right' ? 'right' : 'left',
                            color: 'var(--console-ink)',
                            fontVariantNumeric: col.align === 'right' ? 'tabular-nums' : undefined,
                            background: 'var(--console-surface-raised)',
                            borderTop: 'var(--console-border-width) solid var(--console-line)',
                          }}
                        >
                          <span className="console-v2-cell-inner">
                          {identity ? (
                            <div>
                              <LotIdentity lot={identity} />
                              {identity.title ? (
                                <div style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-secondary)', marginTop: 'var(--console-space-1)' }}>
                                  {identity.title}
                                </div>
                              ) : null}
                              {colIndex === 0 ? (
                                <a
                                  href="#sample-lot"
                                  style={{
                                    color: 'var(--console-link)',
                                    fontSize: 'var(--console-text-sm)',
                                    display: 'inline-block',
                                    marginTop: 'var(--console-space-1)',
                                    minHeight: 'var(--console-control-min)',
                                    lineHeight: 'var(--console-control-min)',
                                  }}
                                  onClick={(e) => e.preventDefault()}
                                >
                                  Open lot (Sample data)
                                </a>
                              ) : null}
                            </div>
                          ) : (
                            col.render(row)
                          )}
                          {disabledReason && col.id === 'actions' ? (
                            <span style={{ display: 'block', fontSize: 'var(--console-text-helper)', color: 'var(--console-ink-dim)' }}>
                              {disabledReason}
                            </span>
                          ) : null}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { compareSortValues, nextSortDirection, ariaSortValue };
