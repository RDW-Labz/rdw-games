export type WarehouseListV2Row = {
  id: string;
  name: string;
  city: string;
  state: string;
  inactive: boolean;
  offSite: boolean;
  pickupModeLabel: string;
  /** warehouses.floor_plan_url is set — v1's "floor plan uploaded" / "no floor plan". */
  hasFloorPlan: boolean;
};

export type WarehousesV2Props = {
  rows: WarehouseListV2Row[];
};
