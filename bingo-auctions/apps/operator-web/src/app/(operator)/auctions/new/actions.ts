'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServer } from '@/lib/supabase-server';
// BID-3: reuse the EXACT same tier-array validation the operator-default
// settings use, so the per-auction override enforces identical rules
// (first tier $0, strictly ascending, step >= $0.25; null = inherit default).
import { bidIncrementScheduleSchema } from '@/lib/bid-increment-schedule';
// AUCT-1: no-Stripe test-mode (migration 0198). When payments are disabled
// platform-wide, the Stripe-Connect schedule gate is bypassed so an operator
// can run the full auction loop without a live card processor.
import { isPaymentsDisabled } from '@/lib/payments-mode';
import { isWarehouseActive } from '@/lib/warehouse-active';
import { shiftIsoByDays } from '@/lib/auction-times';
import { warehouseTimezone } from '@/lib/datetime';

// 2026-05-20 BUG-AC-01/02/03 hardening: every server action that touches
// an auction row now explicitly re-verifies the caller is an operator
// staff member whose operator_id matches the auction's owner. RLS at the
// DB layer should catch cross-tenant writes too, but defense-in-depth: a
// future RLS change shouldn't be the only thing standing between operator
// A and operator B's draft auction. We also drop the raw Postgres
// `error.message` from cross-tenant denial paths so DB schema details
// don't leak through the API.

type StaffAuthOk = { ok: true; supabase: SupabaseClient; operatorId: string };
type StaffAuthErr = { ok: false; error: string };

async function authorizeOperatorStaff(): Promise<StaffAuthOk | StaffAuthErr> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  return {
    ok: true,
    supabase,
    operatorId: (staff as { operator_id: string }).operator_id,
  };
}

async function authorizeAuctionEdit(
  auctionId: string,
): Promise<(StaffAuthOk & { auction: { id: string; status: string; operator_id: string } }) | StaffAuthErr> {
  const authz = await authorizeOperatorStaff();
  if (!authz.ok) return authz;
  const { data: auction } = await authz.supabase
    .from('auctions')
    .select('id, status, operator_id')
    .eq('id', auctionId)
    .single();
  if (!auction) return { ok: false, error: 'Auction not found' };
  const auctionTyped = auction as { id: string; status: string; operator_id: string };
  if (auctionTyped.operator_id !== authz.operatorId) {
    return { ok: false, error: 'Auction not found' };
  }
  return { ...authz, auction: auctionTyped };
}

const createAuctionSchema = z.object({
  warehouseId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  format: z.enum(['standard', 'dutch', 'last_chance']).default('standard'),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  pickupStartsAt: z.string().datetime(),
  pickupEndsAt: z.string().datetime(),
  softCloseMinutes: z.number().int().min(0).max(30),
  buyerPremiumBps: z.number().int().min(0).max(3000),
  // Two-endpoint ending window (preferred path, added in 0053). When both
  // are set, redistribute_close_times() can evenly distribute close_at
  // across [endsAt, lastLotEndsAt]. The legacy fixed-stagger field
  // closeStaggerSeconds is still accepted for callers that don't yet
  // know about the window — kept for backward compat.
  lastLotEndsAt: z.string().datetime().nullable().optional(),
  // 0 = simultaneous close. 5 sec stagger × 500 lots = ~42 min spread.
  // Cap at 60s so a max-stagger 2500-lot auction spreads 41 hours
  // (still less than typical pickup window).
  closeStaggerSeconds: z.number().int().min(0).max(60).default(0),
  // BID-3: optional per-auction increment override. null/omitted = inherit the
  // operator default (operators.bid_increment_schedule), which itself falls
  // back to the legacy ladder when null.
  bidIncrementSchedule: bidIncrementScheduleSchema.optional(),
  // 0221: allow bids during the preview window (before starts_at). Preview
  // bids never flip lots live and never extend soft-close (place_bid gates).
  // 0222: default ON (owner 2026-07-04) — the console checkbox opts OUT.
  prebidEnabled: z.boolean().default(true),
  // 0242: link-only test auction — hidden from all public discovery.
  unlisted: z.boolean().default(false),
});

