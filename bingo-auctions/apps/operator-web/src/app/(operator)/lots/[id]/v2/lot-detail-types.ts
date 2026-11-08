import type { ReactNode } from 'react';

export type LineageItem = {
  id: string;
  lot_code: string;
  title: string;
  status: string;
  closed_at: string | null;
  relistLabel: string;
};

export type SuccessorSummary = {
  id: string;
  displayCode: string;
  status: string;
  auctionTitle: string | null;
  auctionId: string | null;
  closeLabel: string;
  location: string | null;
  lotCode: string | null;
  showLotCodeStat: boolean;
  chainLength: number;
};

export type OwnerSummary = {
  bidderId: string;
  bidderName: string | null;
  bidderNumber: number | null;
  email: string | null;
  invoiceId: string;
  invoiceStatus: string;
  invoiceShort: string;
  winningBidCents: number | null;
  purchasedLabel: string;
  pickupText: string;
  /** Collected (item picked_up_at or the invoice's pickup completed) — puts the lot in Pickup. */
  pickedUp?: boolean;
  refundText: string;
};

export type BidRowV2 = {
  id: string;
  placedLabel: string;
  bidderLabel: string;
  amountCents: number;
  maxAmountCents: number;
  isAuto: boolean;
};

export type TimelineEventV2 = {
  id: number;
  whenLabel: string;
  eventLabel: string;
  transition: string | null;
  actorLabel: string | null;
};

export type RecordFacts = {
  startingBidCents: number;
  currentBidLabel: ReactNode;
  msrpLabel: ReactNode;
  closeLabel: string;
  locationLabel: string;
  lineage: LineageItem[];
  description: string | null;
};

export type RemovalRecorded = {
  title: string;
  detail: ReactNode;
  removedAtLabel: string | null;
  note: string | null;
};

export type LotDetailActionsSlot = {
  /** Mig 0471: withdraw from the auction, or the withdrawn notice + put back. */
  withdraw?: ReactNode | null;
  relist: ReactNode | null;
  remove: ReactNode | null;
  keep: ReactNode | null;
  cancel: ReactNode | null;
  delete: ReactNode | null;
  removedState: ReactNode | null;
};

export type LotDetailV2Props = {
  lotId: string;
  identity: {
    lot_code: string | null;
    sticker_code: string | null;
    display_code: string | null;
    title: string;
    status: string;
    auctionTitle: string | null;
    auctionId: string | null;
    warehouseName: string | null;
    locationSummary: string;
    relistCount: number;
    metaLine: string;
  };
  successor: SuccessorSummary | null;
  photos: ReactNode;
  facts: RecordFacts;
  owner: OwnerSummary | null;
  actions: LotDetailActionsSlot;
  primaryAction: 'relist' | 'remove' | 'keep' | 'cancel' | 'delete' | null;
  bids: BidRowV2[];
  bidFootnote: boolean;
  timeline: TimelineEventV2[];
  floorLocationNote: string;
};
