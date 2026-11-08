import type { LotDetailV2Props } from '../lot-detail-types';

const unsoldInventory: LotDetailV2Props = {
  lotId: 'lot-inventory-1',
  identity: {
    lot_code: 'BIN-031200',
    sticker_code: 'BIN:BRN4982227',
    display_code: 'BRN4982227',
    title: 'Cordless drill kit with charger',
    status: 'in_inventory',
    auctionTitle: null,
    auctionId: null,
    warehouseName: 'Sample warehouse',
    locationSummary: 'Bin A-04 (Aisle C / Bay 2)',
    relistCount: 0,
    metaLine: 'Ready for auction builder',
  },
  successor: null,
  photos: (
    <div className="console-v2-lot-photo-empty">
      <strong>No item photos yet</strong>
      <span>Use Photos to add evidence.</span>
    </div>
  ),
  facts: {
    startingBidCents: 500,
    currentBidLabel: '—',
    msrpLabel: '$89.00',
    closeLabel: '(not in auction yet)',
    locationLabel: 'Sample warehouse · Bin A-04 (Aisle C / Bay 2)',
    lineage: [],
    description: null,
  },
  owner: null,
  actions: {
    relist: null,
    remove: <div data-testid="remove-action">Remove from inventory control</div>,
    keep: null,
    cancel: null,
    delete: null,
    removedState: null,
  },
  primaryAction: 'remove',
  bids: [],
  bidFootnote: false,
  timeline: [],
  floorLocationNote: 'Sample warehouse · Bin A-04',
};

const noSticker: LotDetailV2Props = {
  ...unsoldInventory,
  lotId: 'lot-no-sticker',
  identity: {
    ...unsoldInventory.identity,
    lot_code: 'BIN-031201',
    sticker_code: null,
    display_code: null,
    title: 'Utility shelf — BIN only label',
  },
  actions: {
    ...unsoldInventory.actions,
    remove: <div>Remove</div>,
  },
};

const soldWithBids: LotDetailV2Props = {
  lotId: 'lot-sold-1',
  identity: {
    lot_code: 'BIN-031090',
    sticker_code: 'BIN:BRN4982300',
    display_code: 'BRN4982300',
    title: 'Rolling tool chest with drawers and key',
    status: 'won',
    auctionTitle: 'October returns',
    auctionId: 'auction-1',
    warehouseName: 'Sample warehouse',
    locationSummary: 'Bin B-12 · staged for pickup',
    relistCount: 1,
    metaLine: '',
  },
  successor: null,
  photos: <div>Photo strip</div>,
  facts: {
    startingBidCents: 1000,
    currentBidLabel: '$64.00',
    msrpLabel: '$199.00',
    closeLabel: 'Oct 7, 6:00 PM CDT',
    locationLabel: 'Sample warehouse · Bin B-12',
    lineage: [
      {
        id: 'parent-1',
        lot_code: 'BIN-030500',
        title: 'Earlier run',
        status: 'unsold',
        closed_at: 'Sep 12, 2026',
        relistLabel: '1 relist ago',
      },
    ],
    description: 'Heavy duty chest.',
  },
  owner: {
    bidderId: 'bidder-1',
    bidderName: 'Sample Buyer',
    bidderNumber: 1042,
    email: 'buyer@example.com',
    invoiceId: 'inv-abcdef1234567890',
    invoiceStatus: 'paid',
    invoiceShort: '567890',
    winningBidCents: 6400,
    purchasedLabel: 'Oct 8, 2026',
    pickupText: 'Awaiting pickup',
    refundText: 'None',
  },
  actions: {
    relist: null,
    remove: null,
    keep: null,
    cancel: null,
    delete: null,
    removedState: null,
  },
  primaryAction: null,
  bids: [
    {
      id: 'bid-1',
      placedLabel: 'Oct 7, 5:58 PM CDT',
      bidderLabel: 'Sample Buyer',
      amountCents: 6400,
      maxAmountCents: 7500,
      isAuto: false,
    },
  ],
  bidFootnote: true,
  timeline: [{ id: 1, whenLabel: 'Oct 1, 2026', eventLabel: 'Scheduled', transition: 'draft → scheduled', actorLabel: 'Jane' }],
  floorLocationNote: 'Sample warehouse · Bin B-12',
};

// Fix sold fixture - I used wrong field currentBidCents in facts
soldWithBids.facts = {
  startingBidCents: 1000,
  currentBidLabel: '$64.00',
  msrpLabel: '$199.00',
  closeLabel: 'Oct 7, 6:00 PM CDT',
  locationLabel: 'Sample warehouse · Bin B-12',
  lineage: soldWithBids.facts.lineage,
  description: 'Heavy duty chest.',
};

const longTitle: LotDetailV2Props = {
  ...unsoldInventory,
  lotId: 'lot-long-title',
  identity: {
    ...unsoldInventory.identity,
    title:
      'Professional-grade rolling tool chest with ball-bearing drawers, power strip, and laminated hardwood top — warehouse display model with minor scuffs',
  },
};

export const lotDetailFixtures = {
  unsoldInventory,
  noSticker,
  soldWithBids,
  longTitle,
};

export const lotDetailInventoryFixture = unsoldInventory;
