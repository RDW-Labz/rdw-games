import type { AuctionDetailV2Props } from '../auction-detail-types';

const baseChecklist = [
  {
    title: 'Configure',
    detail: 'Sample auction · premium 10.0%',
    state: 'done' as const,
    href: '/auctions/a-draft-1/edit',
    cta: 'Edit',
  },
  {
    title: 'Add lots',
    detail: '12 lots attached',
    state: 'done' as const,
    href: '/auctions/a-draft-1/builder',
    cta: 'Add more →',
  },
  {
    title: 'Distribute close times',
    detail: 'Looks distributed across the close window.',
    state: 'done' as const,
  },
  {
    title: 'Featured images (optional)',
    detail: '3 featured images set',
    state: 'done' as const,
  },
  {
    title: 'Schedule auction',
    detail: 'Ready to schedule.',
    state: 'partial' as const,
  },
];

export const auctionDetailDraftV2Fixture: AuctionDetailV2Props = {
  auctionId: 'a-draft-1',
  title: 'Saturday Tools & Equipment',
  status: 'draft',
  warehouseLabel: 'BinGo — Rogers',
  startsLabel: 'Oct 11, 2025, 9:00 AM CDT',
  biddingEndsLabel: 'Oct 11, 2025, 6:00 PM CDT',
  pickupWindowLabel: 'Oct 12 – Oct 14, 2025',
  buyerPremiumLabel: '10.0%',
  checklist: baseChecklist,
  completedSteps: 4,
  totalApplicableSteps: 5,
  todoSteps: 0,
  canEdit: true,
  canCancel: true,
  showSchedule: true,
  hasLots: true,
  activeStatus: 'scheduled',
  totalLots: 107,
  activeLots: 12,
  wonLots: 0,
  unsoldLots: 0,
  totalBids: 128,
  noBidLots: 4,
  newlyAddedLots: 100,
  carriedOverLots: 7,
  forfeitedReturnLots: 2,
  previewQrDataUrl: 'data:image/png;base64,fixture-preview-qr',
  closingWindow: null,
  featuredCurator: <p>Featured curator fixture</p>,
  lotsTable: <p>Lot table fixture</p>,
};

export const auctionDetailLiveV2Fixture: AuctionDetailV2Props = {
  ...auctionDetailDraftV2Fixture,
  auctionId: 'a-live-1',
  title: 'Tuesday Evening General',
  status: 'live',
  activeStatus: 'live',
  activeLots: 95,
  wonLots: 8,
  unsoldLots: 1,
  canEdit: false,
  canCancel: false,
  showSchedule: false,
  // Live: v1 labels every step CTA "View" once canEdit is false (page.tsx cta: canEdit ? … : 'View').
  checklist: baseChecklist.map((s) =>
    s.title === 'Schedule auction'
      ? { ...s, state: 'done', detail: 'Already live.', cta: 'View' }
      : { ...s, cta: 'View' },
  ),
};
