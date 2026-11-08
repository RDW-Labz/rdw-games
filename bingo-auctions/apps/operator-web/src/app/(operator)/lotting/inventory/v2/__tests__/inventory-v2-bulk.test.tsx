import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
import { renderToString } from 'react-dom/server';
import { InventoryV2 } from '../InventoryV2';
import { InventoryV2BulkActionBar } from '../InventoryV2BulkActionBar';
import { inventoryV2Fixture } from '../__fixtures__/inventory-fixture';
import {
  bulkActionBarVisible,
  bulkAssignEnabled,
  bulkAssignOffered,
  dollarsToStartingBidCents,
  selectedWarehouseIdForLots,
} from '../inventory-bulk-helpers';

const noop = () => {};

const bulkBarDefaults = {
  bulkMode: 'idle' as const,
  targetAuctionId: '',
  bulkBidDollars: '1.00',
  printSize: 'avery_5160' as const,
  pending: false,
  printing: false,
  openAuctions: inventoryV2Fixture.openAuctions,
  onClear: noop,
  onSetBulkMode: noop,
  onTargetAuctionIdChange: noop,
  onBulkBidDollarsChange: noop,
  onPrintSizeChange: noop,
  onAssign: noop,
  onSetPrice: noop,
  onPrint: noop,
};

describe('inventory bulk helpers', () => {
  it('converts dollars to cents like v1 InventoryTable', () => {
    expect(dollarsToStartingBidCents('1.00')).toEqual({ ok: true, cents: 100 });
    expect(dollarsToStartingBidCents('12.5')).toEqual({ ok: true, cents: 1250 });
    expect(dollarsToStartingBidCents('0.05').ok).toBe(false);
  });

  it('resolves a single warehouse for homogeneous selection', () => {
    const lots = [
      { id: 'a', warehouse_id: 'wh-1' },
      { id: 'b', warehouse_id: 'wh-1' },
      { id: 'c', warehouse_id: 'wh-2' },
    ];
    expect(selectedWarehouseIdForLots(new Set(['a', 'b']), lots)).toBe('wh-1');
    expect(selectedWarehouseIdForLots(new Set(['a', 'c']), lots)).toBeNull();
  });

  it('gates bulk bar and assign affordances', () => {
    expect(bulkActionBarVisible(true, 0)).toBe(false);
    expect(bulkActionBarVisible(true, 2)).toBe(true);
    expect(bulkActionBarVisible(false, 2)).toBe(false);
    expect(bulkAssignOffered(true, false)).toBe(false);
    expect(bulkAssignOffered(false, true)).toBe(false);
    expect(bulkAssignOffered(true, true)).toBe(true);
    expect(bulkAssignEnabled(null)).toBe(false);
    expect(bulkAssignEnabled('wh-1')).toBe(true);
  });
});

describe('InventoryV2 bulk UI', () => {
  it('hides bulk action bar with zero selection', () => {
    const html = renderToString(<InventoryV2 {...inventoryV2Fixture} />);
    expect(html).not.toContain('console-v2-inventory-bulk-bar');
    expect(bulkActionBarVisible(inventoryV2Fixture.canEdit, 0)).toBe(false);
  });

  it('shows bulk action bar when selection is non-zero', () => {
    const html = renderToString(
      <div data-console-v2>
        <InventoryV2BulkActionBar
          {...bulkBarDefaults}
          selectedCount={3}
          canAssign={true}
          selectedWarehouseId="wh-1"
        />
      </div>,
    );
    expect(html).toContain('console-v2-inventory-bulk-bar');
    expect(html).toContain('3 selected');
  });

  it('does not offer assign outside the inventory bucket or for non-managers', () => {
    const offBucket = renderToString(
      <div data-console-v2>
        <InventoryV2BulkActionBar
          {...bulkBarDefaults}
          selectedCount={2}
          canAssign={false}
          selectedWarehouseId="wh-1"
        />
      </div>,
    );
    expect(offBucket).not.toContain('data-testid="inventory-v2-bulk-assign"');

    const readOnlyPage = renderToString(
      <InventoryV2 {...inventoryV2Fixture} canEdit={false} />,
    );
    expect(readOnlyPage).not.toContain('console-v2-inventory-select');
    expect(readOnlyPage).not.toContain('console-v2-inventory-bulk-bar');
  });

  it('disables assign when selection spans warehouses', () => {
    const html = renderToString(
      <div data-console-v2>
        <InventoryV2BulkActionBar
          {...bulkBarDefaults}
          selectedCount={2}
          canAssign={true}
          selectedWarehouseId={null}
        />
      </div>,
    );
    expect(html).toContain('data-testid="inventory-v2-bulk-assign"');
    expect(html).toContain('disabled');
  });
});
