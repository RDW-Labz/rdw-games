// POST /api/telemetry/crash — Layer-1 crash telemetry sink for the mobile apps.
//
// Both apps' global JS error handlers (lib/crash-reporter.ts) fire-and-forget
// here when a fatal error is caught. Deliberately unauthenticated: crashes
// frequently happen in logged-out / broken-auth states, and a crash reporter
// that needs a session misses exactly the incidents we care about. Abuse is
// bounded by hard size caps + a 16KB body limit; the table is watched by the
// health-check cron (spike alert) rather than trusted row-by-row.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const bodySchema = z.object({
  app: z.enum(['bidder', 'staff']),
  platform: z.enum(['ios', 'android', 'web']),
  app_version: z.string().max(32).optional(),
  ota_update: z.string().max(64).optional(),
  message: z.string().min(1).max(500),
  stack: z.string().max(8000).optional(),
  screen: z.string().max(200).optional(),
  is_fatal: z.boolean().optional(),
  // 0375: the same id on every resend of one queued report. Optional: builds
  // that predate it send none and are stored exactly as before.
  report_id: z.string().uuid().optional(),
  device_model: z.string().max(100).nullable().optional(),
  os_version: z.string().max(100).nullable().optional(),
  free_storage_bytes: z.number().int().nonnegative().nullable().optional(),
  total_memory_bytes: z.number().int().nonnegative().nullable().optional(),
  js_heap_bytes: z.number().int().nonnegative().nullable().optional(),
});

const DEVICE_COLUMN_KEYS = [
  'device_model',
  'os_version',
  'free_storage_bytes',
  'total_memory_bytes',
  'js_heap_bytes',
] as const;

type CrashInsertRow = Record<string, string | number | boolean | null>;

function rowWithoutDeviceColumns(row: CrashInsertRow): CrashInsertRow {
  const out = { ...row };
  for (const key of DEVICE_COLUMN_KEYS) delete out[key];
  return out;
}

function buildInsertRow(data: z.infer<typeof bodySchema>): CrashInsertRow {
  const row: CrashInsertRow = {
    app: data.app,
    platform: data.platform,
    app_version: stripNul(data.app_version) ?? null,
    ota_update: stripNul(data.ota_update) ?? null,
    message: stripNul(data.message),
    stack: stripNul(data.stack) ?? null,
    screen: stripNul(data.screen) ?? null,
    is_fatal: data.is_fatal ?? true,
  };
  if (data.device_model != null) row.device_model = stripNul(data.device_model) ?? null;
  if (data.os_version != null) row.os_version = stripNul(data.os_version) ?? null;
  if (data.free_storage_bytes != null) row.free_storage_bytes = data.free_storage_bytes;
  if (data.total_memory_bytes != null) row.total_memory_bytes = data.total_memory_bytes;
  if (data.js_heap_bytes != null) row.js_heap_bytes = data.js_heap_bytes;
  return row;
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => '');
  if (raw.length === 0 || raw.length > 16_384) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const body = bodySchema.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const row = buildInsertRow(body.data);
  const reportId = body.data.report_id;
  let { error } = reportId
    ? await admin
        .from('client_crash_reports')
        .upsert({ ...row, report_id: reportId }, { onConflict: 'report_id', ignoreDuplicates: true })
    : await admin.from('client_crash_reports').insert(row);
  if (error?.code === '42703') {
    const fallback = rowWithoutDeviceColumns(row);
    const retry = reportId
      ? await admin
          .from('client_crash_reports')
          .upsert({ ...fallback, report_id: reportId }, { onConflict: 'report_id', ignoreDuplicates: true })
      : await admin.from('client_crash_reports').insert(fallback);
    error = retry.error;
  }
  if (!error) return new NextResponse(null, { status: 204 });

  // The reply decides whether the app keeps the report. Both apps delete a
  // queued report only on a 2xx (bidder telemetry-outbox, staff #373), so a 204
  // here used to delete reports that were never stored.
  //   - SQLSTATE class 22 (bad data) / 23 (constraint): this body can never be
  //     stored, and a retry would repeat for the outbox's 7 days. 202, dropped.
  //   - anything else (network, timeout, DB down): 503, the app keeps it and
  //     sends it again later.
  if (/^2[23]/.test(error.code ?? '')) {
    console.error('[telemetry/crash] report rejected by the database, dropped', error.code, error.message);
    return NextResponse.json({ stored: false }, { status: 202 });
  }
  console.error('[telemetry/crash] insert failed, client will retry', error.code, error.message);
  return NextResponse.json({ error: 'unavailable' }, { status: 503 });
}

// Postgres text cannot hold U+0000; a stack or message carrying one fails the
// insert (22P05) on every retry. Strip it so the report is stored instead.
function stripNul<T extends string | undefined>(s: T): T {
  return (s === undefined ? s : s.replace(/\u0000/g, '')) as T;
}
