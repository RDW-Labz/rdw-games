// POST /api/invoices/[id]/manual-checkout
//
// CHK-03 — records a MANUAL pickup checkout override in operator_audit_log.
//
// Context: in the staff pickup-verify flow (apps/field-mobile/.../checkout/
// pickup-verify.tsx) a lot's per-lot checkbox can normally ONLY be flipped by a
// successful bin scan (W6-P1 removed the silent manual bypass that let staff
// mark a lot picked up without physically verifying it). For the case where a
// bin/lot QR is genuinely unreadable, the screen offers a "Manual checkout (QR
// unreadable)" affordance, gated on (a) the staffer acknowledging they
// physically verified the item and (b) a reason code. The actual pickup flip is
// still performed by the staff_confirm_pickup RPC (lot_code-based; no bin scan
// required) — this route exists solely to WRITE THE AUDIT ROW.
//
// Why a server route: operator_audit_log has no client INSERT policy (mig 0157
// — service_role + SECURITY DEFINER writers only). The mobile client runs under
// an authenticated (anon-key) session and cannot insert directly, so it POSTs
// here with a Bearer token and we write the row with the service-role admin
// client after enforcing auth + operator scope. This mirrors the audit-insert
// pattern in /api/invoices/[id]/refund-items.
//
// Gating (in order):
//   1. session user signed in (cookie OR Bearer — same dual-auth as
//      refund-items, so field-mobile and operator-web both work)
//   2. caller is operator staff for the invoice's operator (any role — pickup
//      is a picker-level action; manual checkout is available to any checkout
//      staff but ALWAYS audited)
//   3. invoice exists and belongs to the caller's operator
//   4. lot_id is on this invoice's invoice_lots
//
// On accept: one operator_audit_log INSERT (action_type
// 'pickup.manual_checkout'), then 200 { ok: true }.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const bodySchema = z.object({
  lot_id: z.string().uuid(),
  reason: z.enum(['damaged_qr', 'missing_label', 'not_staged', 'scanner_failure']),
});

// Resolve the request-scoped Supabase client for BOTH auth surfaces (identical
// to refund-items): Bearer token → fresh anon client carrying the token; no
// header → cookie-session client.
async function resolveAuthClient(req: NextRequest): Promise<SupabaseClient> {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  if (bearerToken) {
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
    const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
    if (!url || !anon) throw new Error('Missing Supabase env vars');
    return createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });
  }
  return getSupabaseServer();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await resolveAuthClient(req);

  // ── auth ────────────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  const { data: staffRow } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  const staff = staffRow as { operator_id: string; role: string } | null;
  if (!staff) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // ── body parse ──────────────────────────────────────────────────────
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message }, { status: 400 });
  }

  // ── invoice scope ───────────────────────────────────────────────────
  const { data: invoiceRow, error: invErr } = await supabase
    .from('invoices')
    .select('id, operator_id, status')
    .eq('id', id)
    .maybeSingle();
  const invoice = invoiceRow as
    | { id: string; operator_id: string; status: string }
    | null;
  if (invErr || !invoice) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (invoice.operator_id !== staff.operator_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── lot must be on this invoice ─────────────────────────────────────
  const { data: invoiceLotRow } = await supabase
    .from('invoice_lots')
    .select('lot_id')
    .eq('invoice_id', id)
    .eq('lot_id', body.data.lot_id)
    .maybeSingle();
  if (!invoiceLotRow) {
    return NextResponse.json(
      { error: 'lot_not_in_invoice', lot_id: body.data.lot_id },
      { status: 400 },
    );
  }

  // ── audit log ───────────────────────────────────────────────────────
  // operator_audit_log has no client INSERT policy — write via service-role
  // admin client after the auth + scope checks above (mirrors refund-items).
  const admin = getSupabaseAdmin();
  const auditRow: Record<string, unknown> = {
    operator_id: invoice.operator_id,
    actor_user_id: user.id,
    action_type: 'pickup.manual_checkout',
    target_id: invoice.id,
    before_state: null,
    after_state: {
      lot_id: body.data.lot_id,
      reason: body.data.reason,
      invoice_status: invoice.status,
    },
    reason_note: `Manual pickup checkout (QR unreadable): ${body.data.reason}. By ${user.email ?? user.id}.`,
  };
  const { error: auditErr } = await admin
    .from('operator_audit_log')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert(auditRow as any);
  if (auditErr) {
    // Unlike the refund route (which logs-and-continues), the audit row IS the
    // deliverable here — if it fails we must tell the client so the lot is NOT
    // checked off un-audited.
    console.error('[manual-checkout] audit_log insert failed:', auditErr.message);
    return NextResponse.json({ error: 'audit_write_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
