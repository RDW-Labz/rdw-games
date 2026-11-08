'use client';

import { formatInTimeZone, warehouseTimezone } from '@/lib/datetime';
import type { OpenAuctionV2 } from './inventory-types';
import { bulkAssignEnabled, bulkAssignOffered, filterEligibleAuctions } from './inventory-bulk-helpers';

export type BulkMode = 'idle' | 'assign' | 'price' | 'print';

export type InventoryV2BulkActionBarProps = {
  selectedCount: number;
  canAssign: boolean;
  selectedWarehouseId: string | null;
  openAuctions: OpenAuctionV2[];
  bulkMode: BulkMode;
  targetAuctionId: string;
  bulkBidDollars: string;
  printSize: 'avery_5160' | 'avery_5163' | 'thermal_2x4';
  pending: boolean;
  printing: boolean;
  onClear: () => void;
  onSetBulkMode: (mode: BulkMode) => void;
  onTargetAuctionIdChange: (id: string) => void;
  onBulkBidDollarsChange: (value: string) => void;
  onPrintSizeChange: (size: 'avery_5160' | 'avery_5163' | 'thermal_2x4') => void;
  onAssign: () => void;
  onSetPrice: () => void;
  onPrint: () => void;
};

export function InventoryV2BulkActionBar({
  selectedCount,
  canAssign,
  selectedWarehouseId,
  openAuctions,
  bulkMode,
  targetAuctionId,
  bulkBidDollars,
  printSize,
  pending,
  printing,
  onClear,
  onSetBulkMode,
  onTargetAuctionIdChange,
  onBulkBidDollarsChange,
  onPrintSizeChange,
  onAssign,
  onSetPrice,
  onPrint,
}: InventoryV2BulkActionBarProps) {
  const assignEnabled = bulkAssignEnabled(selectedWarehouseId);
  const showAssign = bulkAssignOffered(true, canAssign);
  const eligibleAuctions = filterEligibleAuctions(openAuctions, selectedWarehouseId);

  return (
    <div
      className="console-v2-inventory-bulk-bar"
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} selected lots`}
    >
      <strong className="console-v2-inventory-bulk-bar__count">{selectedCount} selected</strong>
      <button type="button" className="console-v2-btn console-v2-btn--ghost console-v2-pressable" onClick={onClear}>
        Clear
      </button>

      {bulkMode === 'idle' && (
        <>
          {showAssign && (
            <button
              type="button"
              className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
              onClick={() => onSetBulkMode('assign')}
              disabled={!assignEnabled}
              title={
                assignEnabled
                  ? 'Assign all selected to an auction'
                  : 'Selection spans multiple warehouses — narrow first'
              }
              data-testid="inventory-v2-bulk-assign"
            >
              Assign to auction
            </button>
          )}
          {/* One lime per toolbar: Assign leads when it is offered; otherwise
              Set starting bid is the bar's primary. */}
          <button
            type="button"
            className={`console-v2-btn ${showAssign ? 'console-v2-btn--secondary' : 'console-v2-btn--primary-lime'} console-v2-pressable`}
            onClick={() => onSetBulkMode('price')}
            data-testid="inventory-v2-bulk-price"
          >
            Set starting bid
          </button>
          <button
            type="button"
            className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
            onClick={() => onSetBulkMode('print')}
            title="Print QR labels for the selected lots"
            data-testid="inventory-v2-bulk-print"
          >
            Print labels
          </button>
        </>
      )}

      {bulkMode === 'assign' && showAssign && (
        <>
          <select
            value={targetAuctionId}
            onChange={(e) => onTargetAuctionIdChange(e.target.value)}
            className="console-v2-field console-v2-input-fill console-v2-filter-select"
            aria-label="Target auction"
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
            className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
            onClick={onAssign}
            disabled={!targetAuctionId || pending}
          >
            {pending ? 'Assigning…' : `Assign ${selectedCount}`}
          </button>
          <button
            type="button"
            className="console-v2-btn console-v2-btn--ghost console-v2-pressable"
            onClick={() => onSetBulkMode('idle')}
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
            onChange={(e) => onBulkBidDollarsChange(e.target.value)}
            min={1}
            step={0.01}
            className="console-v2-field console-v2-input-fill"
            placeholder="1.00"
            aria-label="Starting bid in dollars"
            style={{ maxWidth: '7rem' }}
          />
          <button
            type="button"
            className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
            onClick={onSetPrice}
            disabled={pending}
          >
            {pending ? 'Updating…' : `Apply to ${selectedCount}`}
          </button>
          <button
            type="button"
            className="console-v2-btn console-v2-btn--ghost console-v2-pressable"
            onClick={() => onSetBulkMode('idle')}
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
              onPrintSizeChange(e.target.value as 'avery_5160' | 'avery_5163' | 'thermal_2x4')
            }
            className="console-v2-field console-v2-input-fill console-v2-filter-select"
            aria-label="Label sheet size"
            style={{ maxWidth: '15rem' }}
          >
            <option value="avery_5160">Avery 5160 — 1″×2⅝″ · 30/sheet</option>
            <option value="avery_5163">Avery 5163 — 2″×4″ · 10/sheet</option>
            <option value="thermal_2x4">Thermal 2″×4″ · 1/page</option>
          </select>
          <button
            type="button"
            className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable"
            onClick={onPrint}
            disabled={printing}
          >
            {printing ? 'Generating…' : `Print ${selectedCount}`}
          </button>
          <button
            type="button"
            className="console-v2-btn console-v2-btn--ghost console-v2-pressable"
            onClick={() => onSetBulkMode('idle')}
          >
            Back
          </button>
        </>
      )}
    </div>
  );
}
