import type { WarehouseHubV2Props } from '../WarehouseHubV2';

export const warehouseHubV2Fixture: WarehouseHubV2Props = {
  warehouseId: 'wh-rogers',
  title: 'BinGo — Rogers',
  locationLine: 'Rogers, AR',
  completedCount: 4,
  totalSteps: 6,
  todoCount: 1,
  steps: [
    { title: 'Bins', detail: '120 bins added', href: '/warehouses/wh-rogers/bins', state: 'done' },
    { title: 'QR labels', detail: '120 labels ready to print', href: '/warehouses/wh-rogers/bins', state: 'partial' },
    { title: 'Walk warehouse', detail: '98 of 120 bins walk-verified', href: '/warehouses/wh-rogers/walk', state: 'partial' },
    { title: 'Pickup hours', detail: '5 days open', href: '/warehouses/wh-rogers/pickup-hours', state: 'done' },
    { title: 'Pickup mode', detail: 'Counter pickup', href: '/warehouses/wh-rogers/pickup-mode', state: 'done' },
    { title: 'Customer info', detail: 'Optional pickup copy', href: '/warehouses/wh-rogers/customer-info', state: 'partial' },
  ],
};

export const warehouseHubInactiveFixture: WarehouseHubV2Props = {
  ...warehouseHubV2Fixture,
  title: 'Former satellite — Inactive',
};
