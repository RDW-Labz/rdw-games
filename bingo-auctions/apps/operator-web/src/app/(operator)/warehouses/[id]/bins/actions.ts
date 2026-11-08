'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServer } from '@/lib/supabase-server';
import { binInputSchema, type BinInput } from '@auction-platform/shared/schemas';

type Result = { ok: true } | { ok: false; error: string };

// Same pattern as floorplan/actions.ts: explicit auth + operator-membership
// + role gate + scoped client used for the write. Defense-in-depth: every
// path that writes to bins or modifies a bin must prove the caller owns
// the warehouse (or rather, that the warehouse belongs to the caller's
// operator).
type AuthzOk = { ok: true; supabase: SupabaseClient; operatorId: string };
type AuthzErr = { ok: false; error: string };

async function authorizeWarehouseEdit(warehouseId: string): Promise<AuthzOk | AuthzErr> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_in_operator_users' };
  const meTyped = me as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(meTyped.role)) {
    return { ok: false, error: 'forbidden' };
  }

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, operator_id')
    .eq('id', warehouseId)
    .single();
  if (!wh) return { ok: false, error: 'warehouse_not_found' };
  if ((wh as { operator_id: string }).operator_id !== meTyped.operator_id) {
    return { ok: false, error: 'warehouse_not_in_operator' };
  }

  return { ok: true, supabase, operatorId: meTyped.operator_id };
}

// Resolve a bin's warehouse to authorize a bin-scoped operation (edit/retire).
async function authorizeBinEdit(binId: string): Promise<AuthzOk | AuthzErr> {
  const supabase = await getSupabaseServer();
  const { data: bin } = await supabase
    .from('bins')
    .select('id, warehouse_id')
    .eq('id', binId)
    .single();
  if (!bin) return { ok: false, error: 'bin_not_found' };
  return authorizeWarehouseEdit((bin as { warehouse_id: string }).warehouse_id);
}

