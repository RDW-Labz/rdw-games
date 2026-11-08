'use client';

// Drag-to-reorder lot table for the auction detail page. Operators
// drag the highest-MSRP / most desirable items to the BOTTOM of the
// list because lot_number = sort order from first-close to last-close,
// and "best stuff closes last" maximizes engagement on the closing window.
//
// Sub-components and behavior:
//   - Native HTML5 drag and drop. Each row is draggable; the active
//     row gets dimmed; the drop target gets a top/bottom indicator
//     based on cursor position. Works on Chrome/Safari/Firefox; on
//     touch the user can use the up/down nudge buttons instead.
//   - "Save order" button is disabled until the user reorders. After
//     a successful save, the local state syncs to the server response
//     (router.refresh handles the auction-detail rest of page).
//   - "Reset" reverts unsaved changes back to the server's current
//     order.
//   - "Sort by MSRP (asc)" — one-click pre-sort that the operator
//     can fine-tune from. Best-seller items end up last.

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { lotHref } from '@/lib/console-links';
import { lotDisplayCode } from '@auction-platform/shared';
import { reorderAuctionLots } from './reorder-actions';
import { formatInTimeZone } from '@/lib/datetime';

export type ReorderableLot = {
  id: string;
  lot_number: number;
  lot_code: string;
  // Pre-stickered physical label ({op}:{raw}); rendered via lotDisplayCode so
  // staff see the code that's actually on the box (tester find 2026-07-02).
  sticker_code: string | null;
  title: string;
  msrp_cents: number | null;
  starting_bid_cents: number;
  current_bid_cents: number | null;
  bid_count: number;
  status: string;
  close_at: string | null;
};

type Props = {
  auctionId: string;
  initial: ReorderableLot[];
  /** Auctions in live/closed/canceled states are read-only. */
  canEdit: boolean;
  /** IANA timezone for the auction's warehouse (e.g. 'America/Chicago').
   *  Used to format lot.close_at in warehouse local time rather than the
   *  SSR runtime zone (UTC on Cloudflare Workers). */
  warehouseTimezone: string;
};

