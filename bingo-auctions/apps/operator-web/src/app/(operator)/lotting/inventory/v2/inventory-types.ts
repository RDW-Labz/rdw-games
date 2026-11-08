import type { ReactNode } from 'react';

export type InventoryBucket =
  | 'live'
  | 'inventory'
  | 'not_put_away'
  | 'available'
  | 'unsold'
  | 'unpicked_up'
  | 'refunded';

export type InventoryRowV2 = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  status: string;
  warehouse_id: string | null;
  warehouseName: string | null;
  locationLabel: string;
  startingBidCents: number | null;
  ageLabel: string;
  /** lots.photo_urls[0] — the same first photo the v1 table thumbnails. */
  photoUrl: string | null;
  /** v1 "Source / VRID" (null renders "Manual", as v1). */
  source: string | null;
  /** v1 "Vendor" (supplier). */
  vendor: string | null;
  msrpCents: number | null;
  /** intake_at, else created_at — v1 "Intaken". */
  intakenAt: string;
  /** warehouses.timezone, so Intaken renders in the warehouse's calendar day. */
  warehouseTz: string | null;
};

export type OpenAuctionV2 = {
  id: string;
  title: string;
  warehouse_id: string;
  ends_at: string;
  status: string;
  warehouses?: { timezone: string } | { timezone: string }[] | null;
};

export type InventoryBucketTab = {
  id: InventoryBucket;
  label: string;
  count: number;
  href: string;
  active: boolean;
};

export type InventoryV2Props = {
  bucket: InventoryBucket;
  bucketLabel: string;
  bucketTabs: InventoryBucketTab[];
  rows: InventoryRowV2[];
  shownCount: number;
  totalCount: number;
  cappedAt500: boolean;
  searchQ: string;
  warehouseId: string;
  warehouseOptions: Array<{ value: string; label: string }>;
  sourceFilter: string;
  sourceOptions: string[];
  vendorFilter: string;
  vendorOptions: string[];
  missing: 'photos' | 'msrp' | 'category' | null;
  buildHref: (overrides: Record<string, string | null>) => string;
  exportHref: string;
  emptyMessage: ReactNode;
  canEdit: boolean;
  canAssign: boolean;
  openAuctions: OpenAuctionV2[];
};
