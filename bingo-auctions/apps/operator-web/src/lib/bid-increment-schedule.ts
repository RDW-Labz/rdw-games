// BID-3 (mig 0194) — shared zod validation for configurable bid-increment
// schedules. Lives in a PLAIN module (not a 'use server' file) so it can be
// imported by multiple server-action files; Next.js forbids non-async exports
// from 'use server' modules, so the schema can't live in actions.ts.
//
// A schedule is an ascending array of { min_cents, step_cents } tiers. Rules
// (mirrored by the client editor in components/BidIncrementScheduleEditor.tsx
// and by the SQL function public.min_bid_increment_cents):
//   • first tier min_cents = 0
//   • min_cents strictly ascending (no duplicates / overlaps)
//   • step_cents >= 25 ($0.25)
// null / omitted = legacy ladder (operator default) or inherit (auction override).

import { z } from 'zod';

const tierSchema = z.object({
  min_cents: z.number().int().min(0),
  step_cents: z.number().int().min(25),
});

export const bidIncrementScheduleSchema = z
  .array(tierSchema)
  .nullable()
  .superRefine((tiers, ctx) => {
    if (!tiers || tiers.length === 0) return; // null/empty = legacy/inherit
    const sorted = [...tiers].sort((a, b) => a.min_cents - b.min_cents);
    if (sorted[0]!.min_cents !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'First tier must start at $0.00.' });
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.min_cents <= sorted[i - 1]!.min_cents) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Tier "price from" values must strictly increase.',
        });
        break;
      }
    }
  });
