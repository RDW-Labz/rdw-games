// Zod schemas — validate at every system boundary (form input, API payloads).

import { z } from 'zod';
import { BIN_CODE_REGEX } from './constants';

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

export const placeBidInputSchema = z.object({
  lotId: z.string().uuid(),
  maxAmountCents: z
    .number()
    .int()
    .positive()
    .max(10_000_000_00, 'Max bid cannot exceed $10,000,000'),
});
export type PlaceBidInput = z.infer<typeof placeBidInputSchema>;

// ---------------------------------------------------------------------------
// Operator onboarding
// ---------------------------------------------------------------------------

export const operatorOnboardSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits, and hyphens only'),
  businessName: z.string().min(1).max(200),
  legalName: z.string().max(200).optional(),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(20).optional(),
});
export type OperatorOnboardInput = z.infer<typeof operatorOnboardSchema>;

// ---------------------------------------------------------------------------
// Warehouse + bins
// ---------------------------------------------------------------------------

export const warehouseInputSchema = z.object({
  name: z.string().min(1).max(120),
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  postalCode: z.string().min(5).max(10),
  timezone: z.string().min(1),
});
export type WarehouseInput = z.infer<typeof warehouseInputSchema>;

export const binInputSchema = z.object({
  warehouseId: z.string().uuid(),
  code: z.string().regex(BIN_CODE_REGEX, 'Invalid bin code (e.g., A-02-3-04)'),
  aisle: z.string().min(1).max(8),
  bay: z.string().max(8).optional(),
  level: z.number().int().min(0).max(99).optional(),
  position: z.number().int().min(0).max(999).optional(),
  // 0108: named zone for grouping bays into printable sections.
  // Free-text; NULL/empty = unsectioned.
  section: z.string().trim().max(60).nullish(),
  xPx: z.number().int().min(0),
  yPx: z.number().int().min(0),
});
export type BinInput = z.infer<typeof binInputSchema>;

// ---------------------------------------------------------------------------
// Lot
// ---------------------------------------------------------------------------

export const lotInputSchema = z.object({
  auctionId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  category: z.string().max(60).optional(),
  condition: z.enum(['appears_new', 'open_box', 'good', 'as_is']),
  msrpCents: z.number().int().nonnegative().optional(),
  startingBidCents: z.number().int().min(100).max(1_000_000_00),
  // 2026-09-30: PostgREST returns timestamptz as '...+00:00'. zod's datetime()
  // accepts only 'Z' unless offset is allowed, so the console New lot form
  // (closeAt = auction.ends_at, straight from the database) failed with
  // 'Invalid datetime' on every auction. Postgres accepts either form.
  closeAt: z.string().datetime({ offset: true }),
  photoUrls: z.array(z.string().url()).max(20).default([]),
  // Non-standard format fields. Server validates these against the parent
  // auction's format.
  flatPriceCents: z.number().int().min(100).max(1_000_000_00).optional(),
  dutchStartCents: z.number().int().min(100).max(1_000_000_00).optional(),
  dutchFloorCents: z.number().int().min(100).max(1_000_000_00).optional(),
  dutchDeclinePerMinuteCents: z.number().int().min(1).max(1_000_000).optional(),
  // 2026-05-20 BUG-LL-01 fix: include early-access in the canonical
  // input so it lands in the INSERT atomically. Previously the form
  // patched it via a separate client-side UPDATE after createLot, which
  // could silently fail on network drop, leaving lots without their
  // early-access window applied. ISO timestamp; null clears any prior
  // value.
  earlyAccessUntil: z.string().datetime({ offset: true }).nullable().optional(),
});
export type LotInput = z.infer<typeof lotInputSchema>;

// ---------------------------------------------------------------------------
// Bin assignment (picker workflow)
// ---------------------------------------------------------------------------

export const binAssignmentInputSchema = z.object({
  lotId: z.string().uuid(),
  binId: z.string().uuid(),
  stagingPhotoUrl: z.string().url().optional(),
  notes: z.string().max(500).optional(),
});
export type BinAssignmentInput = z.infer<typeof binAssignmentInputSchema>;

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

export const disputeInputSchema = z.object({
  invoiceId: z.string().uuid(),
  lotId: z.string().uuid(),
  reason: z.string().min(10).max(2000),
  bidderPhotoUrls: z.array(z.string().url()).min(1).max(8),
});
export type DisputeInput = z.infer<typeof disputeInputSchema>;
