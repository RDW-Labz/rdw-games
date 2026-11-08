import { formatCount } from './floor-story';
import type { FloorStage } from './floor-story';

/**
 * Stage counts are ACTIONABLE TODAY, not totals (Braden, 2026-10-13):
 * - Intake: link only — loads have no received/processed marker, so no reliable count.
 * - Lotting: active lots with no sticker code (the BIN-only problem).
 * - Auction: live lots closing within the next 2 hours.
 * - Paid: paid invoices still awaiting pickup whose pickup window ends within 24 hours.
 * - Pickup: checked in at the counter, not completed.
 */
export type StageCounts = {
  atCounter: number | null;
  closingWithin2h: number | null;
  paidPickupEndingWithin24h: number | null;
  noSticker: number | null;
};

function action(count: number | null, label: string, href: string) {
  return count != null && count > 0 ? { label, href } : null;
}

export function buildFloorStages(counts: StageCounts): FloorStage[] {
  return [
    {
      id: 'intake',
      label: 'Intake',
      purpose: 'Log what arrived.',
      hue: 'intake',
      href: '/loads',
      count: null,
      countLabel: null,
      primaryAction: null,
    },
    {
      id: 'lotting',
      label: 'Lotting',
      purpose: 'Match the label to the record.',
      hue: 'lotting',
      href: '/lotting/drafts',
      count: counts.noSticker,
      countLabel: 'with no sticker',
      primaryAction: action(counts.noSticker, 'Fix stickers →', '/lotting/drafts'),
    },
    {
      id: 'auction',
      label: 'Auction',
      purpose: 'Watch the next close.',
      hue: 'auction',
      href: '#next-to-close',
      count: counts.closingWithin2h,
      countLabel: 'closing within 2 h',
      primaryAction: action(counts.closingWithin2h, 'See closing lots →', '#next-to-close'),
    },
    {
      id: 'paid',
      label: 'Paid',
      purpose: 'Check the invoice before release.',
      hue: 'paid',
      href: '/pickups',
      count: counts.paidPickupEndingWithin24h,
      countLabel: 'pickup window ends < 24 h',
      primaryAction: action(counts.paidPickupEndingWithin24h, 'See pickups →', '/pickups'),
    },
    {
      id: 'pickup',
      label: 'Pickup',
      purpose: 'Finish the physical handoff.',
      hue: 'pickup',
      href: '/pickups',
      count: counts.atCounter,
      countLabel: 'at the counter',
      primaryAction: action(
        counts.atCounter,
        `Check out ${formatCount(counts.atCounter ?? 0)} →`,
        '/pickups',
      ),
    },
  ];
}
