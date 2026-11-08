import type { ReactNode } from 'react';
import type { SetupStep } from '@/components/console-v2/SetupStepper';
import type { ReorderableLot } from '../LotReorderTable';

export type AuctionDetailV2Props = {
  auctionId: string;
  title: string;
  status: string;
  warehouseLabel: string;
  startsLabel: string;
  biddingEndsLabel: string;
  pickupWindowLabel: string;
  buyerPremiumLabel: string;
  checklist: SetupStep[];
  completedSteps: number;
  totalApplicableSteps: number;
  todoSteps: number;
  canEdit: boolean;
  canCancel: boolean;
  showSchedule: boolean;
  hasLots: boolean;
  activeStatus: 'scheduled' | 'live';
  totalLots: number;
  activeLots: number;
  wonLots: number;
  unsoldLots: number;
  totalBids: number;
  noBidLots: number;
  newlyAddedLots: number;
  carriedOverLots: number;
  forfeitedReturnLots: number;
  previewQrDataUrl: string;
  closingWindow: ReactNode | null;
  featuredCurator: ReactNode;
  lotsTable: ReactNode;
};

export type AuctionDetailV2FixtureLots = {
  auctionId: string;
  initial: ReorderableLot[];
  canEdit: boolean;
  warehouseTimezone: string;
};
