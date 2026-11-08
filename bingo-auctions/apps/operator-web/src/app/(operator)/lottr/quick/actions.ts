'use server';

// Quick Lot server actions.
//
// No manifest, no AI, no import_row — these lots are created directly from
// operator manual entry. They land as pending_intake with auction_id NULL
// and proceed through the normal intake scan → in_inventory pipeline.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { resolveCatalogImages } from '@/lib/catalog/resolve-catalog-images';

// ---------------------------------------------------------------------------
// Shared input schema
// ---------------------------------------------------------------------------

const CONDITIONS = [
  'New/Sealed',
  'New/Open Box',
  'Good',
  'Fair',
  'Damaged/Parts',
] as const;

export type QuickLotCondition = (typeof CONDITIONS)[number];

const quickLotBaseSchema = z.object({
  title: z.string().min(1).max(500).trim(),
  brand: z.string().max(200).trim().optional(),
  model: z.string().max(200).trim().optional(),
  category_id: z.string().uuid().nullable().optional(),
  condition: z.enum(CONDITIONS),
  starting_bid_cents: z.number().int().positive(),
  photo_url: z.string().url().optional(),
  // Optional product identifiers. When present (populated by the lotting search
  // flow), the created lot pulls a catalog stock image — enriching the catalog
  // on a miss. Absent for pure manual entry → the resolve step no-ops.
  upc: z.string().trim().max(64).optional(),
  asin: z.string().trim().max(32).optional(),
  // 0272: per-submit idempotency token. The client mints one UUID per filled
  // form and reuses it on a double-click / server-action retry, so the second
  // create returns the first lot instead of a duplicate (enforced by the
  // (operator_id, client_dedup_token) unique index). Optional → pure-manual
  // callers that don't send one keep the prior behavior.
  client_token: z.string().uuid().optional(),
});

export type QuickLotInput = z.infer<typeof quickLotBaseSchema>;

const quickLotMultiplesSchema = quickLotBaseSchema.extend({
  count: z.number().int().min(2).max(20),
});

export type QuickLotMultiplesInput = z.infer<typeof quickLotMultiplesSchema>;

// ---------------------------------------------------------------------------
// Shared auth / role check
// ---------------------------------------------------------------------------

type StaffContext = { operatorId: string };

async function requireAdminOrManager(): Promise<
  { ok: true; ctx: StaffContext } | { ok: false; error: string }
> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  return { ok: true, ctx: { operatorId: staff.operator_id as string } };
}

// ---------------------------------------------------------------------------
// Build the lot insert row (minus lot_code, which requires the RPC)
// ---------------------------------------------------------------------------

function buildLotInsert(
  operatorId: string,
  lotCode: string,
  input: QuickLotInput,
) {
  return {
    operator_id: operatorId,
    lot_code: lotCode,
    // No auction membership yet — Quick Lot creates unassigned inventory.
    auction_id: null,
    lot_number: null,
    warehouse_id: null,
    close_at: null,
    import_row_id: null,
    status: 'pending_intake' as const,
    title: input.title,
    brand: input.brand ?? null,
    model: input.model ?? null,
    category_id: input.category_id ?? null,
    condition: input.condition,
    msrp_cents: null,
    starting_bid_cents: input.starting_bid_cents,
    photo_urls: input.photo_url ? [input.photo_url] : [],
    upc: input.upc ?? null,
    asin: input.asin ?? null,
    // 0272: idempotency token (null for the multiples path, which doesn't pass
    // one — it relies on the client submit mutex instead).
    client_dedup_token: input.client_token ?? null,
  };
}

// ---------------------------------------------------------------------------
// createQuickLot — single lot
// ---------------------------------------------------------------------------

export type CreateQuickLotResult =
  | { ok: true; lotId: string; lotCode: string }
  | { ok: false; error: string };

