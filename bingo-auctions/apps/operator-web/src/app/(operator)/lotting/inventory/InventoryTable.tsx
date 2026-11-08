'use client';

// Inventory table — interactive list of lots (any bucket) with multi-select
// for bulk operations.
//
// Bulk operations (admin/manager only):
//   1. Bulk-assign to auction: select N lots → pick a target auction →
//      uses migration 0099's reserve_lot_number_range under an
//      advisory lock to atomically assign all of them. Only offered when
//      `canAssign` is true — i.e. the "In inventory" bucket. The server
//      action also hard-rejects non-in_inventory lots as defense in depth.
//   2. Bulk-set starting bid: select N lots → enter dollar amount →
//      applies to all selected lots in one server roundtrip.
//   3. Print labels: QR sheet for the selected lots.
//
// Row click still navigates to /lots/[id] for the detail / per-lot edit;
// the bulk affordances live on a sticky action bar that appears when ≥1
// row is selected.

import { useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { formatInTimeZone, formatDateInTimeZone, warehouseTimezone } from '@/lib/datetime';
import { assignLotsToAuction, updateLotsStartingBid } from './actions';
import { lotDisplayCode } from '@auction-platform/shared';
import { thumbUrl } from '@/lib/thumb-url';
import { isRefundedLot, REFUNDED_HINT, REFUNDED_TAG } from '@/lib/inventory-refunded';

// 60px table thumbnail. thumbUrl asks free CDN resizers (Wayfair) for a small
// variant; own-storage photos load untransformed, because Supabase bills
// transforms per distinct origin image (see lib/thumb-url.ts). Lazy-loads +
// async-decodes so a long bucket tab only downloads the rows on screen. If a
// resized variant fails, fall back once to the original URL.
function ThumbImg({ src, alt }: { src: string; alt: string }) {
  const initial = thumbUrl(src) ?? src;
  const [current, setCurrent] = useState(initial);
  const onError = useCallback(() => {
    // Only fall back once, and only if we're not already on the original.
    setCurrent((c) => (c === src ? c : src));
  }, [src]);
  return (
    <img
      src={current}
      alt={alt}
      width={60}
      height={60}
      loading="lazy"
      decoding="async"
      onError={onError}
      style={{ objectFit: 'cover', display: 'block', width: 60, height: 60 }}
    />
  );
}

type LotRow = {
  id: string;
  lot_code: string;
  // Pre-stickered physical label ({op}:{raw}); rendered via lotDisplayCode so
  // staff see the code that's on the box (page.tsx already selects it).
  sticker_code: string | null;
  title: string;
  status: string;
  category: string | null;
  msrp_cents: number | null;
  warehouse_id: string | null;
  intake_bin_id: string | null;
  intake_at: string | null;
  created_at: string;
  // Source = VRID / Load ID / origin facility (e.g. "lex1", "btr1").
  source: string | null;
  // Vendor = supplier (Amazon / Lowe's / Wayfair). Independent axis from
  // source — added in mig 0154 to split semantics that were previously
  // jammed into source.
  vendor: string | null;
  // Task #139: first photo URL for thumbnail column. Null/empty = show placeholder.
  photo_urls: string[] | null;
  // Issue 1 (PATCH-warehouse-lookup): location resolved server-side from
  // intake_bin_id / warehouse_id and passed in so the row can show
  // "Warehouse · Bin (aisle/bay)".
  warehouseName: string | null;
  binCode: string | null;
  binAisle: string | null;
  binBay: string | null;
  // IANA zone of the lot's warehouse (warehouses.timezone) so intake/created
  // dates render in the warehouse's wall-clock zone, not the UTC SSR runtime.
  warehouseTz: string | null;
};

type OpenAuction = {
  id: string;
  title: string;
  warehouse_id: string;
  ends_at: string;
  status: string;
  // Embedded warehouse zone (warehouses.timezone) for the close-time label.
  warehouses?: { timezone: string } | { timezone: string }[] | null;
};

export function InventoryTable({
  canEdit,
  canAssign = true,
  lots,
  openAuctions = [],
}: {
  canEdit: boolean;
  // Whether the bulk "assign to auction" affordance is offered. Only the
  // "In inventory" bucket can assign — live lots are already on an auction,
  // and not-put-away lots have no bin yet. Defaults to true for backward
  // compatibility with any caller that doesn't pass it.
  canAssign?: boolean;
  lots: LotRow[];
  openAuctions?: OpenAuction[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<'idle' | 'assign' | 'price' | 'print'>('idle');
  const [targetAuctionId, setTargetAuctionId] = useState<string>('');
  const [bulkBidDollars, setBulkBidDollars] = useState('1.00');
  // POST /api/lots/qr-sheet supports avery_5160 (30/sheet), avery_5163
  // (10/sheet), and thermal_2x4 (1/sheet, direct thermal print). 5160 is
  // the most common for box labeling, so default to it.
  const [printSize, setPrintSize] =
    useState<'avery_5160' | 'avery_5163' | 'thermal_2x4'>('avery_5160');
  const [printing, setPrinting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);

  // Selecting a target auction only makes sense if all selected lots are
  // at the same warehouse. We compute the dominant warehouse here so the
  // operator can't accidentally pick an auction at the wrong location.
  const selectedWarehouse = useMemo(() => {
    if (selected.size === 0) return null;
    const wids = new Set<string>();
    for (const lot of lots) {
      if (selected.has(lot.id) && lot.warehouse_id) wids.add(lot.warehouse_id);
    }
    return wids.size === 1 ? [...wids][0] : null;
  }, [selected, lots]);

  const eligibleAuctions = useMemo(() => {
    if (!selectedWarehouse) return [];
    return openAuctions.filter((a) => a.warehouse_id === selectedWarehouse);
  }, [openAuctions, selectedWarehouse]);

  if (lots.length === 0) return null;

  function toggle(lotId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) next.delete(lotId);
      else next.add(lotId);
      return next;
    });
    setFeedback(null);
  }

  function selectAll() {
    setSelected(new Set(lots.map((l) => l.id)));
    setFeedback(null);
  }
  function clear() {
    setSelected(new Set());
    setBulkMode('idle');
    setFeedback(null);
  }

  function onAssign() {
    if (!targetAuctionId) {
      setFeedback('Pick a target auction first.');
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const result = await assignLotsToAuction({
        lotIds: [...selected],
        auctionId: targetAuctionId,
      });
      if (!result.ok) {
        setFeedback(`Could not assign: ${result.error}`);
        return;
      }
      const reasons = Object.entries(result.skipReasons)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      setFeedback(
        result.skipped === 0
          ? `Assigned ${result.assigned} lot${result.assigned === 1 ? '' : 's'}.`
          : `Assigned ${result.assigned} · Skipped ${result.skipped} (${reasons}).`,
      );
      setSelected(new Set());
      setBulkMode('idle');
      router.refresh();
    });
  }

  // Calls /api/lots/qr-sheet (POST) and opens the returned PDF in a new
  // tab. The endpoint already exists and supports lot_ids / auction_id /
  // batch_id selection modes — we use lot_ids since the operator has
  // hand-picked specific rows.
  async function onPrint() {
    if (selected.size === 0) return;
    setFeedback(null);
    setPrinting(true);
    try {
      const res = await fetch('/api/lots/qr-sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lot_ids: [...selected],
          size: printSize,
        }),
      });
      if (!res.ok) {
        const detail = await res
          .json()
          .then((j) => (j as { error?: string }).error)
          .catch(() => null);
        setFeedback(`Could not print${detail ? `: ${detail}` : ''}.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      // Revoke after the new tab has had time to render. Don't revoke
      // synchronously — Safari drops the open() target if you do.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!w) {
        setFeedback('Pop-up blocked — allow pop-ups to print labels.');
        return;
      }
      setFeedback(
        `Printed ${selected.size} label${selected.size === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      setFeedback(
        `Could not print: ${e instanceof Error ? e.message : 'unknown error'}.`,
      );
    } finally {
      setPrinting(false);
    }
  }

  function onSetPrice() {
    const dollars = Number(bulkBidDollars);
    if (!Number.isFinite(dollars) || dollars < 1) {
      setFeedback('Starting bid must be at least $1.00.');
      return;
    }
    const cents = Math.round(dollars * 100);
    setFeedback(null);
    startTransition(async () => {
      const result = await updateLotsStartingBid({
        lotIds: [...selected],
        startingBidCents: cents,
      });
      if (!result.ok) {
        setFeedback(`Could not update: ${result.error}`);
        return;
      }
      setFeedback(
        result.skipped === 0
          ? `Set starting bid on ${result.updated} lot${result.updated === 1 ? '' : 's'}.`
          : `Set on ${result.updated} · Skipped ${result.skipped} (already had bids or in auction).`,
      );
      setSelected(new Set());
      setBulkMode('idle');
      router.refresh();
    });
  }

  return (
    <div>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          maxWidth: 1200,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'grid',
            // 0154: extra column for Vendor (supplier) — sized like
            // Source / VRID so the supplier and origin sit side-by-side.
            // Task #139: 64px thumbnail column added as first data column.
            gridTemplateColumns: canEdit
              ? '32px 64px 110px minmax(0, 1.7fr) minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.9fr) 90px 120px'
              : '64px 110px minmax(0, 1.7fr) minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.9fr) 90px 120px',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--bg-elev)',
            borderBottom: '1px solid var(--border)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.0,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            alignItems: 'center',
          }}
        >
          {canEdit && (
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === lots.length}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < lots.length;
              }}
              onChange={(e) => {
                if (e.target.checked) selectAll();
                else clear();
              }}
              aria-label="select all"
            />
          )}
          {/* Task #139: thumbnail header — visually empty, column is self-labelling */}
          <span aria-hidden="true" />
          <span>Lot code</span>
          <span>Title</span>
          <span>Location</span>
          {/* 0154: Source semantic is now VRID / Load ID / facility — the
              header clarifies the distinction from the new Vendor column. */}
          <span>Source / VRID</span>
          <span>Vendor</span>
          <span>MSRP</span>
          <span>Intaken</span>
        </div>
        {lots.map((lot) => {
          const isSelected = selected.has(lot.id);
          return (
            <div
              key={lot.id}
              style={{
                display: 'grid',
                // Task #139: thumbnail column added; vendor column aligned with header.
                gridTemplateColumns: canEdit
                  ? '32px 64px 110px minmax(0, 1.7fr) minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.9fr) 90px 120px'
                  : '64px 110px minmax(0, 1.7fr) minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.9fr) 90px 120px',
                gap: 12,
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                alignItems: 'center',
                background: isSelected ? 'rgba(79, 140, 255, 0.06)' : 'transparent',
              }}
            >
              {canEdit && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(lot.id)}
                  aria-label={`select ${lotDisplayCode(lot) ?? lot.lot_code}`}
                />
              )}
              {/* Task #139: thumbnail — links to the same lot detail page.
                  Renders a resized thumbnail variant (ThumbImg) rather than
                  the full-size original; see lib/thumb-url.ts. */}
              <Link
                href={`/lots/${lot.id}`}
                aria-label={`Open lot ${lotDisplayCode(lot) ?? lot.lot_code}`}
                tabIndex={-1}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 60,
                  height: 60,
                  borderRadius: 4,
                  overflow: 'hidden',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  flexShrink: 0,
                  textDecoration: 'none',
                }}
              >
                {lot.photo_urls?.[0] ? (
                  <ThumbImg src={lot.photo_urls[0]} alt={lot.title} />
                ) : (
                  <span
                    style={{
                      width: 60,
                      height: 60,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                      color: 'var(--fg-muted)',
                      userSelect: 'none',
                    }}
                    aria-hidden="true"
                  >
                    ▭
                  </span>
                )}
              </Link>
              <Link
                href={`/lots/${lot.id}`}
                style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: 'var(--accent)',
                  fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                {lotDisplayCode(lot) ?? lot.lot_code}
              </Link>
              <Link
                href={`/lots/${lot.id}`}
                style={{
                  fontSize: 13,
                  color: 'var(--fg)',
                  textDecoration: 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={isRefundedLot(lot.status) ? `${REFUNDED_HINT} ${lot.title}` : lot.title}
              >
                {isRefundedLot(lot.status) && (
                  <span
                    style={{
                      marginRight: 6,
                      padding: '1px 6px',
                      borderRadius: 3,
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--warn, #b45309)',
                      border: '1px solid currentColor',
                    }}
                  >
                    {REFUNDED_TAG}
                  </span>
                )}
                {lot.title}
              </Link>
              <span
                style={{
                  fontSize: 12,
                  color: lot.warehouseName || lot.binCode ? 'var(--fg)' : 'var(--fg-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={formatLocation(lot)}
              >
                {formatLocation(lot)}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={lot.source ?? 'Manual'}
              >
                {lot.source ?? 'Manual'}
              </span>
              {/* 0154: Vendor — distinct from source (VRID/load/facility).
                  Empty-dash placeholder so the row stays grid-aligned when
                  no vendor is tagged yet (most pre-0154 lots). */}
              <span
                style={{
                  fontSize: 12,
                  color: lot.vendor ? 'var(--fg)' : 'var(--fg-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={lot.vendor ?? ''}
              >
                {lot.vendor ?? '—'}
              </span>
              <span style={{ fontSize: 13, color: 'var(--fg)' }}>
                {lot.msrp_cents != null ? `$${(lot.msrp_cents / 100).toFixed(2)}` : '—'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {lot.intake_at
                  ? formatDateInTimeZone(lot.intake_at, lot.warehouseTz)
                  : formatDateInTimeZone(lot.created_at, lot.warehouseTz)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Bulk action bar — sticky bottom when selection is non-empty */}
      {canEdit && selected.size > 0 && (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            marginTop: 16,
            padding: '12px 16px',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            zIndex: 10,
          }}
        >
          <strong style={{ fontSize: 14 }}>
            {selected.size} selected
          </strong>
          <button type="button" onClick={clear} style={{ ...secondaryButtonStyle, padding: '6px 12px', fontSize: 12 }}>
            Clear
          </button>

          {bulkMode === 'idle' && (
            <>
              {canAssign && (
                <button
                  type="button"
                  onClick={() => setBulkMode('assign')}
                  disabled={!selectedWarehouse}
                  style={{
                    ...buttonStyle,
                    padding: '6px 14px',
                    fontSize: 13,
                    opacity: selectedWarehouse ? 1 : 0.5,
                    cursor: selectedWarehouse ? 'pointer' : 'not-allowed',
                  }}
                  title={
                    selectedWarehouse
                      ? 'Assign all selected to an auction'
                      : 'Selection spans multiple warehouses — narrow first'
                  }
                >
                  Assign to auction →
                </button>
              )}
              <button
                type="button"
                onClick={() => setBulkMode('price')}
                style={{ ...buttonStyle, padding: '6px 14px', fontSize: 13 }}
              >
                Set starting bid →
              </button>
              <button
                type="button"
                onClick={() => setBulkMode('print')}
                style={{ ...secondaryButtonStyle, padding: '6px 14px', fontSize: 13 }}
                title="Print QR labels for the selected lots"
              >
                Print labels →
              </button>
            </>
          )}

          {bulkMode === 'assign' && canAssign && (
            <>
              <select
                value={targetAuctionId}
                onChange={(e) => setTargetAuctionId(e.target.value)}
                style={{ ...inputStyle, fontSize: 13, maxWidth: 320 }}
              >
                <option value="">— pick auction —</option>
                {eligibleAuctions.length === 0 ? (
                  <option disabled>No open auctions at this warehouse</option>
                ) : (
                  eligibleAuctions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} · {a.status} · closes{' '}
                      {formatInTimeZone(a.ends_at, warehouseTimezone(a.warehouses))}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={onAssign}
                disabled={!targetAuctionId || pending}
                style={{
                  ...buttonStyle,
                  padding: '6px 14px',
                  fontSize: 13,
                  opacity: !targetAuctionId || pending ? 0.5 : 1,
                }}
              >
                {pending ? 'Assigning…' : `Assign ${selected.size}`}
              </button>
              <button
                type="button"
                onClick={() => setBulkMode('idle')}
                style={{ ...secondaryButtonStyle, padding: '6px 12px', fontSize: 12 }}
              >
                Back
              </button>
            </>
          )}

          {bulkMode === 'price' && (
            <>
              <input
                type="number"
                value={bulkBidDollars}
                onChange={(e) => setBulkBidDollars(e.target.value)}
                min={1}
                step={0.01}
                style={{ ...inputStyle, fontSize: 13, maxWidth: 110 }}
                placeholder="1.00"
              />
              <button
                type="button"
                onClick={onSetPrice}
                disabled={pending}
                style={{
                  ...buttonStyle,
                  padding: '6px 14px',
                  fontSize: 13,
                  opacity: pending ? 0.5 : 1,
                }}
              >
                {pending ? 'Updating…' : `Apply to ${selected.size}`}
              </button>
              <button
                type="button"
                onClick={() => setBulkMode('idle')}
                style={{ ...secondaryButtonStyle, padding: '6px 12px', fontSize: 12 }}
              >
                Back
              </button>
            </>
          )}

          {bulkMode === 'print' && (
            <>
              <select
                value={printSize}
                onChange={(e) =>
                  setPrintSize(
                    e.target.value as
                      | 'avery_5160'
                      | 'avery_5163'
                      | 'thermal_2x4',
                  )
                }
                style={{ ...inputStyle, fontSize: 13, maxWidth: 240 }}
              >
                <option value="avery_5160">Avery 5160 — 1″×2⅝″ · 30/sheet</option>
                <option value="avery_5163">Avery 5163 — 2″×4″ · 10/sheet</option>
                <option value="thermal_2x4">Thermal 2″×4″ · 1/page</option>
              </select>
              <button
                type="button"
                onClick={onPrint}
                disabled={printing}
                style={{
                  ...buttonStyle,
                  padding: '6px 14px',
                  fontSize: 13,
                  opacity: printing ? 0.5 : 1,
                }}
              >
                {printing ? 'Generating…' : `Print ${selected.size}`}
              </button>
              <button
                type="button"
                onClick={() => setBulkMode('idle')}
                style={{ ...secondaryButtonStyle, padding: '6px 12px', fontSize: 12 }}
              >
                Back
              </button>
            </>
          )}

          {feedback && (
            <span
              style={{
                marginLeft: 'auto',
                color: feedback.startsWith('Could not')
                  ? 'var(--danger, #f87171)'
                  : 'var(--fg-muted)',
                fontSize: 12,
              }}
            >
              {feedback}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Issue 1 (PATCH-warehouse-lookup): render the resolved location as
// "Warehouse · Bin CODE (Aisle A / Bay B)". Returns "—" when neither a
// warehouse nor a bin is known (e.g. a bulk-imported lot not yet binned).
function formatLocation(lot: LotRow): string {
  if (!lot.warehouseName && !lot.binCode) return '—';
  const parts: string[] = [];
  if (lot.warehouseName) parts.push(lot.warehouseName);
  if (lot.binCode) {
    let bin = `Bin ${lot.binCode}`;
    if (lot.binAisle) {
      bin += ` (Aisle ${lot.binAisle}${lot.binBay ? ` / Bay ${lot.binBay}` : ''})`;
    }
    parts.push(bin);
  }
  return parts.join(' · ');
}
