'use server';

// publishFloorPlan — S10 floor-plan publisher server action.
//
// Flow:
//   1. Auth: verify caller is operator staff (admin/manager) who owns the warehouse.
//   2. RPC: call publish_warehouse_floor_plan(warehouseId) — writes bin x_px/y_px,
//      returns { width_px, height_px, bin_count, bin_w, bin_h, margin }.
//   3. Re-read bins (id, code, x_px, y_px) from Supabase.
//   4. Build an idealized-grid SVG string in TypeScript.
//   5. Upload SVG to Supabase Storage bucket "floor-plans" at path:
//      <operator_id>/<warehouse_id>/<next_version>.svg
//      Uses the service-role (admin) client — same bucket the bidder app reads
//      via public URL. Bucket "floor-plans" must be created once in the Supabase
//      dashboard as a PUBLIC bucket (see report note).
//   6. UPDATE warehouses SET floor_plan_url (the 0094 trigger auto-bumps
//      floor_plan_version + floor_plan_uploaded_at when floor_plan_url changes),
//      floor_plan_width_px, floor_plan_height_px.
//   7. Revalidate page cache and return { ok, url }.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const FLOOR_PLANS_BUCKET = 'floor-plans';

export type PublishFloorPlanResult =
  | { ok: true; url: string; binCount: number }
  | { ok: false; error: string };

export async function publishFloorPlan(
  warehouseId: string,
): Promise<PublishFloorPlanResult> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'Not authorized' };

  const meTyped = me as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(meTyped.role)) {
    return { ok: false, error: 'Insufficient permissions' };
  }

  // Verify warehouse ownership (RLS-level check already performed by the RPC,
  // but we need operator_id for the Storage path before calling the RPC).
  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, operator_id, floor_plan_version')
    .eq('id', warehouseId)
    .single();
  if (!wh || (wh as { operator_id: string }).operator_id !== meTyped.operator_id) {
    return { ok: false, error: 'Warehouse not found' };
  }

  const whTyped = wh as {
    id: string;
    operator_id: string;
    floor_plan_version: number | null;
  };

  // ── 2. RPC — writes x_px/y_px on bins, returns canvas dims ───────────────
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'publish_warehouse_floor_plan',
    { p_warehouse_id: warehouseId },
  );

  if (rpcError) {
    return { ok: false, error: rpcError.message };
  }

  const dims = rpcData as {
    width_px: number;
    height_px: number;
    bin_count: number;
    bin_w: number;
    bin_h: number;
    margin: number;
  };

  // ── 3. Re-read bins after coordinate write ────────────────────────────────
  const { data: bins, error: binsError } = await supabase
    .from('bins')
    .select('id, code, x_px, y_px')
    .eq('warehouse_id', warehouseId)
    .is('retired_at', null)
    .order('code');

  if (binsError) {
    return { ok: false, error: binsError.message };
  }

  // ── 4. Build SVG string ───────────────────────────────────────────────────
  const { width_px, height_px, bin_w, bin_h } = dims;
  const svgString = buildFloorPlanSvg({
    widthPx: width_px,
    heightPx: height_px,
    binW: bin_w,
    binH: bin_h,
    bins: (bins ?? []).map((b) => {
      const bin = b as { id: string; code: string; x_px: number; y_px: number };
      return { id: bin.id, code: bin.code, xPx: bin.x_px, yPx: bin.y_px };
    }),
  });

  // ── 5. Upload SVG to Storage ──────────────────────────────────────────────
  // Next version = current + 1. The trigger bumps the DB column after the URL
  // UPDATE, so we use the +1 value only for the filename to avoid collisions on
  // repeated publishes (older files remain but are not referenced).
  const nextVersion = (whTyped.floor_plan_version ?? 0) + 1;
  const storagePath = `${whTyped.operator_id}/${warehouseId}/${nextVersion}.svg`;

  const admin = getSupabaseAdmin();

  const { error: uploadError } = await admin.storage
    .from(FLOOR_PLANS_BUCKET)
    .upload(storagePath, Buffer.from(svgString, 'utf-8'), {
      contentType: 'image/svg+xml',
      upsert: true,
    });

  if (uploadError) {
    return { ok: false, error: `Storage upload failed: ${uploadError.message}` };
  }

  const { data: publicUrlData } = admin.storage
    .from(FLOOR_PLANS_BUCKET)
    .getPublicUrl(storagePath);

  const publicUrl = publicUrlData.publicUrl;

  // ── 6. UPDATE warehouses ──────────────────────────────────────────────────
  // Setting floor_plan_url triggers the 0094 bump_warehouse_floor_plan_version
  // trigger, which auto-increments floor_plan_version + sets floor_plan_uploaded_at.
  // We also set floor_plan_width_px and floor_plan_height_px here.
  const { error: updateError } = await admin
    .from('warehouses')
    .update({
      floor_plan_url: publicUrl,
      floor_plan_width_px: width_px,
      floor_plan_height_px: height_px,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', warehouseId)
    .eq('operator_id', whTyped.operator_id); // defense-in-depth cross-tenant guard

  if (updateError) {
    return { ok: false, error: `Warehouse update failed: ${updateError.message}` };
  }

  // ── 7. Revalidate + return ────────────────────────────────────────────────
  revalidatePath(`/warehouses/${warehouseId}/walk`);
  revalidatePath(`/warehouses/${warehouseId}`);
  revalidatePath('/dashboard');

  return { ok: true, url: publicUrl, binCount: dims.bin_count };
}

// ── SVG builder ───────────────────────────────────────────────────────────────
// Produces a plain SVG with:
//   • White background rect
//   • A rect per bin (pale blue fill, dark blue border) at (x_px, y_px)
//   • Bin code label centered in the rect
// No external fonts — uses system monospace for reliable server-side rendering.

interface BinCoord {
  id: string;
  code: string;
  xPx: number;
  yPx: number;
}

interface SvgOptions {
  widthPx: number;
  heightPx: number;
  binW: number;
  binH: number;
  bins: BinCoord[];
}

function buildFloorPlanSvg(opts: SvgOptions): string {
  const { widthPx, heightPx, binW, binH, bins } = opts;

  const binRects = bins
    .map(
      (b) =>
        `  <g data-bin-id="${escapeXml(b.id)}">
    <rect x="${b.xPx}" y="${b.yPx}" width="${binW}" height="${binH}"
          fill="#dbeafe" stroke="#1d4ed8" stroke-width="1" rx="3" />
    <text x="${b.xPx + binW / 2}" y="${b.yPx + binH / 2 + 4}"
          text-anchor="middle"
          font-family="monospace" font-size="11" fill="#1e3a8a">${escapeXml(b.code)}</text>
  </g>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${widthPx}" height="${heightPx}"
     viewBox="0 0 ${widthPx} ${heightPx}">
  <rect width="${widthPx}" height="${heightPx}" fill="#f9fafb" />
${binRects}
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
