// Which section of the console Pickups page a pickup belongs in.
//
// 2026-10-08: a customer stood at the counter with two paid boxes and staff
// could not find her pickup. Two faults:
//   1. The page queried status IN (pending, scheduled, completed, no_show), so
//      a 'checked_in' pickup (any partial handover at the counter flips a pickup
//      to checked_in) never appeared. 24 were hidden, all with owed items.
//   2. It ordered by scheduled_at and kept 200 rows, but 9,416 of 9,416 rows
//      have no scheduled_at, so the 200 shown were effectively arbitrary out of
//      9,392 (mostly long-completed pickups); pending ones could be missing too.
// The page now loads open pickups (pending, scheduled, checked_in) separately
// from a short recent-history list, and this decides the section.

export const OPEN_PICKUP_STATUSES = ['pending', 'scheduled', 'checked_in'] as const;
export const DONE_PICKUP_STATUSES = ['completed', 'no_show'] as const;

export type PickupBucket = 'counter' | 'today' | 'waiting' | 'past';

export function pickupBucket(
  p: { status: string | null; scheduled_at: string | null },
  now: Date,
): PickupBucket {
  if (p.status === 'checked_in') return 'counter';
  if (p.status === 'completed' || p.status === 'no_show') return 'past';
  if (p.scheduled_at) {
    const t = new Date(p.scheduled_at);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
    if (t >= startOfDay && t < endOfDay) return 'today';
  }
  return 'waiting';
}
