'use server';

// Auto-build batches of auctions from in-inventory lots.
//
// Flow:
//   1. Pull candidate lots (in_inventory, no auction, optional category
//      + warehouse filter).
//   2. Shuffle randomly (per the operator's "random ordering" preference).
//   3. Even-split into chunks of ~lotsPerAuction (extras spread across
//      the first chunks).
//   4. For each chunk: insert a draft auction with computed start/end/
//      pickup times, then call assign_lots_to_auction RPC.
//
// On partial failure (auction N created but assignment fails), the
// caller sees how many auctions succeeded. Cleanup is manual — the
// alternative (rollback by deleting created auctions) is gnarly because
// we'd have to also detect which lots got reassigned and unassign them.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isWarehouseActive } from '@/lib/warehouse-active';
import { computeAuctionTimes } from '@/lib/auction-times';
import { addWallTime, warehouseTimezone, ymdInTimeZone } from '@/lib/datetime';

const autoBuildSchema = z.object({
  warehouseId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  lotsPerAuction: z.number().int().min(10).max(500),
  firstStartsAt: z.string().datetime(),
  cookHours: z.number().int().min(1).max(720),         // up to 30 days
  gapHours: z.number().int().min(0).max(168),          // 0 = same start, up to 7 days apart
  pickupOffsetHours: z.number().int().min(0).max(72),
  pickupDurationHours: z.number().int().min(1).max(168),
  // C2-aligned: closing window in minutes. Each auction's per-lot
  // close_at gets evenly distributed across [ends_at, ends_at + closingWindowMinutes].
  // Default 90min matches the Nellis/MAC.BID pattern. 0 = simultaneous
  // close (legacy mode); >0 = two-endpoint window.
  closingWindowMinutes: z.number().int().min(0).max(720).default(90),
  // Kept for backward compat — used as the legacy fixed-stagger value
  // when closingWindowMinutes is 0. Otherwise the stagger is derived
  // from the window / lot count at assignment time.
  closeStaggerSeconds: z.number().int().min(0).max(60).default(5),
  softCloseMinutes: z.number().int().min(0).max(30),
  buyerPremiumBps: z.number().int().min(0).max(3000),
  format: z.enum(['standard', 'dutch', 'last_chance']).default('standard'),
  titleTemplate: z.string().min(1).max(120).default('Auto-build · {date} · {n} of {total}'),
});

export type AutoBuildInput = z.infer<typeof autoBuildSchema>;

export type AutoBuildResult =
  | {
      ok: true;
      candidateCount: number;
      auctionCount: number;
      assignedCount: number;
      auctions: Array<{
        id: string;
        title: string;
        startsAt: string;
        endsAt: string;
        lotCount: number;
      }>;
    }
  | { ok: false; error: string };

// Preview action — same shape as auto-build but doesn't write. Returns
// what the auto-build WOULD do given current input, so the UI can show
// "5 auctions × 97 lots, starts Mon → Fri."
export type PreviewResult =
  | {
      ok: true;
      candidateCount: number;
      auctionCount: number;
      auctions: Array<{
        index: number;
        startsAt: string;
        endsAt: string;
        /** First lot's close window endpoint. Null when closing-window mode is off. */
        lastLotEndsAt: string | null;
        lotCount: number;
        /** Per-lot stagger derived from window/count. Seconds. */
        stepSec: number;
        title: string;
      }>;
    }
  | { ok: false; error: string };

async function findCandidates(
  supabase: Awaited<ReturnType<typeof getSupabaseServer>>,
  operatorId: string,
  warehouseId: string,
  categoryId: string | null | undefined,
): Promise<string[]> {
  let q = supabase
    .from('lots')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'in_inventory')
    .is('auction_id', null)
    .is('deleted_at', null); // 0057: skip soft-deleted (Trash) lots
  if (categoryId) q = q.eq('category_id', categoryId);
  const { data } = await q.limit(5000);
  return (data ?? []).map((r) => r['id'] as string);
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Even-split: ceil(N/size) buckets, with the remainder distributed across
// the first few. e.g. 487 lots into ~100 = 5 buckets of 97/97/97/98/98
// (no, 487/5 = 97.4 → first 2 get 98, last 3 get 97).
function evenChunks<T>(items: T[], targetSize: number): T[][] {
  if (items.length === 0) return [];
  const count = Math.ceil(items.length / targetSize);
  const base = Math.floor(items.length / count);
  const extras = items.length - base * count;
  const result: T[][] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < extras ? 1 : 0);
    result.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return result;
}