export async function createQuickLot(
  input: QuickLotInput,
): Promise<CreateQuickLotResult> {
  const parsed = quickLotBaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'invalid input',
    };
  }

  const auth = await requireAdminOrManager();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { operatorId } = auth.ctx;

  const supabase = await getSupabaseServer();

  // Mint lot code atomically via the SECURITY DEFINER RPC.
  const { data: codeData, error: codeErr } = await supabase.rpc(
    'next_lot_code',
    { p_operator_id: operatorId },
  );
  if (codeErr || !codeData) {
    return {
      ok: false,
      error: codeErr?.message ?? 'failed to generate lot code',
    };
  }
  const lotCode = codeData as string;

  const { data, error } = await supabase
    .from('lots')
    .insert(buildLotInsert(operatorId, lotCode, parsed.data))
    .select('id')
    .single();

  if (error || !data) {
    // 0272: a double-click / server-action retry reuses the same client_token
    // and trips the (operator_id, client_dedup_token) unique index (23505).
    // That's not a failure — the first submit already created the lot; return
    // it so the operator sees one lot, not an error. (The lot_code minted just
    // above is burned; a gap in the sequence is acceptable, matching the
    // existing failed-insert behavior.)
    if (
      parsed.data.client_token &&
      (error as { code?: string } | null)?.code === '23505'
    ) {
      const { data: existing } = await supabase
        .from('lots')
        .select('id, lot_code')
        .eq('operator_id', operatorId)
        .eq('client_dedup_token', parsed.data.client_token)
        .maybeSingle();
      if (existing) {
        return {
          ok: true,
          lotId: existing.id as string,
          lotCode: existing.lot_code as string,
        };
      }
    }
    return { ok: false, error: error?.message ?? 'insert failed' };
  }

  // Catalog stock image: when the operator supplied an identifier and no manual
  // photo, pull images from the catalog (enriching on a miss + warming it for
  // next time). Best-effort — resolveCatalogImages never throws, so a failure
  // just leaves the lot photo-less rather than failing the create.
  if (!parsed.data.photo_url && (parsed.data.upc || parsed.data.asin)) {
    const { imageUrls } = await resolveCatalogImages({
      admin: getSupabaseAdmin(),
      upc: parsed.data.upc,
      asin: parsed.data.asin,
      contributedByOperatorId: operatorId,
    });
    if (imageUrls.length > 0) {
      await supabase
        .from('lots')
        .update({ photo_urls: imageUrls })
        .eq('id', data.id as string);
    }
  }

  revalidatePath('/inventory');
  revalidatePath('/lottr/quick');

  return { ok: true, lotId: data.id as string, lotCode };
}

// ---------------------------------------------------------------------------
// createQuickLotMultiples — create N identical lots in a loop.
//
// Supabase JS does not expose BEGIN/COMMIT directly, so we call next_lot_code
// N times and insert N rows in a single batch insert. The RPC increments the
// operator sequence atomically on each call so no two codes collide.
// If the batch insert fails the codes are "burned" (gap in sequence) but
// that is acceptable — same behaviour as any failed lot insert.
// ---------------------------------------------------------------------------

export type CreateQuickLotMultiplesResult =
  | { ok: true; lots: Array<{ lotId: string; lotCode: string }> }
  | { ok: false; error: string };

export async function createQuickLotMultiples(
  input: QuickLotMultiplesInput,
): Promise<CreateQuickLotMultiplesResult> {
  const parsed = quickLotMultiplesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'invalid input',
    };
  }

  const auth = await requireAdminOrManager();
  if (!auth.ok) return { ok: false, error: auth.error };
  const { operatorId } = auth.ctx;

  const supabase = await getSupabaseServer();
  const { count, ...lotBase } = parsed.data;

  // Mint N codes sequentially (RPC is atomic per call).
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const { data: codeData, error: codeErr } = await supabase.rpc(
      'next_lot_code',
      { p_operator_id: operatorId },
    );
    if (codeErr || !codeData) {
      return {
        ok: false,
        error: `code generation failed at lot ${i + 1}: ${codeErr?.message ?? 'unknown'}`,
      };
    }
    codes.push(codeData as string);
  }

  // Batch insert all N lots in one round-trip.
  const rows = codes.map((lotCode) =>
    buildLotInsert(operatorId, lotCode, lotBase),
  );

  const { data, error } = await supabase
    .from('lots')
    .insert(rows)
    .select('id, lot_code');

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'batch insert failed' };
  }

  // Catalog stock image (multiples): resolve ONCE for the shared identifier and
  // apply the same images to all N lots. Best-effort.
  if (!lotBase.photo_url && (lotBase.upc || lotBase.asin)) {
    const { imageUrls } = await resolveCatalogImages({
      admin: getSupabaseAdmin(),
      upc: lotBase.upc,
      asin: lotBase.asin,
      contributedByOperatorId: operatorId,
    });
    if (imageUrls.length > 0) {
      const ids = (data as Array<{ id: string }>).map((r) => r.id);
      await supabase.from('lots').update({ photo_urls: imageUrls }).in('id', ids);
    }
  }

  revalidatePath('/inventory');
  revalidatePath('/lottr/quick');

  return {
    ok: true,
    lots: (data as Array<{ id: string; lot_code: string }>).map((r) => ({
      lotId: r.id,
      lotCode: r.lot_code,
    })),
  };
}

// ---------------------------------------------------------------------------
// listCategories — leaf categories for the optional picker.
// Called from the page server component and passed down as props to avoid
// a client-side fetch on every render.
// ---------------------------------------------------------------------------

export type CategoryOption = { id: string; name: string };

export async function listLeafCategories(): Promise<CategoryOption[]> {
  const supabase = await getSupabaseServer();
  const { data } = await supabase
    .from('categories')
    .select('id, name')
    .order('sort_order', { ascending: true });
  return (data ?? []) as CategoryOption[];
}
