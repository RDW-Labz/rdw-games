import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
import { renderToString } from 'react-dom/server';
import { InventoryV2 } from '../InventoryV2';
import { inventoryV2Fixture } from '../__fixtures__/inventory-fixture';

describe('InventoryV2', () => {
  it('shows sticker-first identity and total of 37,000', () => {
    const html = renderToString(<InventoryV2 {...inventoryV2Fixture} />);
    expect(html).toContain('37,000');
    expect(html).toMatch(/Showing[\s\S]*50[\s\S]*37,000/);
    expect(html.indexOf('BRN4982001')).toBeLessThan(html.indexOf('BIN-031001'));
  });

  it('staggers list rows with motion class', () => {
    const html = renderToString(<InventoryV2 {...inventoryV2Fixture} />);
    const rows = html.match(/console-v2-motion-row-in/g) ?? [];
    expect(rows.length).toBe(50);
  });
});
