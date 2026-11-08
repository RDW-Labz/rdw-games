// POST /api/admin-help/tools (#878). Flag off. Cookie admin only. No service role, no model.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import {
  hasStaffAppHeaders,
  isAdminHelpEnabled,
  runAdminHelpTool,
  SYNTHETIC_MODEL_PAYLOAD,
  type ScopedReadClient,
} from '@/lib/admin-help/read-tools';

export const runtime = 'nodejs';

const bodySchema = z.object({
  tool: z.enum(['subscriptions', 'balances']),
  range: z.enum(['today', 'range']).default('today'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function POST(request: NextRequest) {
  if (!isAdminHelpEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (hasStaffAppHeaders(request.headers))
    return NextResponse.json({ error: 'denied' }, { status: 403 });

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const staffResult = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  const staff = staffResult.data as { operator_id?: string; role?: string } | null;
  if (staffResult.error || !staff || staff.role !== 'admin' || !staff.operator_id) {
    return NextResponse.json({ error: 'denied' }, { status: 403 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const result = await runAdminHelpTool(
    { operatorId: staff.operator_id, client: supabase as unknown as ScopedReadClient },
    parsed.tool,
    { range: parsed.range, from: parsed.from, to: parsed.to },
  );
  if (!result.ok) {
    const status =
      result.error === 'denied'
        ? 403
        : result.error === 'retry_exhausted' || result.error === 'query_failed'
          ? 503
          : 400;
    return NextResponse.json(
      { ok: false, error: result.error, model_payload: SYNTHETIC_MODEL_PAYLOAD },
      { status },
    );
  }
  return NextResponse.json({
    ok: true,
    result: result.data,
    model_payload: SYNTHETIC_MODEL_PAYLOAD,
  });
}
