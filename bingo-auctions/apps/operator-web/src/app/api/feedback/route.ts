// POST /api/feedback — the public website's feedback channel (mig 0327).
//
// Unauthenticated on purpose. The reports worth the most come from people who
// could not finish signing up, and they have no session to present. Requiring
// one would filter out exactly the failures nobody else can tell us about.
//
// That makes this a public write endpoint, so it carries its own controls
// rather than leaning on RLS (the insert runs as service-role):
//
//   1. A honeypot field no human sees and every naive bot fills.
//   2. Hard length caps, mirrored by the CHECKs in 0317/0327.
//   3. Five submissions per hour per source, counted against a SALTED HASH of
//      the IP — enough to stop a flood, not enough to identify a visitor.
//
// A signed-in bidder gets author_id set from their session, so their reports
// join up with the ones they file in the app.

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getSupabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';

const MAX_PER_HOUR = 5;

const bodySchema = z.object({
  kind: z.enum(['bug', 'idea']),
  message: z.string().min(10).max(4000),
  contact_email: z.string().email().max(254).optional().or(z.literal('')),
  page: z.string().max(200).optional(),
  /** Honeypot. A real browser leaves it empty because it is hidden. */
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => '');
  if (!raw || raw.length > 16_384) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Please add a little more detail (at least 10 characters).' },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  // Honeypot: answer 200 rather than 400. A bot that learns which shape gets
  // rejected adapts; one that believes it succeeded moves on.
  if (body.website && body.website.trim() !== '') {
    return NextResponse.json({ ok: true });
  }

  const admin = getSupabaseAdmin();
  const ipHash = hashIp(req);

  if (ipHash) {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin
      .from('app_feedback')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', hourAgo);
    if ((count ?? 0) >= MAX_PER_HOUR) {
      return NextResponse.json(
        { ok: false, error: "That's a lot of reports in one hour — email support@bingoauctions.com and we'll pick it up there." },
        { status: 429 },
      );
    }
  }

  // Sign the row to the person when we can. A bidder filing from the site and
  // the same bidder filing from the app should read as one voice in triage.
  let authorId: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getUser();
    authorId = data?.user?.id ?? null;
  } catch {
    // No session — the ordinary case for this endpoint.
  }

  const { error } = await admin.from('app_feedback').insert({
    author_id: authorId,
    app: 'web',
    kind: body.kind,
    message: body.message.trim(),
    contact_email: body.contact_email?.trim() || null,
    screen: body.page ?? null,
    platform: 'web',
    ip_hash: ipHash,
  });

  if (error) {
    console.error('[api/feedback] insert failed', error.message);
    return NextResponse.json(
      { ok: false, error: "We couldn't save that. Please email support@bingoauctions.com." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * Salted hash of the caller's IP, or null when no salt is configured.
 *
 * Null disables the throttle rather than falling back to storing the raw
 * address — the salt is what makes the value non-reversible, and a rate limit
 * is not worth keeping visitor IPs in a table staff can read.
 */
function hashIp(req: NextRequest): string | null {
  const salt = process.env.FEEDBACK_IP_SALT;
  if (!salt) return null;
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip');
  if (!ip) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}
