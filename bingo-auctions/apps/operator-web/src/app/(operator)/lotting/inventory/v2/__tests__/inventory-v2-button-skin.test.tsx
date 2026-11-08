// v2 button skin: the bulk bar keeps its actions and labels, with exactly one
// lime primary per toolbar state.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { InventoryV2BulkActionBar, type InventoryV2BulkActionBarProps } from '../InventoryV2BulkActionBar';
import { inventoryV2Fixture } from '../__fixtures__/inventory-fixture';

const noop = () => {};
const props: InventoryV2BulkActionBarProps = {
  selectedCount: 3,
  canAssign: true,
  selectedWarehouseId: 'wh-1',
  openAuctions: inventoryV2Fixture.openAuctions,
  bulkMode: 'idle',
  targetAuctionId: '',
  bulkBidDollars: '1.00',
  printSize: 'avery_5160',
  pending: false,
  printing: false,
  onClear: noop,
  onSetBulkMode: noop,
  onTargetAuctionIdChange: noop,
  onBulkBidDollarsChange: noop,
  onPrintSizeChange: noop,
  onAssign: noop,
  onSetPrice: noop,
  onPrint: noop,
};

function buttons(html: string) {
  return [...html.replace(/<!-- -->/g, '').matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    cls: /class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
    label: (m[2] ?? '').replace(/<[^>]+>/g, '').trim(),
  }));
}

describe('InventoryV2BulkActionBar · button skin', () => {
  it('keeps the idle actions and labels inside the toolbar host', () => {
    const html = renderToString(<InventoryV2BulkActionBar {...props} />);
    expect(html).toContain('class="console-v2-inventory-bulk-bar"');
    expect(html).toContain('role="toolbar"');
    expect(buttons(html).map((b) => b.label)).toEqual([
      'Clear',
      'Assign to auction',
      'Set starting bid',
      'Print labels',
    ]);
  });

  it('has exactly one lime primary when Assign is offered (Assign leads)', () => {
    const b = buttons(renderToString(<InventoryV2BulkActionBar {...props} />));
    const lime = b.filter((x) => x.cls.includes('console-v2-btn--primary-lime'));
    expect(lime.map((x) => x.label)).toEqual(['Assign to auction']);
    expect(b.find((x) => x.label === 'Set starting bid')!.cls).toContain('console-v2-btn--secondary');
  });

  it('makes Set starting bid the single lime primary when Assign is not offered', () => {
    const b = buttons(renderToString(<InventoryV2BulkActionBar {...props} canAssign={false} />));
    const lime = b.filter((x) => x.cls.includes('console-v2-btn--primary-lime'));
    expect(lime.map((x) => x.label)).toEqual(['Set starting bid']);
  });

  it('keeps one lime commit in each sub-mode', () => {
    for (const bulkMode of ['assign', 'price', 'print'] as const) {
      const b = buttons(renderToString(<InventoryV2BulkActionBar {...props} bulkMode={bulkMode} />));
      expect(b.filter((x) => x.cls.includes('console-v2-btn--primary-lime')).length, bulkMode).toBe(1);
    }
  });
});
