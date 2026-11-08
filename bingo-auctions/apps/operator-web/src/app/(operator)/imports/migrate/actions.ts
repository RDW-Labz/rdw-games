'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

// Row shape for a legacy-migration import. lot_code is REQUIRED here
// (it's what p_use_provided_lot_code=true preserves verbatim).
const migrateRowSchema = z.object({
  lot_code: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  brand: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  category_raw: z.string().max(200).nullable().optional(),
  mpn: z.string().max(120).nullable().optional(),
  photo_urls: z.array(z.string().url()).nullable().optional(),
  load_number: z.string().max(120).nullable().optional(),
  legacy_platform: z.string().max(100).nullable().optional(),
});

export type MigrateRow = z.infer<typeof migrateRowSchema>;

const migrateInputSchema = z.object({
  sourceLabel: z.string().min(1).max(100),
  filename: z.string().min(1).max(200),
  columnMapping: z.record(z.string(), z.array(z.string())),
  rows: z.array(migrateRowSchema).min(1).max(35_000),
  warehouseId: z.string().uuid().optional(),
});

export type MigrateInput = z.infer<typeof migrateInputSchema>;

export type MigrateResult =
  | { ok: true; batchId: string; inserted: number; skipped: number }
  | { ok: false; error: string };

// RPC returns a set of rows; we expect exactly one.
type RpcRow = {
  batch_id: string | null;
  ok: boolean;
  reason: string | null;
  inserted_count: number;
  skipped_count: number;
};

const RPC_ERROR_MESSAGES: Record<string, string> = {
  unknown_operator: 'Operator not found — contact support.',
  not_authenticated: 'Your session expired — please sign in again.',
  not_operator_staff: 'You are not a member of this operator account.',
  rows_must_be_array: 'Internal error: row data was not formatted as an array.',
};

export async function commitMigrationImport(
  input: MigrateInput,
): Promise<MigrateResult> {
  const parsed = migrateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input',
    };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  // Migration is destructive (preserves external codes verbatim) — restrict
  // to admin and manager roles only.
  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false, error: 'Only admins or managers can run legacy migrations.' };
  }

  const { sourceLabel, filename, columnMapping, rows, warehouseId } = parsed.data;

  // Build the JSONB row array that bulk_import_lots expects.
  // Each row gets legacy_lot_code copied from lot_code so the duplicate-
  // by-legacy-code check inside the RPC fires correctly (it reads
  // v_row->>'legacy_lot_code').
  const rpcRows = rows.map((r) => ({
    lot_code: r.lot_code,
    legacy_lot_code: r.lot_code,
    title: r.title,
    description: r.description ?? null,
    brand: r.brand ?? null,
    model: r.model ?? null,
    category: r.category_raw ?? null,
    mpn: r.mpn ?? null,
    photo_urls: r.photo_urls ?? [],
    load_number: r.load_number ?? null,
    legacy_platform: r.legacy_platform ?? sourceLabel,
  }));

  const { data, error } = await supabase.rpc('bulk_import_lots', {
    p_batch_source: sourceLabel,
    p_filename: filename,
    p_column_mapping: columnMapping,
    p_rows: rpcRows,
    p_preserve_legacy: true,
    p_warehouse_id: warehouseId ?? null,
    p_initial_status: 'pending_intake',
    p_use_provided_lot_code: true,
    p_operator_id_override: null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  // The RPC returns a result set — grab the first (and only) row.
  const rows_result = data as RpcRow[] | null;
  const result = rows_result?.[0];
  if (!result) {
    return { ok: false, error: 'RPC returned no result' };
  }

  if (!result.ok) {
    const reason = result.reason ?? 'unknown_error';
    const msg = RPC_ERROR_MESSAGES[reason] ?? `Import failed: ${reason}`;
    return { ok: false, error: msg };
  }

  revalidatePath('/imports');

  return {
    ok: true,
    batchId: result.batch_id!,
    inserted: result.inserted_count,
    skipped: result.skipped_count,
  };
}