export async function createBin(input: BinInput): Promise<Result> {
  const parsed = binInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const authz = await authorizeWarehouseEdit(parsed.data.warehouseId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const { error } = await authz.supabase.from('bins').insert({
    warehouse_id: parsed.data.warehouseId,
    code: parsed.data.code,
    aisle: parsed.data.aisle,
    bay: parsed.data.bay ?? null,
    level: parsed.data.level ?? null,
    position: parsed.data.position ?? null,
    section: parsed.data.section?.trim() ? parsed.data.section.trim() : null,
    x_px: parsed.data.xPx,
    y_px: parsed.data.yPx,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/warehouses/${parsed.data.warehouseId}/bins`);
  revalidatePath(`/warehouses/${parsed.data.warehouseId}`);
  return { ok: true };
}

// Parses "1-10" or "1,3,5" into a list of numbers.
function parseRange(spec: string): number[] {
  const trimmed = spec.trim();
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m && m[1] && m[2]) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > hi) return [];
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? [n] : [];
}

export async function createBinsBulk(input: {
  warehouseId: string;
  aisle: string;
  bays: string;
  levels: string;
  // Optional — when empty, generates one bin per (aisle, bay, level) with
  // position = NULL. Most operators don't use position-level granularity.
  positions?: string;
  // 0108: optional named zone applied to every bin in the batch.
  section?: string;
  skipExisting?: boolean;
}): Promise<{ ok: true; created: number; skipped: number } | { ok: false; error: string }> {
  const authz = await authorizeWarehouseEdit(input.warehouseId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const bays = parseRange(input.bays);
  const levels = parseRange(input.levels);
  const positionsSpec = (input.positions ?? '').trim();
  const positions = positionsSpec.length > 0 ? parseRange(positionsSpec) : [null];

  if (!bays.length || !levels.length || !positions.length) {
    return { ok: false, error: 'Bays and levels must each have at least one value' };
  }

  const aisle = input.aisle.trim();
  const sectionTrimmed = (input.section ?? '').trim();
  const section = sectionTrimmed.length > 0 ? sectionTrimmed : null;
  const rows: Array<{
    warehouse_id: string;
    code: string;
    aisle: string;
    bay: string;
    level: number;
    position: number | null;
    section: string | null;
    x_px: number;
    y_px: number;
  }> = [];

  // Layout: each bay 200px on x, each level 100px on y. Operators drag-to-
  // place in the floor plan editor (Phase 4).
  let bayIdx = 0;
  for (const bay of bays) {
    for (const level of levels) {
      for (const position of positions) {
        // Every numeric segment is LPAD'd to 2 digits so codes sort
        // lexicographically the same as humans would sort them (01, 02, …,
        // 10 not 1, 10, 11, …, 2). Before 0107 this padded bay + position
        // but not level — producing codes like Right-01-1 that sorted as
        // 1, 10, 11, …, 19, 2, 20, 3 …. Migration 0107 renormalizes any
        // existing unpadded codes; this template prevents recurrence.
        const code =
          position == null
            ? `${aisle}-${String(bay).padStart(2, '0')}-${String(level).padStart(2, '0')}`
            : `${aisle}-${String(bay).padStart(2, '0')}-${String(level).padStart(2, '0')}-${String(position).padStart(2, '0')}`;
        rows.push({
          warehouse_id: input.warehouseId,
          code,
          aisle,
          bay: String(bay).padStart(2, '0'),
          level,
          position: position ?? null,
          section,
          x_px: 100 + bayIdx * 200 + (position ?? 0) * 50,
          y_px: 100 + level * 100,
        });
      }
    }
    bayIdx++;
  }

  // Pre-flight: when skipExisting is requested, look up which codes already
  // exist so we can filter them out instead of erroring on the unique
  // (warehouse_id, code) constraint and rolling the whole batch back.
  let skipped = 0;
  let toInsert = rows;
  if (input.skipExisting && rows.length > 0) {
    const codes = rows.map((r) => r.code);
    const { data: existingRows } = await authz.supabase
      .from('bins')
      .select('code')
      .eq('warehouse_id', input.warehouseId)
      .in('code', codes);
    const existing = new Set(
      ((existingRows ?? []) as Array<{ code: string }>).map((r) => r.code),
    );
    toInsert = rows.filter((r) => !existing.has(r.code));
    skipped = rows.length - toInsert.length;
  }

  if (toInsert.length === 0) {
    return { ok: true, created: 0, skipped };
  }

  const { error } = await authz.supabase.from('bins').insert(toInsert);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/warehouses/${input.warehouseId}/bins`);
  revalidatePath(`/warehouses/${input.warehouseId}`);
  return { ok: true, created: toInsert.length, skipped };
}

const updateBinSchema = z.object({
  binId: z.string().uuid(),
  code: z.string().min(1).max(40).optional(),
  aisle: z.string().min(1).max(8).optional(),
  bay: z.string().max(8).nullish(),
  level: z.number().int().min(0).max(99).nullish(),
  section: z.string().trim().max(60).nullish(),
});

export async function updateBin(input: z.infer<typeof updateBinSchema>): Promise<Result> {
  const parsed = updateBinSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const authz = await authorizeBinEdit(parsed.data.binId);
  if (!authz.ok) return { ok: false, error: authz.error };

  // Only set fields the caller actually supplied. Nullish → set to NULL,
  // undefined → leave unchanged.
  const update: Record<string, unknown> = {};
  if (parsed.data.code !== undefined) update.code = parsed.data.code;
  if (parsed.data.aisle !== undefined) update.aisle = parsed.data.aisle;
  if (parsed.data.bay !== undefined) update.bay = parsed.data.bay;
  if (parsed.data.level !== undefined) update.level = parsed.data.level;
  if (parsed.data.section !== undefined) {
    // Treat empty string and whitespace-only as "clear the section".
    const trimmed = (parsed.data.section ?? '').toString().trim();
    update.section = trimmed.length === 0 ? null : trimmed;
  }
  if (Object.keys(update).length === 0) return { ok: true };

  const { data: row, error } = await authz.supabase
    .from('bins')
    .update(update)
    .eq('id', parsed.data.binId)
    .select('warehouse_id')
    .single();
  if (error) return { ok: false, error: error.message };

  const warehouseId = (row as { warehouse_id: string }).warehouse_id;
  revalidatePath(`/warehouses/${warehouseId}/bins`);
  revalidatePath(`/warehouses/${warehouseId}`);
  return { ok: true };
}

// Soft-delete: set retired_at = now(). RPCs that allocate to bins must
// reject retired ones (migration 0094 wires this into intake_lot_to_bin
// and batch_intake_lot_to_bin). Existing bin_assignments at this bin are
// untouched so in-flight pickups still resolve.
export async function retireBin(binId: string): Promise<Result> {
  const authz = await authorizeBinEdit(binId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const { data: row, error } = await authz.supabase
    .from('bins')
    .update({ retired_at: new Date().toISOString() } as never)
    .eq('id', binId)
    .select('warehouse_id')
    .single();
  if (error) return { ok: false, error: error.message };

  const warehouseId = (row as { warehouse_id: string }).warehouse_id;
  revalidatePath(`/warehouses/${warehouseId}/bins`);
  revalidatePath(`/warehouses/${warehouseId}`);
  return { ok: true };
}

// Counterpart for retireBin — restore a bin the operator retired by
// mistake. Just clears retired_at.
export async function unretireBin(binId: string): Promise<Result> {
  const authz = await authorizeBinEdit(binId);
  if (!authz.ok) return { ok: false, error: authz.error };

  const { data: row, error } = await authz.supabase
    .from('bins')
    .update({ retired_at: null } as never)
    .eq('id', binId)
    .select('warehouse_id')
    .single();
  if (error) return { ok: false, error: error.message };

  const warehouseId = (row as { warehouse_id: string }).warehouse_id;
  revalidatePath(`/warehouses/${warehouseId}/bins`);
  revalidatePath(`/warehouses/${warehouseId}`);
  return { ok: true };
}
