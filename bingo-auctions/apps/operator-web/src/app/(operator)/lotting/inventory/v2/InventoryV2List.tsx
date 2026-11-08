'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import { formatCents } from '@auction-platform/shared/money';
import { lotDisplayCode } from '@auction-platform/shared';
import { LotIdentity } from '@/components/console-v2/LotIdentity';
import { rowMotion } from '@/components/console-v2/motion';
import { StatusPill } from '@/components/console-v2/StatusPill';
import { isRefundedLot, REFUNDED_HINT, REFUNDED_TAG } from '@/lib/inventory-refunded';
import { Toast, ToastRegion } from '@/components/console-v2/Toast';
import { formatDateInTimeZone } from '@/lib/datetime';
import { assignLotsToAuction, updateLotsStartingBid } from '../actions';
import {
  bulkActionBarVisible,
  dollarsToStartingBidCents,
  isBulkErrorFeedback,
  selectedWarehouseIdForLots,
} from './inventory-bulk-helpers';
import { InventoryV2BulkActionBar, type BulkMode } from './InventoryV2BulkActionBar';
import { InventoryThumb } from './InventoryThumb';
import { inventoryLocationLabel } from './inventory-location';
import type { InventoryRowV2, OpenAuctionV2 } from './inventory-types';

export type InventoryV2ListProps = {
  bucketLabel: string;
  rows: InventoryRowV2[];
  canEdit: boolean;
  canAssign: boolean;
  openAuctions: OpenAuctionV2[];
  emptyMessage: ReactNode;
};