function renderTitle(
  template: string,
  vars: { n: number; total: number; date: string },
): string {
  return template
    .replace(/\{n\}/g, String(vars.n))
    .replace(/\{total\}/g, String(vars.total))
    .replace(/\{date\}/g, vars.date);
}


export async function previewAutoBuild(
  input: AutoBuildInput,
): Promise<PreviewResult> {
  const parsed = autoBuildSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'not_staff' };

  const candidates = await findCandidates(
    supabase,
    staff.operator_id as string,
    parsed.data.warehouseId,
    parsed.data.categoryId,
  );
  if (candidates.length === 0) {
    return {
      ok: true,
      candidateCount: 0,
      auctionCount: 0,
      auctions: [],
    };
  }

  const { data: whTz } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('id', parsed.data.warehouseId)
    .eq('operator_id', staff.operator_id as string)
    .maybeSingle();
  const tz = warehouseTimezone(whTz);

  const chunks = evenChunks(candidates, parsed.data.lotsPerAuction);
  const firstStart = new Date(parsed.data.firstStartsAt);
  const total = chunks.length;
  const previews = chunks.map((chunk, i) => {
    const t = computeAuctionTimes(
      firstStart,
      parsed.data.cookHours,
      parsed.data.gapHours,
      parsed.data.pickupOffsetHours,
      parsed.data.pickupDurationHours,
      i,
      tz,
    );
    const lastLotEndsAt =
      parsed.data.closingWindowMinutes > 0
        ? new Date(t.endsAt.getTime() + parsed.data.closingWindowMinutes * 60 * 1000)
        : null;
    const stepSec =
      parsed.data.closingWindowMinutes > 0 && chunk.length > 1
        ? Math.round((parsed.data.closingWindowMinutes * 60) / (chunk.length - 1))
        : parsed.data.closeStaggerSeconds;
    return {
      index: i + 1,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      lastLotEndsAt: lastLotEndsAt ? lastLotEndsAt.toISOString() : null,
      lotCount: chunk.length,
      stepSec,
      title: renderTitle(parsed.data.titleTemplate, {
        n: i + 1,
        total,
        date: ymdInTimeZone(t.startsAt, tz),
      }),
    };
  });

  return {
    ok: true,
    candidateCount: candidates.length,
    auctionCount: chunks.length,
    auctions: previews,
  };
}

