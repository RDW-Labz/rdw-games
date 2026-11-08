import type { MissingItemRow } from '../MissingItemsQueue';
import type { OwedLotLine } from '../counter-rows';

export type OwedLotChip = {
  code: string;
  secondary: string | null;
  noSticker: boolean;
};

export type CounterRowDetailV2 = {
  customerLabel: string;
  owed: OwedLotChip[];
};

export type PickupRowV2 = {
  id: string;
  status: string;
  scheduledAt: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
  invoiceId: string;
  warehouseName: string | null;
  warehouseTimezone: string;
  invoiceStatus: string | null;
  customerLabel: string;
};

export type WarehouseOptionV2 = { id: string; name: string };

export type PickupsV2Props = {
  warehouses: WarehouseOptionV2[];
  activeWarehouseId: string | null;
  sessionsEnabled: boolean;
  missing: MissingItemRow[];
  counter: PickupRowV2[];
  today: PickupRowV2[];
  waiting: PickupRowV2[];
  recentlyDone: PickupRowV2[];
  counterDetails: Record<string, CounterRowDetailV2>;
};

export type { OwedLotLine };