export function InventoryV2List({
  bucketLabel,
  rows,
  canEdit,
  canAssign,
  openAuctions,
  emptyMessage,
}: InventoryV2ListProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<BulkMode>('idle');
  const [targetAuctionId, setTargetAuctionId] = useState('');
  const [bulkBidDollars, setBulkBidDollars] = useState('1.00');
  const [printSize, setPrintSize] =
    useState<'avery_5160' | 'avery_5163' | 'thermal_2x4'>('avery_5160');
  const [printing, setPrinting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const selectedWarehouseId = useMemo(
    () => selectedWarehouseIdForLots(selected, rows),
    [selected, rows],
  );

  const showBulkBar = bulkActionBarVisible(canEdit, selected.size);

  const dismissToast = useCallback(() => setToastMessage(null), []);

  const pushToast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  function toggle(lotId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) next.delete(lotId);
      else next.add(lotId);
      return next;
    });
    setToastMessage(null);
  }

  function selectAllOnPage() {
    setSelected(new Set(rows.map((l) => l.id)));
    setToastMessage(null);
  }

  function clearSelection() {
    setSelected(new Set());
    setBulkMode('idle');
    setToastMessage(null);
  }

  function onAssign() {
    if (!targetAuctionId) {
      pushToast('Pick a target auction first.');
      return;
    }
    setToastMessage(null);
    startTransition(async () => {
      const result = await assignLotsToAuction({
        lotIds: [...selected],
        auctionId: targetAuctionId,
      });
      if (!result.ok) {
        pushToast(`Could not assign: ${result.error}`);
        return;
      }
      const reasons = Object.entries(result.skipReasons)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      pushToast(
        result.skipped === 0
          ? `Assigned ${result.assigned} lot${result.assigned === 1 ? '' : 's'}.`
          : `Assigned ${result.assigned} · Skipped ${result.skipped} (${reasons}).`,
      );
      setSelected(new Set());
      setBulkMode('idle');
      router.refresh();
    });
  }

  async function onPrint() {
    if (selected.size === 0) return;
    setToastMessage(null);
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
        pushToast(`Could not print${detail ? `: ${detail}` : ''}.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!w) {
        pushToast('Pop-up blocked — allow pop-ups to print labels.');
        return;
      }
      pushToast(`Printed ${selected.size} label${selected.size === 1 ? '' : 's'}.`);
    } catch (e) {
      pushToast(`Could not print: ${e instanceof Error ? e.message : 'unknown error'}.`);
    } finally {
      setPrinting(false);
    }
  }

  function onSetPrice() {
    const parsed = dollarsToStartingBidCents(bulkBidDollars);
    if (!parsed.ok) {
      pushToast(parsed.message);
      return;
    }
    setToastMessage(null);
    startTransition(async () => {
      const result = await updateLotsStartingBid({
        lotIds: [...selected],
        startingBidCents: parsed.cents,
      });
      if (!result.ok) {
        pushToast(`Could not update: ${result.error}`);
        return;
      }
      pushToast(
        result.skipped === 0
          ? `Set starting bid on ${result.updated} lot${result.updated === 1 ? '' : 's'}.`
          : `Set on ${result.updated} · Skipped ${result.skipped} (already had bids or in auction).`,
      );
      setSelected(new Set());
      setBulkMode('idle');
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return <div className="console-v2-inventory-empty">{emptyMessage}</div>;
  }

  const allSelected = selected.size > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && selected.size < rows.length;

  return (
    <>
      <div className="console-v2-inventory-table-wrap">
        <table className="console-v2-inventory-table console-v2-list-table console-v2-inventory-list-table">
          <caption className="console-v2-sr-only">{bucketLabel} inventory rows</caption>
          <colgroup>
            {canEdit ? <col className="console-v2-inventory-col-select" /> : null}
            <col className="console-v2-inventory-col-thumb" />
            <col className="console-v2-inventory-col-code" />
            <col className="console-v2-inventory-col-title" />
            <col className="console-v2-inventory-col-location" />
            <col className="console-v2-inventory-col-source" />
            <col className="console-v2-inventory-col-vendor" />
            <col className="console-v2-inventory-col-msrp" />
            <col className="console-v2-inventory-col-intaken" />
          </colgroup>
          <thead>
            <tr>
              {canEdit ? (
                <th scope="col" data-col="select" className="console-v2-inventory-table__select">
                  <input
                    type="checkbox"
                    className="console-v2-inventory-select"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={(e) => {
                      if (e.target.checked) selectAllOnPage();
                      else clearSelection();
                    }}
                    aria-label="Select all on page"
                  />
                </th>
              ) : null}
              <th scope="col" data-col="thumbs">
                <span className="console-v2-sr-only">Photo</span>
              </th>
              <th scope="col" data-col="code">Lot code</th>
              <th scope="col" data-col="title">Title</th>
              <th scope="col" data-col="location">Location</th>
              <th scope="col" data-col="source">Source / VRID</th>
              <th scope="col" data-col="vendor">Vendor</th>
              <th scope="col" data-col="msrp" className="console-v2-list-num">MSRP</th>
              <th scope="col" data-col="intaken">Intaken</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const isSelected = selected.has(row.id);
              const code = lotDisplayCode(row) ?? row.lot_code;
              const motion = rowMotion(index);
              const href = `/lots/${row.id}`;
              return (
                <tr
                  key={row.id}
                  className={`console-v2-list-row ${motion.className}${isSelected ? ' console-v2-inventory-row--selected' : ''}`}
                  style={motion.style}
                >
                  {canEdit ? (
                    <td data-col="select" className="console-v2-inventory-table__select">
                      <input
                        type="checkbox"
                        className="console-v2-inventory-select"
                        checked={isSelected}
                        onChange={() => toggle(row.id)}
                        aria-label={`Select ${code}`}
                      />
                    </td>
                  ) : null}
                  <td data-col="thumbs">
                    {row.photoUrl ? (
                      <Link
                        href={href}
                        aria-label={`Open lot ${code}`}
                        tabIndex={-1}
                        className="console-v2-inventory-thumb-link"
                      >
                        <InventoryThumb src={row.photoUrl} alt={row.title} />
                      </Link>
                    ) : null}
                  </td>
                  <td data-col="code">
                    <Link href={href} className="console-v2-inventory-row-link">
                      <LotIdentity
                        lot={{
                          lot_code: row.lot_code,
                          sticker_code: row.sticker_code,
                          display_code: row.display_code,
                        }}
                        showSignatureRule={false}
                      />
                    </Link>
                  </td>
                  <td data-col="title">
                    <Link href={href} className="console-v2-inventory-row-link console-v2-list-title">
                      {row.title}
                    </Link>
                    <div className="console-v2-list-meta">
                      <StatusPill
                        status={row.status}
                        label={isRefundedLot(row.status) ? REFUNDED_TAG : undefined}
                        domainHint={isRefundedLot(row.status) ? REFUNDED_HINT : undefined}
                      />
                      <span>
                        Starting bid {row.startingBidCents != null ? formatCents(row.startingBidCents) : '—'}
                      </span>
                    </div>
                  </td>
                  <td data-col="location">
                    <Link href={href} className="console-v2-inventory-row-link">
                      {inventoryLocationLabel(row)}
                    </Link>
                  </td>
                  <td data-col="source">
                    <Link href={href} className="console-v2-inventory-row-link">
                      {row.source ?? 'Manual'}
                    </Link>
                  </td>
                  <td data-col="vendor">
                    <Link href={href} className="console-v2-inventory-row-link">
                      {row.vendor ?? '—'}
                    </Link>
                  </td>
                  <td data-col="msrp" className="console-v2-list-num">
                    <Link href={href} className="console-v2-inventory-row-link">
                      {row.msrpCents != null ? formatCents(row.msrpCents) : '—'}
                    </Link>
                  </td>
                  <td data-col="intaken">
                    <Link href={href} className="console-v2-inventory-row-link console-v2-list-nowrap">
                      {formatDateInTimeZone(row.intakenAt, row.warehouseTz)}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showBulkBar ? (
        <InventoryV2BulkActionBar
          selectedCount={selected.size}
          canAssign={canAssign}
          selectedWarehouseId={selectedWarehouseId}
          openAuctions={openAuctions}
          bulkMode={bulkMode}
          targetAuctionId={targetAuctionId}
          bulkBidDollars={bulkBidDollars}
          printSize={printSize}
          pending={pending}
          printing={printing}
          onClear={clearSelection}
          onSetBulkMode={setBulkMode}
          onTargetAuctionIdChange={setTargetAuctionId}
          onBulkBidDollarsChange={setBulkBidDollars}
          onPrintSizeChange={setPrintSize}
          onAssign={onAssign}
          onSetPrice={onSetPrice}
          onPrint={onPrint}
        />
      ) : null}

      {toastMessage ? (
        <ToastRegion>
          <Toast
            message={toastMessage}
            variant={isBulkErrorFeedback(toastMessage) ? 'error' : 'success'}
            onClose={dismissToast}
          />
        </ToastRegion>
      ) : null}
    </>
  );
}
