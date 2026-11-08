import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
import { renderToString } from 'react-dom/server';
import { InventoryV2 } from '../InventoryV2';
import { inventoryLocationLabel } from '../inventory-location';
import { inventoryV2Fixture } from '../__fixtures__/inventory-fixture';

const html = renderToString(<InventoryV2 {...inventoryV2Fixture} />);
const text = (s: string) => s.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
function rowHtml(id: string): string {
  const hit = html.split('<tr ').slice(1).find((r) => r.includes(`/lots/${id}"`));
  if (!hit) throw new Error(`row ${id} not found`);
  return hit;
}

describe('InventoryV2 — v1 table columns under the v2 skin', () => {
  it('has the v1 columns in v1 order (select first for managers)', () => {
    const headers = [...html.matchAll(/<th scope="col" data-col="([a-z]+)"/g)].map((m) => m[1]);
    expect(headers).toEqual(['select', 'thumbs', 'code', 'title', 'location', 'source', 'vendor', 'msrp', 'intaken']);
    const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(text(thead)).toBe('PhotoLot codeTitleLocationSource / VRIDVendorMSRPIntaken');
  });

  it('shows the first photo as a 60px thumbnail (alt = title), and nothing when a lot has none', () => {
    const withPhoto = rowHtml('lot-row-1');
    expect(withPhoto).toMatch(/<img src="\/art\/categories\/[a-z-]+\.webp" alt="Sample lot title 1" width="60" height="60" loading="lazy"/);
    expect(withPhoto).toContain('aria-label="Open lot BRN4982001"');
    const noPhoto = rowHtml('lot-row-5');
    expect(noPhoto).not.toContain('<img');
    expect(noPhoto).toMatch(/<td data-col="thumbs"><\/td>/);
    const withPhotos = inventoryV2Fixture.rows.filter((r) => r.photoUrl).length;
    expect(html.match(/<img /g)?.length).toBe(withPhotos);
  });

  it('fills Location, Source / VRID, Vendor, MSRP and Intaken like v1', () => {
    const r6 = text(rowHtml('lot-row-6'));
    expect(r6).toContain('Harrison · Bin 10-16 (Aisle 6 / Bay 1)');
    expect(r6).toContain('lex1');
    expect(r6).toContain('—'); // no vendor, no MSRP
    expect(text(rowHtml('lot-row-4'))).toContain('Manual');
    expect(text(rowHtml('lot-row-1'))).toContain('$22.49');
    expect(text(rowHtml('lot-row-1'))).toContain('Oct 2, 2026');
    expect(inventoryLocationLabel({ warehouseName: 'Harrison', locationLabel: '—' })).toBe('Harrison');
    expect(inventoryLocationLabel({ warehouseName: null, locationLabel: '—' })).toBe('—');
  });

  it('keeps v2 status and starting bid, small, under the title', () => {
    const r1 = rowHtml('lot-row-1');
    const meta = r1.slice(r1.indexOf('console-v2-list-meta'));
    expect(text(meta.slice(0, meta.indexOf('</div>')))).toContain('In inventoryStarting bid $2.00');
  });

  it('keeps selection and row links exactly as before', () => {
    expect(html).toContain('aria-label="Select all on page"');
    expect(html.match(/class="console-v2-inventory-select"/g)?.length).toBe(inventoryV2Fixture.rows.length + 1);
    // photo + the seven data cells each open /lots/[id], as before
    expect(rowHtml('lot-row-1').match(/href="\/lots\/lot-row-1"/g)?.length).toBe(8);
  });

  it('drops the "Dense list of lots…" dev note', () => {
    expect(html).not.toContain('Dense list of lots');
    expect(html).not.toContain('same URL parameters as the classic view');
  });
});
