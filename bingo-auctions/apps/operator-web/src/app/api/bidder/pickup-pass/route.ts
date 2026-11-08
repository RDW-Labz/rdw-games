// POST /api/bidder/pickup-pass — Pickup Helper walk progress (mig 0241).
// Body: { action: 'collect' | 'uncollect', lot_id }
// Toggles the lot in the caller's OPEN session's collected_lot_ids. The
// session is per-visit scratch state; nothing downstream depends on it
// (staff verification at the counter is authoritative).

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  isPickupSessionsEnabled,
  getOrCreateOpenSession,
  loadSessionContents,
  listPickupWarehouses,
} from '@/lib/pickup-session';

export const runtime = 'nodejs';

/**
 * GET /api/bidder/pickup-pass — the whole pass, for the native app.
 *
 * The pickup pass shipped web-only (/profile/pickup-pass, mig 0241): the React
 * Native app's pickup tab listed invoices one-by-one with no combined walk list
 * and no session QR, so app users had no way to reach the feature at all
 * (field report 2026-07-27 — "doesn't even give an option like the browser").
 *
 * This exposes the SAME server helpers the web page uses rather than
 * re-implementing the session query in the app. The membership rules, the owed-lot
 * filters and the serpentine ordering are subtle and have been fixed repeatedly
 * (see pickup-session.ts) — a second copy would drift and re-break them.
 *
 * Read-only. The collect/uncollect POST below is unchanged.
 */
export async function GET(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 });

  if (!(await isPickupSessionsEnabled())) {
    // Not an error — the app renders a "coming soon" state, mirroring the web
    // page's flag-off branch, so this can be toggled without an app release.
    return NextResponse.json({ ok: true, enabled: false });
  }

  // 0293: one pass = one building. Harrison (AR) and Dodge City (KS) are ~400
  // miles apart, so a merged pass would hand the customer a walk route that
  // interleaves two warehouses behind a single counter QR.
  //
  // ?warehouse=<id> picks the building. With none supplied we default to the one
  // the bidder has the MOST owed lots at (listPickupWarehouses sorts by count)
  // rather than showing everything — a wrong-but-labelled single building beats
  // a silently merged one, and the client renders a switcher when there is more
  // than one.
  const requested = req.nextUrl.searchParams.get('warehouse');
  let warehouses: Awaited<ReturnType<typeof listPickupWarehouses>> = [];
  let session: Awaited<ReturnType<typeof getOrCreateOpenSession>>;
  let contents: Awaited<ReturnType<typeof loadSessionContents>>;
  try {
    warehouses = await listPickupWarehouses(caller.userId);
    // Only honour a warehouse the bidder actually has items at — never trust the
    // query param to scope someone else's pass.
    const chosen =
      (requested && warehouses.find((w) => w.id === requested)?.id) ?? warehouses[0]?.id ?? null;

    [session, contents] = await Promise.all([
      getOrCreateOpenSession(caller.userId, chosen),
      loadSessionContents(caller.userId, chosen),
    ]);
  } catch (err) {
    // Same posture as the web page: never render a false "nothing to pick up".
    console.error(
      '[pickup-pass][GET] contents load failed for bidder',
      caller.userId,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ ok: false, error: 'contents_load_failed' }, { status: 503 });
  }

  if (!session) {
    return NextResponse.json({ ok: false, error: 'session_unavailable' }, { status: 503 });
  }

  // Items staff already resolved don't belong on the walk: 'collected' and
  // 'missing' vanish; 'left_behind' stays for the return trip (mig 0243).
  // Identical filter to the web page.
  const walkItems = contents.items.filter(
    (i) => i.outcome !== 'collected' && i.outcome !== 'missing',
  );

  return NextResponse.json({
    ok: true,
    enabled: true,
    // The app renders this string as a QR with react-native-qrcode-svg. Built
    // here so the URL shape stays owned by the server — staff scan it with any
    // camera and land on the auth-gated counter page.
    sessionUrl: `https://bingoauctions.com/pickups/session/${session.token}`,
    collectedLotIds: session.collectedLotIds,
    items: walkItems,
    invoices: contents.invoices,
    // Every building the bidder owes at, so the client can offer a switcher.
    warehouses,
    activeWarehouseId:
      (requested && warehouses.find((w) => w.id === requested)?.id) ?? warehouses[0]?.id ?? null,
  });
}

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 });

  if (!(await isPickupSessionsEnabled())) {
    return NextResponse.json({ ok: false, error: 'feature_disabled' }, { status: 403 });
  }

  let body: { action?: string; lot_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const lotId = body.lot_id;
  const action = body.action;
  if (
    typeof lotId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(lotId) ||
    (action !== 'collect' && action !== 'uncollect')
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  }

  const admin0 = getSupabaseAdmin();

  // 0293: the GET now hands back a WAREHOUSE-SCOPED session, so this must target
  // the same one or a tick would write progress into a different session than the
  // pass is reading. Resolve the building from the LOT rather than taking it from
  // the client — the lot knows where it is, and a client-supplied warehouse would
  // let a caller point progress at an arbitrary session.
  const { data: lotRow } = await admin0
    .from('lots')
    .select('warehouse_id')
    .eq('id', lotId)
    .maybeSingle();
  const lotWarehouseId = (lotRow as { warehouse_id: string | null } | null)?.warehouse_id ?? null;

  const session = await getOrCreateOpenSession(caller.userId, lotWarehouseId);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'session_unavailable' }, { status: 500 });
  }

  const next = new Set(session.collectedLotIds);
  if (action === 'collect') next.add(lotId);
  else next.delete(lotId);

  const { error } = await admin0
    .from('pickup_sessions')
    .update({ collected_lot_ids: Array.from(next) })
    .eq('id', session.id)
    .eq('status', 'open');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, collected: Array.from(next) });
}