export function LotReorderTable({ auctionId, initial, canEdit, warehouseTimezone }: Props) {
  const router = useRouter();
  // Sort the initial list by lot_number to be safe, then keep our own
  // working copy so drag updates are local until the user clicks Save.
  const sortedInitial = [...initial].sort((a, b) => a.lot_number - b.lot_number);
  const [order, setOrder] = useState<ReorderableLot[]>(sortedInitial);
  const [serverOrder, setServerOrder] = useState<ReorderableLot[]>(sortedInitial);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropAtIndex, setDropAtIndex] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const isDirty = order.some((lot, i) => lot.id !== serverOrder[i]?.id);
  const hasBids = order.some((l) => l.bid_count > 0);

  function moveTo(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    setOrder((prev) => {
      const next = prev.slice();
      const [item] = next.splice(fromIdx, 1);
      if (!item) return prev;
      next.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, item);
      return next;
    });
  }

  function nudge(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    setOrder((prev) => {
      const next = prev.slice();
      const a = next[idx]!;
      const b = next[target]!;
      next[idx] = b;
      next[target] = a;
      return next;
    });
  }

  function presortByMsrpAsc() {
    setOrder(
      [...order].sort((a, b) => {
        const am = a.msrp_cents ?? -1;
        const bm = b.msrp_cents ?? -1;
        if (am !== bm) return am - bm; // ascending: lowest MSRP first
        return a.lot_code.localeCompare(b.lot_code);
      }),
    );
  }

  function reset() {
    setOrder(serverOrder);
    setMsg(null);
  }

  function save() {
    setMsg(null);
    start(async () => {
      const orderedIds = order.map((l) => l.id);
      const r = await reorderAuctionLots({ auctionId, orderedIds });
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      // Apply locally — the router.refresh re-fetches the rest of the
      // page (close_at preview, redistribute button), but our local
      // working copy already has the right order.
      const reseatd: ReorderableLot[] = order.map((l, i) => ({ ...l, lot_number: i + 1 }));
      setOrder(reseatd);
      setServerOrder(reseatd);
      setMsg(`Saved new order for ${r.updated} lot${r.updated === 1 ? '' : 's'}.`);
      router.refresh();
    });
  }

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>
          Lots ({order.length})
        </h2>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          {canEdit
            ? 'Drag to reorder · highest-numbered lots close last'
            : 'Order locked — auction is ' + (initial[0]?.status === 'live' ? 'live' : 'closed/canceled')}
        </span>
        <span style={{ flex: 1 }} />
        {canEdit && !hasBids && (
          <>
            <button
              type="button"
              onClick={presortByMsrpAsc}
              disabled={pending}
              title="Sort lowest MSRP first; highest closes last."
              style={{
                padding: '5px 10px',
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: pending ? 'wait' : 'pointer',
                fontSize: 12,
              }}
            >
              Sort by MSRP (asc)
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={pending || !isDirty}
              style={{
                padding: '5px 10px',
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: pending || !isDirty ? 'not-allowed' : 'pointer',
                fontSize: 12,
                opacity: isDirty ? 1 : 0.4,
              }}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending || !isDirty}
              style={{
                padding: '5px 12px',
                background: isDirty ? 'var(--accent-dim)' : 'transparent',
                color: isDirty ? 'var(--accent)' : 'var(--fg-muted)',
                border: '1px solid',
                borderColor: isDirty ? 'var(--accent)' : 'var(--border)',
                borderRadius: 4,
                cursor: pending || !isDirty ? 'not-allowed' : 'pointer',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {pending ? 'Saving…' : 'Save order'}
            </button>
          </>
        )}
        {hasBids && canEdit && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
            Reorder disabled — at least one lot already has bids.
          </span>
        )}
      </header>

      {msg && (
        <div
          style={{
            padding: '6px 10px',
            marginBottom: 8,
            fontSize: 12,
            color: msg.startsWith('Saved') ? 'var(--accent)' : 'var(--danger)',
            fontWeight: 600,
          }}
        >
          {msg}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {canEdit && !hasBids && (
          <caption className="sr-only">
            <span>
              Drag rows to reorder lots. Keyboard users: focus a row and use the up/down nudge
              buttons to move it. Press the Save order button to confirm changes.
            </span>
          </caption>
        )}
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 13 }}>
            <th scope="col" style={{ padding: '0.5rem 0.5rem 0.5rem 0', borderBottom: '1px solid var(--border)', width: 28 }}>
              <span className="sr-only">Drag handle</span>
            </th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)', width: 40 }}>#</th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}>Title</th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}>Status</th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>MSRP</th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>Start</th>
            <th scope="col" style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}>Closes</th>
            {canEdit && !hasBids && (
              <th
                scope="col"
                style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)', width: 56 }}
                aria-label="Nudge up or down"
              />
            )}
          </tr>
        </thead>
        <tbody>
          {order.map((lot, idx) => {
            const isDragging = draggingId === lot.id;
            const isDropTop = dropAtIndex === idx;
            const newPosition = idx + 1;
            const numberChanged = newPosition !== lot.lot_number;
            return (
              <tr
                key={lot.id}
                draggable={canEdit && !hasBids}
                onDragStart={(e) => {
                  if (!canEdit || hasBids) return;
                  setDraggingId(lot.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', lot.id);
                }}
                onDragOver={(e) => {
                  if (!canEdit || hasBids) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropAtIndex(idx);
                }}
                onDragLeave={() => {
                  if (dropAtIndex === idx) setDropAtIndex(null);
                }}
                onDrop={(e) => {
                  if (!canEdit || hasBids) return;
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData('text/plain');
                  if (!draggedId) return;
                  const fromIdx = order.findIndex((l) => l.id === draggedId);
                  if (fromIdx === -1) return;
                  moveTo(fromIdx, idx);
                  setDraggingId(null);
                  setDropAtIndex(null);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropAtIndex(null);
                }}
                style={{
                  opacity: isDragging ? 0.4 : 1,
                  background: isDropTop ? 'rgba(122, 184, 255, 0.08)' : 'transparent',
                  borderTop: isDropTop ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: canEdit && !hasBids ? 'grab' : 'default',
                  transition: 'opacity 100ms',
                }}
              >
                <td style={{ padding: '0.5rem 0.5rem 0.5rem 0', textAlign: 'center', color: 'var(--fg-dim)' }}>
                  {canEdit && !hasBids ? '⋮⋮' : ''}
                </td>
                <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>
                  <span style={{ color: numberChanged ? 'var(--accent)' : 'var(--fg-muted)', fontWeight: numberChanged ? 700 : 400 }}>
                    {newPosition}
                  </span>
                  {numberChanged && (
                    <span style={{ color: 'var(--fg-dim)', fontSize: 11, marginLeft: 4 }}>
                      (was {lot.lot_number})
                    </span>
                  )}
                </td>
                <td style={{ padding: '0.5rem' }}>
                  <Link
                    href={lotHref(lot.id)}
                    draggable={false}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
                  >
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', marginRight: 8 }}>
                      {lotDisplayCode(lot) ?? lot.lot_code}
                    </span>
                    {lot.title}
                  </Link>
                </td>
                <td style={{ padding: '0.5rem', fontSize: 12, color: 'var(--fg-muted)' }}>
                  {lot.status}
                  {lot.bid_count > 0 && ` · ${lot.bid_count} bid${lot.bid_count === 1 ? '' : 's'}`}
                </td>
                <td style={{ padding: '0.5rem', textAlign: 'right', fontFamily: 'monospace', fontSize: 13 }}>
                  {lot.msrp_cents != null ? `$${(lot.msrp_cents / 100).toFixed(0)}` : '—'}
                </td>
                <td style={{ padding: '0.5rem', textAlign: 'right', fontFamily: 'monospace', fontSize: 13 }}>
                  ${(lot.starting_bid_cents / 100).toFixed(2)}
                </td>
                <td style={{ padding: '0.5rem', fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
                  {lot.close_at
                    ? formatInTimeZone(lot.close_at, warehouseTimezone, { dateStyle: 'short', timeStyle: 'short' })
                    : '—'}
                </td>
                {canEdit && !hasBids && (
                  <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      onClick={() => nudge(idx, -1)}
                      disabled={pending || idx === 0}
                      title="Move up"
                      style={nudgeBtnStyle(pending || idx === 0)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => nudge(idx, 1)}
                      disabled={pending || idx === order.length - 1}
                      title="Move down"
                      style={nudgeBtnStyle(pending || idx === order.length - 1)}
                    >
                      ↓
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function nudgeBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '2px 6px',
    background: 'transparent',
    color: disabled ? 'var(--fg-dim)' : 'var(--fg-muted)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 12,
    marginRight: 2,
  };
}
