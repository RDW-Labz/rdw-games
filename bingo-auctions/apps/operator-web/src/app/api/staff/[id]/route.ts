// Update or remove a staff member. Admin-only.
//
// LAUNCH_PLAN §3.1c — sensitive mutations on staff data also require
// AAL2 when the calling admin has a verified TOTP factor. The middleware
// can't enforce this on /api/* (the matcher excludes API routes), so we
// re-check inside the handler using requireAAL2ForAdmin().

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { requireAAL2ForAdmin } from '@/lib/require-aal2';

export const runtime = 'nodejs';

const patchSchema = z.object({
  role: z.enum(['admin', 'manager', 'picker', 'lead']),
});

async function ensureAdmin(): Promise<
  | { ok: true; operatorId: string; userId: string }
  | { ok: false; status: number; error: string }
> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: 'not_authenticated' };
  const { data: caller } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!caller) return { ok: false, status: 403, error: 'not_operator_staff' };
  if (caller.role !== 'admin') return { ok: false, status: 403, error: 'admin_only' };
  return { ok: true, operatorId: caller.operator_id as string, userId: user.id };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await ensureAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // AAL2 gate — re-check the same condition the middleware enforces for
  // sensitive page navigations. See lib/require-aal2.ts for the rules.
  const supabase = await getSupabaseServer();
  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  const { id } = await ctx.params;
  const body = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? 'invalid' },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from('operator_users')
    .update({ role: body.data.role })
    .eq('id', id)
    .eq('operator_id', auth.operatorId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await ensureAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // AAL2 gate — deleting staff is one of the highest-impact admin
  // actions; we definitely want a TOTP step-up here.
  const supabase = await getSupabaseServer();
  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  const { id } = await ctx.params;

  // Prevent the admin from deleting themselves and locking the operator out.
  const { data: target } = await supabase
    .from('operator_users')
    .select('user_id, role')
    .eq('id', id)
    .single();
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (target.user_id === auth.userId) {
    return NextResponse.json({ error: 'cannot_remove_self' }, { status: 409 });
  }

  const { error } = await supabase
    .from('operator_users')
    .delete()
    .eq('id', id)
    .eq('operator_id', auth.operatorId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