type Input = z.infer<typeof createAuctionSchema>;
type Result = { ok: true; auctionId: string } | { ok: false; error: string };

export async function listWarehouses(): Promise<Array<{ id: string; name: string }>> {
  // BUG-AC-03 fix: auth + operator-scope this. Previously any caller
  // (including a logged-out browser session that somehow reached the
  // server action endpoint) got whatever RLS leaked.
  const authz = await authorizeOperatorStaff();
  if (!authz.ok) return [];
  const { data } = await authz.supabase
    .from('warehouses')
    .select('*')
    .eq('operator_id', authz.operatorId)
    .order('name');
  return ((data ?? []) as Array<{ id: string; name: string; active?: boolean | null }>)
    .filter(isWarehouseActive)
    .map(({ id, name }) => ({ id, name }));
}

// New-auction form defaults. Seeds the soft-close + buyer-premium fields from
// the operator's configured defaults (operators.default_soft_close_minutes /
// default_buyer_premium_bps) instead of hardcoding 3min / 1500bps in the form.
// Returns null when the caller isn't operator staff so the form keeps its
// own fallbacks.
export async function getOperatorAuctionDefaults(): Promise<{
  defaultSoftCloseMinutes: number;
  defaultBuyerPremiumBps: number;
} | null> {
  const authz = await authorizeOperatorStaff();
  if (!authz.ok) return null;
  const { data } = await authz.supabase
    .from('operators')
    .select('default_soft_close_minutes, default_buyer_premium_bps')
    .eq('id', authz.operatorId)
    .single();
  if (!data) return null;
  const row = data as {
    default_soft_close_minutes: number | null;
    default_buyer_premium_bps: number | null;
  };
  return {
    defaultSoftCloseMinutes: row.default_soft_close_minutes ?? 3,
    defaultBuyerPremiumBps: row.default_buyer_premium_bps ?? 1500,
  };
}

