// DataTable — the single tabular list primitive for the operator console.
//
// Replaces the hand-rolled <table> markup repeated across inventory / auctions
// / bidders / invoices, each with slightly different header casing, row
// padding, and hover treatment. One card-wrapped table, styled entirely by the
// `.console-table*` classes in globals.css (server-component-safe — the hover
// lives in CSS, so no 'use client' needed).
//
// Columns are declared, not hand-written per row: pass a `columns` array and a
// `rows` array, and DataTable renders header + body, applying per-column
// alignment and optional mono/numeric styling. Rows can be links (whole-row
// click) via `rowHref`.

import type { CSSProperties, ReactNode } from 'react';

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Right-align + mono font for $ / counts. Shorthand for align:'right' + mono. */
  numeric?: boolean;
  width?: number | string;
};

function cellStyle<T>(col: Column<T>): CSSProperties {
  const align = col.align ?? (col.numeric ? 'right' : 'left');
  return {
    textAlign: align,
    width: col.width,
    ...(col.numeric
      ? { fontFamily: 'var(--font-mono), monospace', fontVariantNumeric: 'tabular-nums' }
      : {}),
  };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowStyle,
  empty = 'Nothing here yet.',
  style,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Optional whole-row link target. */
  rowHref?: (row: T) => string | undefined;
  /** Optional per-row style (e.g. an overdue left-border accent). */
  rowStyle?: (row: T, index: number) => CSSProperties | undefined;
  /** Shown in place of the body when `rows` is empty. */
  empty?: ReactNode;
  style?: CSSProperties;
}) {
  if (rows.length === 0) {
    return (
      <div className="console-table-card" style={style}>
        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-dim)', fontSize: 14 }}>
          {empty}
        </div>
      </div>
    );
  }
  return (
    <div className="console-table-card" style={{ overflowX: 'auto', ...style }}>
      <table className="console-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ textAlign: col.align ?? (col.numeric ? 'right' : 'left') }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const href = rowHref?.(row);
            return (
              <tr key={rowKey(row, i)} style={rowStyle?.(row, i)}>
                {columns.map((col, ci) => {
                  const content = col.cell(row, i);
                  // First column becomes the row link anchor when rowHref is set,
                  // so the whole row is keyboard-reachable via one link.
                  const inner =
                    href && ci === 0 ? (
                      <a href={href} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
                        {content}
                      </a>
                    ) : (
                      content
                    );
                  return (
                    <td key={col.key} style={cellStyle(col)}>
                      {inner}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
