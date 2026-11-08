import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
import { renderToString } from 'react-dom/server';
import { InventoryV2 } from '../InventoryV2';
import { inventoryV2Fixture } from '../__fixtures__/inventory-fixture';

const refundedRow = { ...inventoryV2Fixture.rows[0]!, id: 'lot-refunded', status: 'refunded' };

describe('InventoryV2 refunded bucket', () => {
  const html = renderToString(
    <InventoryV2
      {...inventoryV2Fixture}
      bucket="refunded"
      bucketLabel="Refunded – relist"
      rows={[refundedRow]}
      shownCount={1}
      totalCount={1}
      canAssign={false}
    />,
  );

  it('tags the row "Refunded – relist" and links to the lot page', () => {
    expect(html).toContain('Refunded – relist');
    expect(html).toContain('href="/lots/lot-refunded"');
  });

  it('offers no assign-to-auction for refunded lots', () => {
    expect(html).not.toMatch(/Assign to auction/i);
  });

  it('leaves other rows on their normal status label', () => {
    const other = renderToString(<InventoryV2 {...inventoryV2Fixture} />);
    expect(other).not.toContain('Refunded – relist');
  });
});