export async function createAuction(input: Input): Promise<Result> {
  const parsed = createAuctionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  if (new Date(parsed.data.endsAt) <= new Date(parsed.data.startsAt)) {
    return { ok: false, error: 'Bidding must end after it starts' };
  }
  // last_lot_ends_at >= ends_at — the DB CHECK from 0053 enforces this
  // too, but a friendly error here beats a Postgres constraint violation.
  if (
    parsed.data.lastLotEndsAt &&
    new Date(parsed.data.lastLotEndsAt) < new Date(parsed.data.endsAt)
  ) {
    return {
      ok: false,
      error: 'Last lot close must be at or after first lot close',
    };
  }
  if (new Date(parsed.data.pickupStartsAt) < new Date(parsed.data.endsAt)) {
    return { ok: false, error: 'Pickup window must start at or after bidding ends' };
  }
  if (
    parsed.data.lastLotEndsAt &&
    new Date(parsed.data.pickupStartsAt) < new Date(parsed.data.lastLotEndsAt)
  ) {
    return {
      ok: false,
      error: 'Pickup window must start at or after the LAST lot closes',
    };
  }

  const authz = await authorizeOperatorStaff();
  if (!authz.ok) return { ok: false, error: authz.error };

  // Also verify the warehouse belongs to this operator — otherwise a
  // determined caller could create an auction at another operator's
  // warehouse by passing their UUID.
  const { data: wh } = await authz.supabase
    .from('warehouses')
    .select('*')
    .eq('id', parsed.data.warehouseId)
    .single();
  if (!wh || (wh as { operator_id: string }).operator_id !== authz.operatorId) {
    return { ok: false, error: 'Warehouse not found' };
  }
  if (!isWarehouseActive(wh as { active?: boolean | null })) {
    return { ok: false, error: 'That warehouse is inactive and cannot be used for new auctions' };
  }

  const { data, error } = await authz.supabase
    .from('auctions')
    .insert({
      operator_id: authz.operatorId,
      warehouse_id: parsed.data.warehouseId,
      title: parsed.data.title,
      description: parsed.data.description,
      format: parsed.data.format,
      status: 'draft',
      starts_at: parsed.data.startsAt,
      ends_at: parsed.data.endsAt,
      pickup_starts_at: parsed.data.pickupStartsAt,
      pickup_ends_at: parsed.data.pickupEndsAt,
      soft_close_minutes: parsed.data.softCloseMinutes,
      buyer_premium_bps: parsed.data.buyerPremiumBps,
      close_stagger_seconds: parsed.data.closeStaggerSeconds,
      last_lot_ends_at: parsed.data.lastLotEndsAt ?? null,
      // BID-3: null = inherit the operator default ladder.
      bid_increment_schedule: parsed.data.bidIncrementSchedule ?? null,
      prebid_enabled: parsed.data.prebidEnabled,
      unlisted: parsed.data.unlisted, // 0242
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed' };

  revalidatePath('/auctions');
  return { ok: true, auctionId: data.id };
}

// Flips an auction from 'draft' → 'scheduled' and moves its draft lots
// to scheduled. Auction close is now driven by Supabase pg_cron's
// finalize_due_lots() which scans `lots WHERE close_at <= now()` every
// 5 seconds — setting lots.close_at + status='scheduled' is sufficient
// for the lot to be picked up automatically at the right moment.
// (Soft-close extensions still happen inside place_bid and are picked
// up by the same scan on the next tick.)
export async function scheduleAuction(auctionId: string): Promise<Result> {
  // BUG-AC-01 fix: defense-in-depth scope verification.
  const authz = await authorizeAuctionEdit(auctionId);
  if (!authz.ok) return { ok: false, error: authz.error };

  if (authz.auction.status !== 'draft') {
    return { ok: false, error: `Cannot schedule from status=${authz.auction.status}` };
  }

  // S13-F1 money-safety gate: refuse to schedule if Stripe Connect charges
  // are not yet enabled on this operator's account. Without this check,
  // bidders can win lots but the platform can never collect payment —
  // operators must complete Connect onboarding before going live.
  //
  // AUCT-1: skip this gate entirely in no-Stripe test-mode (platform_settings
  // .payments_disabled — migration 0198). With no live processor there's no
  // Connect onboarding to complete, and the auction loop is meant to run
  // end-to-end without it. isPaymentsDisabled() fails safe to false (the
  // normal Stripe path), so a flag-read glitch can never silently let a live
  // operator schedule without charges enabled.
  const { data: op } = await authz.supabase
    .from('operators')
    .select('stripe_charges_enabled')
    .eq('id', authz.auction.operator_id)
    .single();
  if (!(await isPaymentsDisabled()) && !op?.stripe_charges_enabled) {
    return {
      ok: false,
      error: 'Complete Stripe Connect onboarding before scheduling a live auction.',
    };
  }

  const { error: updErr } = await authz.supabase
    .from('auctions')
    .update({ status: 'scheduled' })
    .eq('id', auctionId)
    .eq('operator_id', authz.operatorId);
  if (updErr) return { ok: false, error: 'Could not schedule auction' };

  await authz.supabase
    .from('lots')
    .update({ status: 'scheduled' })
    .eq('auction_id', auctionId)
    .eq('operator_id', authz.operatorId)
    .eq('status', 'draft');

  revalidatePath('/auctions');
  revalidatePath(`/auctions/${auctionId}`);
  return { ok: true, auctionId };
}

const editAuctionSchema = z.object({
  auctionId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  lastLotEndsAt: z.string().datetime().nullable().optional(),
  pickupStartsAt: z.string().datetime(),
  pickupEndsAt: z.string().datetime(),
  softCloseMinutes: z.number().int().min(0).max(30),
  buyerPremiumBps: z.number().int().min(0).max(3000),
  // BID-3: optional per-auction increment override. null = inherit operator default.
  bidIncrementSchedule: bidIncrementScheduleSchema.optional(),
  // 0221: preview pre-bidding toggle. Editable in draft AND scheduled (turning
  // it on opens the preview; turning it off before start closes it).
  prebidEnabled: z.boolean().default(false),
});

// Edit an auction. While in 'draft' anything goes. Once 'scheduled', we
// allow extending ends_at / pickup window and tweaking soft-close minutes,
// but not pulling in the close (would surprise bidders) or changing the
// premium retroactively. Once 'live'/'closed' the form is locked.
export async function editAuction(input: z.infer<typeof editAuctionSchema>): Promise<Result> {
  const parsed = editAuctionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  // BUG-AC-01 fix: scope verification before any read or write.
  const authz = await authorizeAuctionEdit(parsed.data.auctionId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const { data: existing } = await authz.supabase
    .from('auctions')
    .select('status, ends_at, buyer_premium_bps')
    .eq('id', parsed.data.auctionId)
    .eq('operator_id', authz.operatorId)
    .single();
  if (!existing) return { ok: false, error: 'Auction not found' };

  if (['live', 'closed', 'canceled'].includes(existing.status as string)) {
    return { ok: false, error: `Cannot edit a ${existing.status} auction` };
  }
  if (new Date(parsed.data.endsAt) <= new Date(parsed.data.startsAt)) {
    return { ok: false, error: 'Bidding must end after it starts' };
  }
  if (
    parsed.data.lastLotEndsAt &&
    new Date(parsed.data.lastLotEndsAt) < new Date(parsed.data.endsAt)
  ) {
    return {
      ok: false,
      error: 'Last lot close must be at or after first lot close',
    };
  }
  if (new Date(parsed.data.pickupStartsAt) < new Date(parsed.data.endsAt)) {
    return { ok: false, error: 'Pickup window must start at or after bidding ends' };
  }
  if (
    parsed.data.lastLotEndsAt &&
    new Date(parsed.data.pickupStartsAt) < new Date(parsed.data.lastLotEndsAt)
  ) {
    return {
      ok: false,
      error: 'Pickup window must start at or after the LAST lot closes',
    };
  }

  // Scheduled auctions can only be edited safely when the changes are
  // bidder-friendly (extending close, raising soft-close minutes).
  if (existing.status === 'scheduled') {
    if (new Date(parsed.data.endsAt) < new Date(existing.ends_at as string)) {
      return {
        ok: false,
        error: "Can't pull in ends_at after scheduling. Extend instead, or cancel and re-create.",
      };
    }
    if (parsed.data.buyerPremiumBps !== (existing.buyer_premium_bps as number)) {
      return { ok: false, error: "Can't change buyer's premium after scheduling." };
    }
  }

  const updatePayload: Record<string, unknown> = {
    title: parsed.data.title,
    description: parsed.data.description,
    starts_at: parsed.data.startsAt,
    ends_at: parsed.data.endsAt,
    // Allow null to opt back to legacy fixed-stagger; otherwise persist.
    last_lot_ends_at: parsed.data.lastLotEndsAt ?? null,
    pickup_starts_at: parsed.data.pickupStartsAt,
    pickup_ends_at: parsed.data.pickupEndsAt,
    soft_close_minutes: parsed.data.softCloseMinutes,
    prebid_enabled: parsed.data.prebidEnabled, // 0221
    buyer_premium_bps: parsed.data.buyerPremiumBps,
  };
  // BID-3: only touch the override when the form supplied it (undefined =
  // "leave as-is"; null = "inherit operator default"; array = override). The
  // increment only raises the floor for FUTURE bids, so it's bidder-safe to
  // change while scheduled — no extra status gate needed.
  if (parsed.data.bidIncrementSchedule !== undefined) {
    updatePayload['bid_increment_schedule'] = parsed.data.bidIncrementSchedule;
  }

  const { error } = await authz.supabase
    .from('auctions')
    .update(updatePayload)
    .eq('id', parsed.data.auctionId)
    .eq('operator_id', authz.operatorId);
  if (error) return { ok: false, error: 'Could not save auction edits' };

  // If the auction is scheduled and ends_at extended, bump close_at on
  // every lot that hasn't been bid on yet. (place_bid handles soft-close
  // extension on its own for active lots.) pg_cron's finalize_due_lots()
  // re-evaluates close_at every 5s, so updating the column is sufficient
  // — no separate job rescheduling needed anymore.
  if (existing.status === 'scheduled') {
    const { data: lots } = await authz.supabase
      .from('lots')
      .select('id, close_at, bid_count')
      .eq('auction_id', parsed.data.auctionId)
      .eq('operator_id', authz.operatorId)
      .in('status', ['scheduled', 'live']);
    const candidates = (lots ?? []).filter((l) => (l.bid_count as number) === 0);
    if (candidates.length > 0) {
      await authz.supabase
        .from('lots')
        .update({ close_at: parsed.data.endsAt })
        .in(
          'id',
          candidates.map((l) => l.id as string),
        )
        .eq('operator_id', authz.operatorId);
    }
  } else if (existing.status === 'draft') {
    // Draft schedule edits must re-anchor lots.close_at too: the close cron
    // (finalize_due_lots) fires on each lot's close_at, which was anchored to
    // the auction's ORIGINAL ends_at at lot-attach time. Without this, editing
    // a draft's schedule changes only the display columns and the auction still
    // opens/closes on its pre-edit times (tester report 2026-06-16, Test
    // Auctions 0.16-0.18). Drafts have no bids, so a full respread is safe.
    if (parsed.data.lastLotEndsAt) {
      // Windowed: evenly respread close_at across [ends_at, last_lot_ends_at].
      // RPC permits draft+scheduled and no-ops on cross-tenant / legacy mode.
      await authz.supabase.rpc('redistribute_close_times', {
        p_auction_id: parsed.data.auctionId,
      });
    } else {
      // Legacy fixed-stagger (no second endpoint): anchor every lot to the new
      // ends_at so none keeps a stale pre-edit close_at.
      await authz.supabase
        .from('lots')
        .update({ close_at: parsed.data.endsAt })
        .eq('auction_id', parsed.data.auctionId)
        .eq('operator_id', authz.operatorId)
        .in('status', ['scheduled']);
    }
  }

  revalidatePath('/auctions');
  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  return { ok: true, auctionId: parsed.data.auctionId };
}

// ── Clone an existing auction ───────────────────────────────────────────────
//
// Volume tool. Operators running daily auctions don't want to retype the
// same warehouse + format + buyer premium + soft-close + window every
// day. Clone copies all the configuration of an existing auction but:
//   - Generates a new title prefixed with "Copy of "
//   - Bumps the date fields forward by 7 days (typical weekly cadence)
//     while preserving the time-of-day and the duration of each window
//   - Resets status to 'draft'
//   - Does NOT copy lots — the operator picks fresh inventory in the
//     builder. (We don't want to accidentally re-auction items.)
//   - Does NOT copy featured_image_urls — they belong to specific lots
//     in the source auction, not the new one. The operator runs
//     auto_pick_featured_images on the new auction once lots are added.
//
// This is the "cmd-D in iWork" / "duplicate" pattern — single click,
// land on the new auction's edit page so the operator can tweak.

const cloneAuctionSchema = z.object({
  sourceAuctionId: z.string().uuid(),
  /** Days to shift the auction forward. Default 7 (next week). */
  daysOffset: z.number().int().min(0).max(365).default(7),
});

export async function cloneAuction(
  input: z.infer<typeof cloneAuctionSchema>,
): Promise<Result> {
  const parsed = cloneAuctionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  // BUG-AC-02 fix: must verify caller owns the source auction. Previously
  // any caller could clone any auction by UUID and the new row would be
  // written with src.operator_id (the SOURCE operator) — silently making
  // data ownership confused. Now we require src.operator_id == caller's
  // operatorId, and use caller's operatorId on the insert.
  const authz = await authorizeOperatorStaff();
  if (!authz.ok) return { ok: false, error: authz.error };

  const { data: src } = await authz.supabase
    .from('auctions')
    .select(
      'operator_id, warehouse_id, title, description, format, starts_at, ends_at, last_lot_ends_at, pickup_starts_at, pickup_ends_at, soft_close_minutes, buyer_premium_bps, close_stagger_seconds, prebid_enabled, warehouses(timezone)',
    )
    .eq('id', parsed.data.sourceAuctionId)
    .single();
  if (!src) return { ok: false, error: 'Source auction not found' };
  if ((src as { operator_id: string }).operator_id !== authz.operatorId) {
    return { ok: false, error: 'Source auction not found' };
  }

  // Shift each datetime by daysOffset days on the warehouse's wall clock, so
  // 10:30 AM stays 10:30 AM across a DST change (setDate on the UTC server
  // kept the UTC hour instead).
  const tz = warehouseTimezone((src as { warehouses?: unknown }).warehouses);
  const shift = (iso: string | null): string | null => shiftIsoByDays(iso, parsed.data.daysOffset, tz);

  const insertRow = {
    operator_id: authz.operatorId,
    warehouse_id: src.warehouse_id,
    title: `Copy of ${src.title}`,
    description: src.description,
    format: src.format,
    status: 'draft',
    starts_at: shift(src.starts_at as string)!,
    ends_at: shift(src.ends_at as string)!,
    last_lot_ends_at: shift(src.last_lot_ends_at as string | null),
    pickup_starts_at: shift(src.pickup_starts_at as string)!,
    pickup_ends_at: shift(src.pickup_ends_at as string)!,
    soft_close_minutes: src.soft_close_minutes,
    buyer_premium_bps: src.buyer_premium_bps,
    close_stagger_seconds: src.close_stagger_seconds,
    prebid_enabled: (src as { prebid_enabled?: boolean }).prebid_enabled ?? false, // 0221
    // featured_image_urls intentionally omitted — they belong to source
    // lots which won't be in the new auction. Operator re-runs auto-pick.
  };

  const { data, error } = await authz.supabase
    .from('auctions')
    .insert(insertRow)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: 'Clone failed' };

  revalidatePath('/auctions');
  return { ok: true, auctionId: data.id };
}

// Cancel a draft or scheduled auction. Refuses if any lot has bids.
//
// 2026-05-20 migration 0096: delegates to the new cancel_auction RPC
// which holds an advisory lock on the auction id, atomically flips the
// auction + all its draft/scheduled/live lots to canceled, and captures
// canceled_at + canceled_by for audit. The RPC also enforces
// admin/manager role and operator scope DB-side; the JS scope check
// here is defense-in-depth.
export async function cancelAuction(auctionId: string, reason?: string): Promise<Result> {
  const authz = await authorizeAuctionEdit(auctionId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const { data, error } = await authz.supabase.rpc('cancel_auction', {
    p_auction_id: auctionId,
    p_reason: reason ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const result = data as { ok?: boolean; error?: string } | null;
  if (result && result.ok === false) {
    // Map a few RPC error codes to friendly messages.
    const code = result.error ?? 'unknown';
    const friendly =
      code === 'auction_has_bids'
        ? 'Auction has lots with bids — cannot cancel without issuing refunds first.'
        : code === 'wrong_status'
          ? 'Only draft or scheduled auctions can be canceled.'
          : code === 'insufficient_role'
            ? 'Admin or manager access required to cancel.'
            : code === 'auction_not_found'
              ? 'Auction not found'
              : code;
    return { ok: false, error: friendly };
  }

  revalidatePath('/auctions');
  revalidatePath(`/auctions/${auctionId}`);
  return { ok: true, auctionId };
}
