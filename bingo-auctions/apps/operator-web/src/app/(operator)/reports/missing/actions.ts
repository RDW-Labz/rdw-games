'use server';

// Missing Items report actions (mig 0426). Each calls one RPC; the RPCs own
// every rule (role, operator, current missing mark, put-away guards).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { DISPOSAL_KINDS, missingActionError } from '@/lib/missing-items-report';

export type MissingActionResult = { ok: true } | { ok: false; error: string };

const lotId = z.string().uuid();
const note = z.string().max(500).optional();

function done(res: { data: unknown; error: { message: string } | null }): MissingActionResult {
  if (res.error) return { ok: false, error: res.error.message };
  const d = res.data as { ok?: boolean; reason?: string; relist_lot_code?: string } | null;
  if (!d?.ok) return { ok: false, error: missingActionError(d?.reason, d?.relist_lot_code) };
  revalidatePath('/reports/missing');
  revalidatePath('/lotting/inventory');
  return { ok: true };
}

/** A bin the put-away could mean, offered when the typed code is still ambiguous. */
export type BinChoice = { id: string; code: string; warehouse: string };
export type FoundResult = MissingActionResult | { ok: false; error: string; choices: BinChoice[] };

/**
 * Found: put it away again on the bin with this code.
 *
 * Bin codes repeat across warehouses by design (every location is laid out
 * 1-01-01, 3-09-01, ...), so the lookup is scoped to the LOT'S warehouse and to
 * active, unretired bins. If it is still ambiguous (or the lot has no
 * warehouse), the matching bins come back as `choices` and the staff member
 * picks one; the pick is sent back as `binId`.
 */
export async function markFound(input: {
  lotId: string;
  binCode: string;
  note?: string;
  binId?: string;
}): Promise<FoundResult> {
  const p = z
    .object({
      lotId,
      binCode: z.string().trim().min(1, 'Enter the bin code'),
      note,
      binId: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? 'Invalid input' };
  const supabase = await getSupabaseServer();

  // The lot's own warehouse (RLS limits lots to this operator).
  const { data: lot } = await supabase
    .from('lots')
    .select('warehouse_id')
    .eq('id', p.data.lotId)
    .maybeSingle();
  const lotWarehouse = (lot as { warehouse_id: string | null } | null)?.warehouse_id ?? null;

  // Put-away takes the bin's QR token. RLS limits bins to this operator.
  let q = supabase
    .from('bins')
    .select('id, code, qr_token, warehouse_id')
    .is('retired_at', null)
    .eq('is_active', true);
  if (p.data.binId) {
    q = q.eq('id', p.data.binId);
  } else {
    // Case-insensitive exact match: escape LIKE wildcards in the typed code.
    q = q.ilike('code', p.data.binCode.replace(/[%_\\]/g, '\\$&'));
  }
  if (lotWarehouse) q = q.eq('warehouse_id', lotWarehouse);
  const { data: bins } = await q.limit(20);
  const list = (bins ?? []) as Array<{ id: string; code: string; qr_token: string; warehouse_id: string }>;

  if (list.length === 0) {
    return {
      ok: false,
      error: lotWarehouse
        ? `No active bin with code ${p.data.binCode} in this lot's warehouse.`
        : `No bin with code ${p.data.binCode}.`,
    };
  }
  if (list.length > 1) {
    // Names for the pick list, read separately (no embed, so no ambiguous-FK risk).
    const ids = [...new Set(list.map((b) => b.warehouse_id))];
    const { data: whs } = await supabase.from('warehouses').select('id, name').in('id', ids);
    const name = new Map(((whs ?? []) as Array<{ id: string; name: string }>).map((w) => [w.id, w.name]));
    return {
      ok: false,
      error: `More than one bin has code ${p.data.binCode}. Pick the one it is going on.`,
      choices: list.map((b) => ({ id: b.id, code: b.code, warehouse: name.get(b.warehouse_id) ?? 'Unknown warehouse' })),
    };
  }

  return done(
    await supabase.rpc('missing_item_found', {
      p_lot_id: p.data.lotId,
      p_bin_qr_token: list[0]!.qr_token,
      p_note: p.data.note ?? null,
    }),
  );
}

/** Confirmed missing: write it off. */
export async function confirmMissing(input: { lotId: string; note?: string }): Promise<MissingActionResult> {
  const p = z.object({ lotId, note }).safeParse(input);
  if (!p.success) return { ok: false, error: 'Invalid input' };
  const supabase = await getSupabaseServer();
  return done(
    await supabase.rpc('missing_item_confirm_missing', {
      p_lot_id: p.data.lotId,
      p_note: p.data.note ?? null,
    }),
  );
}

/** Found but unsellable: without a kind, mark for disposal; with one, record the disposal. */
export async function markUnsellable(input: {
  lotId: string;
  note?: string;
  disposalKind?: (typeof DISPOSAL_KINDS)[number];
}): Promise<MissingActionResult> {
  const p = z
    .object({ lotId, note, disposalKind: z.enum(DISPOSAL_KINDS).optional() })
    .safeParse(input);
  if (!p.success) return { ok: false, error: 'Invalid input' };
  const supabase = await getSupabaseServer();
  return done(
    await supabase.rpc('missing_item_unsellable', {
      p_lot_id: p.data.lotId,
      p_note: p.data.note ?? null,
      p_disposal_kind: p.data.disposalKind ?? null,
    }),
  );
}