export async function autoBuild(
  input: AutoBuildInput,
): Promise<AutoBuildResult> {
  const parsed = autoBuildSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'not_staff' };
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false, error: 'admin_or_manager_required' };
  }
  const operatorId = staff.operator_id as string;

  // Confirm warehouse belongs to operator.
  const { data: wh } = await supabase
    .from('warehouses')
    .select('*')
    .eq('id', parsed.data.warehouseId)
    .eq('operator_id', operatorId)
    .maybeSingle();
  if (!wh) return { ok: false, error: 'warehouse_not_found' };
  if (!isWarehouseActive(wh as { active?: boolean | null })) {
    return { ok: false, error: 'warehouse_inactive' };
  }

  const candidates = await findCandidates(
    supabase,
    operatorId,
    parsed.data.warehouseId,
    parsed.data.categoryId,
  );
  if (candidates.length === 0) {
    return { ok: false, error: 'no_inventory_matches' };
  }

  // Random ordering per operator preference.
  const shuffled = shuffle(candidates);
  const chunks = evenChunks(shuffled, parsed.data.lotsPerAuction);
  const tz = warehouseTimezone(wh);
  const firstStart = new Date(parsed.data.firstStartsAt);
  const total = chunks.length;
  type CreatedAuction = {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    lotCount: number;
  };
  const created: CreatedAuction[] = [];
  let totalAssigned = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const t = computeAuctionTimes(
      firstStart,
      parsed.data.cookHours,
      parsed.data.gapHours,
      parsed.data.pickupOffsetHours,
      parsed.data.pickupDurationHours,
      i,
      tz,
    );
    const title = renderTitle(parsed.data.titleTemplate, {
      n: i + 1,
      total,
      date: ymdInTimeZone(t.startsAt, tz),
    });

    // C2 closing-window mode: derive per-auction last_lot_ends_at from
    // the operator's window setting. ends_at is the FIRST lot close,
    // last_lot_ends_at is FIRST + closingWindowMinutes. Per-lot close_at
    // gets evenly distributed at assignment time.
    const lastLotEndsAt =
      parsed.data.closingWindowMinutes > 0
        ? new Date(t.endsAt.getTime() + parsed.data.closingWindowMinutes * 60 * 1000)
        : null;
    // Pickup must start AFTER the last lot closes — push it past
    // last_lot_ends_at if necessary so the DB CHECK doesn't fail.
    const safePickupStarts = lastLotEndsAt && t.pickupStartsAt < lastLotEndsAt
      ? addWallTime(lastLotEndsAt, { hours: parsed.data.pickupOffsetHours }, tz)
      : t.pickupStartsAt;
    const safePickupEnds = lastLotEndsAt && t.pickupEndsAt < lastLotEndsAt
      ? addWallTime(safePickupStarts, { hours: parsed.data.pickupDurationHours }, tz)
      : t.pickupEndsAt;

    // Compute the per-lot stagger from the window + assigned lot count.
    // This still gets stored as close_stagger_seconds so the legacy
    // assign_lots_to_auction RPC writes the right close_at; later the
    // operator can run redistribute_close_times to re-anchor against
    // last_lot_ends_at if they edit the window.
    const derivedStagger =
      parsed.data.closingWindowMinutes > 0 && chunk.length > 1
        ? Math.max(
            0,
            Math.min(
              60,
              Math.round((parsed.data.closingWindowMinutes * 60) / (chunk.length - 1)),
            ),
          )
        : parsed.data.closeStaggerSeconds;

    // Create the auction (status='draft').
    const { data: auction, error: insErr } = await supabase
      .from('auctions')
      .insert({
        operator_id: operatorId,
        warehouse_id: parsed.data.warehouseId,
        title,
        description: null,
        format: parsed.data.format,
        status: 'draft',
        starts_at: t.startsAt.toISOString(),
        ends_at: t.endsAt.toISOString(),
        last_lot_ends_at: lastLotEndsAt ? lastLotEndsAt.toISOString() : null,
        pickup_starts_at: safePickupStarts.toISOString(),
        pickup_ends_at: safePickupEnds.toISOString(),
        soft_close_minutes: parsed.data.softCloseMinutes,
        buyer_premium_bps: parsed.data.buyerPremiumBps,
        close_stagger_seconds: derivedStagger,
      })
      .select('id')
      .single();
    if (insErr || !auction) {
      return {
        ok: false,
        error: `auction_${i + 1}_insert_failed: ${insErr?.message ?? 'unknown'} (${created.length} auctions already created)`,
      };
    }

    // Assign the chunk's lots via the RPC.
    const { data: assigned, error: rpcErr } = await supabase.rpc(
      'assign_lots_to_auction',
      {
        p_auction_id: auction.id,
        p_lot_ids: chunk,
      },
    );
    if (rpcErr) {
      return {
        ok: false,
        error: `auction_${i + 1}_assign_failed: ${rpcErr.message ?? 'unknown'} (${created.length} auctions already created)`,
      };
    }
    const assignedCount = ((assigned ?? []) as unknown[]).length;
    totalAssigned += assignedCount;

    created.push({
      id: auction.id,
      title,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      lotCount: assignedCount,
    });
  }

  revalidatePath('/auctions');
  revalidatePath('/inventory');

  return {
    ok: true,
    candidateCount: candidates.length,
    auctionCount: created.length,
    assignedCount: totalAssigned,
    auctions: created,
  };
}

export async function listWarehousesAndCategories(): Promise<{
  warehouses: Array<{ id: string; name: string; timezone: string | null }>;
  categories: Array<{ id: string; name: string; slug: string }>;
}> {
  const supabase = await getSupabaseServer();
  const [{ data: warehouses }, { data: categories }] = await Promise.all([
    supabase.from('warehouses').select('*').order('name'),
    supabase
      .from('categories')
      .select('id, name, slug')
      .order('sort_order', { ascending: true }),
  ]);
  return {
    warehouses: ((warehouses ?? []) as Array<{ id: string; name: string; timezone: string | null; active?: boolean | null }>)
      .filter(isWarehouseActive)
      .map(({ id, name, timezone }) => ({ id, name, timezone })),
    categories: (categories ?? []) as Array<{ id: string; name: string; slug: string }>,
  };
}
