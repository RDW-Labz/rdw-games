// /profile/pickup-pass — the bidder's Pickup Helper (mig 0241, Phases 1+2).
//
// One page for the whole warehouse visit:
//   • aisle-ordered walk list across EVERY invoice they can pick up
//     (serpentine order — never doubles back down an aisle)
//   • tap-to-collect progress with photos + bin codes (Phase 2)
//   • ONE session QR that staff scan at the counter to open every invoice
//     at once (Phase 1)
//
// Flag-gated on platform_settings.pickup_sessions_enabled: while off the
// page shows a friendly "not available yet" instead of the pass, so it can
// deploy dark and be tested via the toggle.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { getSupabaseServer } from '@/lib/supabase-server';
import {
  isPickupSessionsEnabled,
  getOrCreateOpenSession,
  loadSessionContents,
  listPickupWarehouses,
} from '@/lib/pickup-session';
import { PickupPassClient } from './PickupPassClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PickupPassPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouse?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/profile/pickup-pass');

  const enabled = await isPickupSessionsEnabled();
  if (!enabled) {
    return (
      <Shell>
        <h1 style={h1Style}>Pickup pass</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.6 }}>
          The pickup pass isn&apos;t available yet — for now, use the QR code on each
          invoice&apos;s pickup page. It&apos;s coming soon!
        </p>
        <Link href="/profile/invoices" style={{ color: 'var(--accent)', fontSize: 14 }}>
          ← My invoices
        </Link>
      </Shell>
    );
  }

  // 0293: one pass = one building. Harrison (AR) and Dodge City (KS) are ~400
  // miles apart, so a merged pass would give the customer a route interleaving
  // two warehouses behind one counter QR. Default to whichever building they owe
  // the most at; ?warehouse= switches. Only a warehouse they actually owe at is
  // honoured — the param never widens scope.
  const pickupWarehouses = await listPickupWarehouses(user.id);
  const activeWarehouseId =
    (sp.warehouse && pickupWarehouses.find((w) => w.id === sp.warehouse)?.id) ??
    pickupWarehouses[0]?.id ??
    null;

  let session: Awaited<ReturnType<typeof getOrCreateOpenSession>>;
  let contents: Awaited<ReturnType<typeof loadSessionContents>>;
  const loadOnce = () =>
    Promise.all([
      getOrCreateOpenSession(user.id, activeWarehouseId),
      loadSessionContents(user.id, activeWarehouseId),
    ]);
  try {
    try {
      [session, contents] = await loadOnce();
    } catch (firstErr) {
      // One transient DB hiccup shouldn't dead-end the bidder with the red
      // "try again in a minute" message (a customer hit it, 2026-07-13). Retry
      // once after a short backoff before giving up — most of these clear
      // immediately.
      console.warn(
        '[pickup-pass] first load attempt failed, retrying once:',
        firstErr instanceof Error ? firstErr.message : firstErr,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      [session, contents] = await loadOnce();
    }
  } catch (err) {
    // Capture the exact failure (build-13 recap 2026-07-11: staff saw a red
    // error they couldn't read). This lands in the Worker logs / Sentry with
    // the bidder id so the next occurrence is diagnosable, and the bidder
    // gets a clear retry message instead of a raw crash.
    console.error(
      '[pickup-pass] contents load failed for bidder',
      user.id,
      err instanceof Error ? err.message : err,
    );
    return (
      <Shell>
        <h1 style={h1Style}>Pickup pass</h1>
        <p style={{ color: 'var(--danger)', fontSize: 14, lineHeight: 1.6 }}>
          We couldn&apos;t load your pickup pass just now. Please try again in a
          minute — your won items are safe and still on your{' '}
          <Link href="/profile/invoices" style={{ color: 'var(--accent)' }}>
            invoices
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <h1 style={h1Style}>Pickup pass</h1>
        <p style={{ color: 'var(--danger)', fontSize: 14 }}>
          Couldn&apos;t start a pickup session — please try again in a minute.
        </p>
      </Shell>
    );
  }

  if (contents.invoices.length === 0) {
    return (
      <Shell>
        <h1 style={h1Style}>Pickup pass</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, lineHeight: 1.6 }}>
          Nothing to pick up right now. Win something and it&apos;ll show up here with a
          walking route and your checkout QR code.
        </p>
        <Link href="/browse" className="btn-primary" style={{ display: 'inline-block', padding: '0.7rem 1.4rem' }}>
          Browse live auctions
        </Link>
      </Shell>
    );
  }

  // Items staff already resolved don't belong on the walk: 'collected' and
  // 'missing' vanish; 'left_behind' stays for the return trip (mig 0243).
  const walkItems = contents.items.filter(
    (i) => i.outcome !== 'collected' && i.outcome !== 'missing',
  );

  // The QR is a plain URL: staff scan it with any camera and land on the
  // auth-gated counter page for this session.
  const sessionUrl = `https://bingoauctions.com/pickups/session/${session.token}`;
  const qrDataUrl = await QRCode.toDataURL(sessionUrl, { margin: 1, width: 360 });

  return (
    <Shell>
      {/* 0293: location switcher. Only rendered when the bidder genuinely owes
          at more than one building — a single-location customer sees nothing new. */}
      {pickupWarehouses.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: '1rem',
            padding: '0.7rem 0.9rem',
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Picking up at:</span>
          {pickupWarehouses.map((w) => {
            const active = w.id === activeWarehouseId;
            return (
              <Link
                key={w.id}
                href={`/profile/pickup-pass?warehouse=${encodeURIComponent(w.id)}`}
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  padding: '5px 11px',
                  borderRadius: 999,
                  textDecoration: 'none',
                  border: '1px solid var(--border)',
                  background: active ? 'var(--accent)' : 'var(--bg)',
                  color: active ? '#fff' : 'var(--fg)',
                }}
              >
                {w.name} ({w.lotCount})
              </Link>
            );
          })}
        </div>
      )}
      <PickupPassClient
        items={walkItems}
        invoices={contents.invoices}
        initialCollected={session.collectedLotIds}
        qrDataUrl={qrDataUrl}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '2rem 1rem 5rem', maxWidth: 640, margin: '0 auto' }}>{children}</div>
  );
}

const h1Style: React.CSSProperties = {
  fontSize: '1.6rem',
  fontWeight: 900,
  letterSpacing: -0.5,
  marginBottom: '1rem',
};
