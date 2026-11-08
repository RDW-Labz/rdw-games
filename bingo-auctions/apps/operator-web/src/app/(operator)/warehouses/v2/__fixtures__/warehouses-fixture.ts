import type { WarehousesV2Props } from '../warehouse-types';

export const warehousesV2Fixture: WarehousesV2Props = {
  rows: [
    {
      id: 'wh-rogers',
      name: 'BinGo — Rogers',
      city: 'Rogers',
      state: 'AR',
      inactive: false,
      offSite: false,
      pickupModeLabel: 'Counter pickup',
      hasFloorPlan: true,
    },
    {
      id: 'wh-crandall',
      name: 'Temporary — Crandall TX',
      city: 'Crandall',
      state: 'TX',
      inactive: false,
      offSite: true,
      pickupModeLabel: 'Staff-assisted',
      hasFloorPlan: false,
    },
    {
      id: 'wh-closed',
      name: 'Former satellite',
      city: 'Bentonville',
      state: 'AR',
      inactive: true,
      offSite: false,
      pickupModeLabel: 'Hybrid',
      hasFloorPlan: false,
    },
  ],
};
