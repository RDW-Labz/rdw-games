import type { InventoryV2Props } from '../inventory-types';

function buildHref(overrides: Record<string, string | null>): string {
  const qs = new URLSearchParams();
  qs.set('bucket', 'inventory');
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) qs.delete(k);
    else qs.set(k, v);
  }
  const s = qs.toString();
  return `/lotting/inventory${s ? `?${s}` : ''}`;
}

// Thumbs point at images that ship in apps/operator-web/public (no external hosts).
const PHOTOS = [
  '/art/categories/furniture.webp',
  '/art/categories/kitchen-dining.webp',
  '/art/categories/electronics.webp',
  '/art/categories/home-improvement.webp',
  '/art/categories/toys-games.webp',
  '/art/categories/outdoor-garden.webp',
];

function makeRow(i: number) {
  const sticker = i % 7 === 0 ? null : `BIN:BRN${4982000 + i}`;
  return {
    id: `lot-row-${i}`,
    lot_code: `BIN-0${31000 + i}`,
    sticker_code: sticker,
    display_code: sticker ? `BRN${4982000 + i}` : null,
    title: i === 3 ? 'Extra-long title specimen for wrapping without truncation in the inventory list view' : `Sample lot title ${i}`,
    status: 'in_inventory',
    warehouse_id: i % 2 === 0 ? 'wh-1' : 'wh-2',
    warehouseName: i % 2 === 0 ? 'Harrison' : 'Dodge City',
    locationLabel: i % 8 === 0 ? '—' : `Bin ${4 + (i % 9)}-${10 + (i % 20)}${i % 3 === 0 ? ` (Aisle ${i % 9} / Bay ${i % 5})` : ''}`,
    startingBidCents: 100 * (1 + (i % 20)),
    ageLabel: `${3 + (i % 40)}d`,
    // Every 5th lot has no photo yet: the thumb cell renders nothing.
    photoUrl: i % 5 === 0 ? null : PHOTOS[i % PHOTOS.length]!,
    source: i % 4 === 0 ? null : i % 2 === 0 ? 'lex1' : 'btr1',
    vendor: i % 3 === 0 ? null : i % 2 === 0 ? 'Amazon' : "Lowe's",
    msrpCents: i % 6 === 0 ? null : 1999 + i * 250,
    intakenAt: `2026-10-${String(1 + (i % 12)).padStart(2, '0')}T15:00:00.000Z`,
    warehouseTz: 'America/Chicago',
  };
}

export const inventoryV2Fixture: InventoryV2Props = {
  bucket: 'inventory',
  bucketLabel: 'In inventory',
  bucketTabs: [
    { id: 'live', label: 'In auction', count: 128, href: '/lotting/inventory?bucket=live', active: false },
    { id: 'inventory', label: 'In inventory', count: 37000, href: '/lotting/inventory', active: true },
    { id: 'not_put_away', label: 'Not put away', count: 42, href: '/lotting/inventory?bucket=not_put_away', active: false },
    { id: 'available', label: 'Available', count: 37000, href: '/lotting/inventory?bucket=available', active: false },
    { id: 'unsold', label: 'Unsold', count: 890, href: '/lotting/inventory?bucket=unsold', active: false },
    { id: 'unpicked_up', label: 'Unpicked-up', count: 12, href: '/lotting/inventory?bucket=unpicked_up', active: false },
  ],
  rows: Array.from({ length: 50 }, (_, i) => makeRow(i + 1)),
  shownCount: 50,
  totalCount: 37000,
  cappedAt500: false,
  searchQ: '',
  warehouseId: '',
  warehouseOptions: [
    { value: 'wh-1', label: 'Harrison' },
    { value: 'wh-2', label: 'Dodge City' },
  ],
  sourceFilter: '',
  sourceOptions: ['lex1', 'btr1'],
  vendorFilter: '',
  vendorOptions: ['Amazon', "Lowe's"],
  missing: null,
  buildHref,
  exportHref: '/lotting/inventory/export?bucket=inventory',
  emptyMessage: 'No in-inventory lots yet.',
  canEdit: true,
  canAssign: true,
  openAuctions: [
    {
      id: 'auc-1',
      title: 'Weekly Harrison',
      warehouse_id: 'wh-1',
      ends_at: '2026-10-20T18:00:00.000Z',
      status: 'scheduled',
      warehouses: { timezone: 'America/Chicago' },
    },
  ],
};
