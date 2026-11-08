// /profile/pickup/[id] — bidder pickup detail (browser parity with the
// mobile-app pickup screen).
//
// Why this exists:
//   User report 2026-06-01: browser bidders had no pickup surface; the mobile
//   app's /pickup/[id] (apps/bidder-app/app/pickup/[id].tsx) renders a QR
//   check-in code + warehouse address + window + map. This page is the
//   browser-side equivalent — same data, web-native rendering. We deliberately
//   skip the floor-plan map (mobile-only Skia/SVG component) and the
//   self-serve "Confirm pickup" flow (that requires Realtime + bin_assignments
//   wiring). Browser parity v1: address + QR + directions + receipt link.
//
// QR encoding: `bidwizops://pickup/<bidder_check_in_token>` — BYTE-IDENTICAL to
//   the mobile app (apps/bidder-app/app/pickup/[id].tsx). The staff scanner
//   (apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx) extracts the
//   UUID via /pickup[:/]+(<uuid>)/ and resolves it against
//   pickups.bidder_check_in_token. (Until 2026-06-15 this encoded invoice.id,
//   which the scanner could NOT resolve — that lookup is by check-in token, not
//   invoice id — so every browser QR failed with "Token not found". That was
//   the June-14 tester report.) Encoded server-side as a PNG data URL via the
//   `qrcode` package — same pattern operator-web/auctions/[id] uses for its
//   preview QR. Rendered as <img src="data:..."> to dodge next/image's
//   data-URL configuration nag.
//
// Auth: middleware gates /profile*; defensive re-check on server. RLS auto-
// restricts via invoices_self_read; we also filter bidder_id = user.id.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import QRCode from 'qrcode';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isPickupSessionsEnabled } from '@/lib/pickup-session';
import { lotDisplayCode, type LotCodeFields } from '@auction-platform/shared';
import { formatInTimeZone } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PickupDetail {
  id: string;
  status: string;
  fulfillment_method: string | null;
  paid_at: string | null;
  auction_id: string;
  operator_id: string;
  auctions: {
    title: string | null;
    pickup_starts_at: string | null;
    pickup_ends_at: string | null;
    warehouses: {
      name: string | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      timezone: string | null;
    } | null;
  } | null;
  operators: {
    business_name: string | null;
    contact_email: string | null;
  } | null;
  invoice_lots: Array<{
    lot_id: string;
    lots: {
      title: string | null;
      lot_code: string | null;
      sticker_code: string | null;
      intake_bin: { code: string | null } | null;
      relisted_from: LotCodeFields | null;
    } | null;
  }> | null;
}

interface OperatorPolicyRow {
  refund_window_post_pickup_hours: number;
  no_show_policy: string;
  restock_fee_cents: number;
}

// Pickup window timestamps render via the shared, runtime-hardened
// formatInTimeZone (lib/datetime.ts). The previous inline dateStyle/timeStyle
// formatter fell back to a raw ISO string on the Cloudflare Worker runtime
// (the CLOVRBID-WEB-8 "Invalid option" class), which is what surfaced the
// "2026-06-16T21:40:00+00:00" pickup-window display in testing.

function formatPolicyCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)}`;
}

export default async function ProfilePickupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/profile/pickup/${id}`);
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect(`/bidder/onboarding?next=/profile/pickup/${id}`);
  }

  const { data: invoiceRaw } = await supabase
    .from('invoices')
    .select(
      `id, status, fulfillment_method, paid_at, auction_id, operator_id,
       auctions(title, pickup_starts_at, pickup_ends_at,
         warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
       operators:operators_public(business_name, contact_email),
       invoice_lots(lot_id, lots(title, lot_code, sticker_code, display_code, intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code),
         relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code,
           relisted_from:lots!relisted_from_lot_id(lot_code, sticker_code, display_code))))`,
    )
    .eq('id', id)
    .eq('bidder_id', user.id)
    .maybeSingle();

  const invoice = invoiceRaw as unknown as PickupDetail | null;

  if (!invoice) {
    return <PickupNotFound />;
  }

  // Mig 0241 rollout flag for the Pickup-pass banner below.
  const pickupPassOn = await isPickupSessionsEnabled();

  // Operator policy — optional; renders a small refund-policy note when
  // available. Latest published version per the same pattern as the mobile
  // app's pickup screen. Anon read enabled via mig 0088 RLS.
  const { data: policyRow } = await supabase
    .from('operator_policies')
    .select('refund_window_post_pickup_hours, no_show_policy, restock_fee_cents')
    .eq('operator_id', invoice.operator_id)
    .eq('published', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const policy = (policyRow as OperatorPolicyRow | null) ?? null;

  const operatorName = invoice.operators?.business_name ?? '—';
  const operatorEmail = invoice.operators?.contact_email ?? null;
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const wh = invoice.auctions?.warehouses ?? null;
  const pickupStart = invoice.auctions?.pickup_starts_at ?? null;
  const pickupEnd = invoice.auctions?.pickup_ends_at ?? null;
  const pickupTz = wh?.timezone ?? 'America/New_York';

  // Pickup row — the QR payload is pickups.bidder_check_in_token, NOT the
  // invoice id. The bidder reads their own row via the pickups_self_read RLS
  // policy (invoice.bidder_id = auth.uid()). May be absent on legacy invoices
  // that never got a pickups row (pre-webhook offline mark-paid) → no QR.
  const { data: pickupRow } = await supabase
    .from('pickups')
    .select('bidder_check_in_token, status')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  const checkInToken =
    (pickupRow as { bidder_check_in_token?: string | null } | null)?.bidder_check_in_token ?? null;
  const pickupStatus = (pickupRow as { status?: string | null } | null)?.status ?? null;
  // Mirror the mobile gate ({checkInToken && !isCompleted && !isNoShow}): a
  // completed / no_show / forfeited pickup has nothing left to hand over.
  const qrActive =
    !!checkInToken &&
    pickupStatus !== 'completed' &&
    pickupStatus !== 'no_show' &&
    pickupStatus !== 'forfeited';

  // Render the QR server-side. Same approach as
  // (operator)/auctions/[id]/page.tsx — PNG data URL, errorCorrectionLevel
  // 'M', margin 1. 240px display, requested 480px raster so it stays crisp on
  // retina screens. Payload byte-identical to the mobile app so the staff
  // scanner's extractToken() matches: `bidwizops://pickup/<token>`.
  const qrDataUrl = qrActive
    ? await QRCode.toDataURL(`bidwizops://pickup/${checkInToken}`, {
        width: 480,
        margin: 1,
        errorCorrectionLevel: 'M',
      })
    : null;

  const addressParts = [
    wh?.address_line1,
    wh?.address_line2,
    wh?.city,
    wh?.state,
    wh?.postal_code,
  ].filter(Boolean) as string[];
  const fullAddress = addressParts.join(', ');
  const directionsHref = fullAddress
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress)}`
    : null;

  // Per-item shelf locations: lots.intake_bin_id -> bins.code (set at put-away).
  // Browser parity with the mobile pickup screen so winning bidders can see
  // WHERE each won item physically sits. 'Location pending' when not yet put away.
  const items = (invoice.invoice_lots ?? []).map((il) => ({
    lotId: il.lot_id,
    title: il.lots?.title ?? 'Lot',
    displayCode:
      lotDisplayCode({
        lot_code: il.lots?.lot_code ?? null,
        sticker_code: il.lots?.sticker_code ?? null,
        // A relist child wears no sticker of its own — the box still shows the
        // lineage label, so pass the chain through rather than the BIN-######.
        relisted_from: il.lots?.relisted_from ?? null,
      }) ??
      il.lots?.lot_code ??
      null,
    binCode: il.lots?.intake_bin?.code ?? null,
  }));

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 760, margin: '0 auto' }}>
      <Link
        href="/profile/pickup"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to pickups
      </Link>

      {/* Mig 0241: when pickup sessions are on, point the bidder at the
          one-QR Pickup pass instead of juggling per-invoice codes. */}
      {pickupPassOn && (
        <Link
          href="/profile/pickup-pass"
          style={{
            display: 'block',
            padding: '0.75rem 1rem',
            border: '1px solid var(--accent)',
            background: 'var(--accent-dim)',
            borderRadius: 8,
            color: 'var(--accent)',
            fontSize: 13,
            fontWeight: 700,
            textDecoration: 'none',
            marginBottom: '1.5rem',
          }}
        >
          New: one Pickup pass for ALL your invoices — aisle-by-aisle walk list + a single checkout
          QR →
        </Link>
      )}

      <header style={{ marginBottom: '2rem' }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: 2,
            marginBottom: 4,
          }}
        >
          Pickup
        </div>
        <h1
          style={{
            fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
            fontWeight: 900,
            letterSpacing: -1,
            margin: 0,
          }}
        >
          {wh?.name ?? auctionTitle}
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          {operatorName}
          {wh?.city ? ` · ${wh.city}${wh.state ? `, ${wh.state}` : ''}` : ''}
        </div>
      </header>

      {/* QR — hero. Bidder shows `bidwizops://pickup/<token>` at the counter;
         staff scan it to resolve the pickup (pickups.bidder_check_in_token) and
         pull up the bidder + invoice. White background so camera scanners read
         it cleanly on dark OLED phones — the page sits on var(--bg-elev-2) for
         contrast. When there's no active token (no pickup row yet, or already
         completed / no-show) we show a status line instead of a broken image. */}
      <section
        style={{
          marginBottom: '2rem',
          padding: '1.5rem 1.5rem 1.25rem',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          textAlign: 'center',
        }}
      >
        {qrDataUrl ? (
          <>
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-dim)',
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                marginBottom: 14,
              }}
            >
              Show this to staff at the counter
            </div>
            <div
              style={{
                display: 'inline-block',
                padding: 16,
                background: '#fff',
                borderRadius: 12,
              }}
            >
              {/* next/image with data URLs requires extra config; plain <img> is
                 cheaper here and renders identically. The decoded PNG is already
                 optimal — the 'qrcode' package emits an efficient palette. */}
              <img
                src={qrDataUrl}
                alt={`Pickup check-in QR for invoice ${invoice.id.slice(-8).toUpperCase()}`}
                width={240}
                height={240}
                style={{ display: 'block', width: 240, height: 240 }}
              />
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 14,
              color: 'var(--fg-muted)',
              lineHeight: 1.6,
              padding: '1rem 0',
            }}
          >
            {pickupStatus === 'completed'
              ? 'Picked up — thanks! Nothing left to collect on this order.'
              : pickupStatus === 'no_show' || pickupStatus === 'forfeited'
                ? 'This pickup window has closed. Contact the auctioneer about your order.'
                : 'Your check-in code isn’t ready yet. Refresh closer to your pickup window, or contact the auctioneer.'}
          </div>
        )}
        <div
          style={{
            fontSize: 12,
            color: 'var(--fg-muted)',
            marginTop: 12,
            fontFamily: 'monospace',
          }}
        >
          #{invoice.id.slice(-8).toUpperCase()}
        </div>
      </section>

      {/* Your items + shelf locations — lots.intake_bin_id -> bins.code, set at
         put-away. Lets browser bidders see WHAT they won and WHERE it sits. */}
      {items.length > 0 && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1.25rem 1.5rem',
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
        >
          <h2
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--fg-dim)',
              margin: '0 0 0.75rem',
            }}
          >
            Your items
          </h2>
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {/* Stacked layout (2026-07-06): the old two-column flex row
                squeezed the title to a sliver on phones and the nowrap
                location overlapped the lot code. Title wraps freely;
                location sits on its own line underneath. */}
            {items.map((it) => (
              <div key={it.lotId} style={{ fontSize: 14, lineHeight: 1.5 }}>
                <div style={{ color: 'var(--fg)', overflowWrap: 'anywhere' }}>
                  <span
                    style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent)' }}
                  >
                    {it.displayCode ?? '—'}
                  </span>
                  {it.title ? ` · ${it.title}` : ''}
                </div>
                <div
                  style={{
                    color: it.binCode ? 'var(--fg)' : 'var(--fg-muted)',
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {it.binCode ? `On shelf · ${it.binCode}` : 'Location pending'}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pickup window */}
      {(pickupStart || pickupEnd) && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1.25rem 1.5rem',
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
        >
          <h2
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--fg-dim)',
              margin: '0 0 0.75rem',
            }}
          >
            Pickup window
          </h2>
          <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--fg)' }}>
            <div>
              <strong style={{ color: 'var(--fg-muted)', fontWeight: 600 }}>Opens:</strong>{' '}
              {formatInTimeZone(pickupStart, pickupTz)}
            </div>
            <div>
              <strong style={{ color: 'var(--fg-muted)', fontWeight: 600 }}>Closes:</strong>{' '}
              {formatInTimeZone(pickupEnd, pickupTz)}
            </div>
          </div>
        </section>
      )}

      {/* Address + directions */}
      {(wh?.name || fullAddress) && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1.25rem 1.5rem',
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
        >
          <h2
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--fg-dim)',
              margin: '0 0 0.75rem',
            }}
          >
            Address
          </h2>
          <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--fg)' }}>
            {wh?.name && <div style={{ fontWeight: 700 }}>{wh.name}</div>}
            {wh?.address_line1 && (
              <div>
                {wh.address_line1}
                {wh.address_line2 ? `, ${wh.address_line2}` : ''}
              </div>
            )}
            {(wh?.city || wh?.state) && (
              <div>
                {wh.city}
                {wh.city && wh.state ? ', ' : ''}
                {wh.state} {wh.postal_code ?? ''}
              </div>
            )}
          </div>
          {directionsHref && (
            <a
              href={directionsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
              style={{
                display: 'inline-block',
                marginTop: '1rem',
                padding: '0.6rem 1.25rem',
                fontSize: 14,
                textDecoration: 'none',
              }}
            >
              Get directions &rarr;
            </a>
          )}
        </section>
      )}

      {/* Refund policy — optional; surfaced so the bidder knows the post-
         pickup terms before arriving. Matches the mobile RefundPolicyNote
         logic: 0 hours = "all sales final", >0 = "N-hour window". */}
      {policy && (
        <section
          style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background:
              policy.refund_window_post_pickup_hours === 0
                ? 'rgba(248, 113, 113, 0.07)'
                : 'rgba(79, 140, 255, 0.07)',
            border:
              policy.refund_window_post_pickup_hours === 0
                ? '1px solid rgba(248, 113, 113, 0.5)'
                : '1px solid rgba(79, 140, 255, 0.5)',
            borderRadius: 10,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color:
                policy.refund_window_post_pickup_hours === 0 ? 'var(--danger)' : 'var(--accent)',
              lineHeight: 1.5,
            }}
          >
            {policy.refund_window_post_pickup_hours === 0
              ? 'All sales final after pickup per auctioneer policy.'
              : `${policy.refund_window_post_pickup_hours}-hour return window after pickup per auctioneer policy.`}
          </div>
          {policy.refund_window_post_pickup_hours > 0 &&
            policy.no_show_policy === 'refund_minus_restock' &&
            policy.restock_fee_cents > 0 && (
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
                Restock fee {formatPolicyCents(policy.restock_fee_cents)} may apply to returns.
              </div>
            )}
        </section>
      )}

      {/* Contact + receipt link */}
      <section
        style={{
          marginBottom: '1.5rem',
          padding: '1rem 1.25rem',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{auctionTitle}</div>
          {operatorEmail && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              Questions?{' '}
              <a
                href={`mailto:${operatorEmail}`}
                style={{ color: 'var(--accent)', textDecoration: 'none' }}
              >
                {operatorEmail}
              </a>
            </div>
          )}
        </div>
        <Link
          href={`/profile/invoices/${invoice.id}`}
          className="btn-secondary"
          style={{ padding: '0.55rem 1.1rem', fontSize: 13, textDecoration: 'none' }}
        >
          View receipt &rarr;
        </Link>
      </section>
    </main>
  );
}

function PickupNotFound() {
  return (
    <main
      style={{
        padding: '4rem 1.5rem 5rem',
        maxWidth: 560,
        margin: '0 auto',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 6,
        }}
      >
        Account
      </div>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 900, margin: '0 0 0.75rem' }}>
        Pickup not found
      </h1>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 15,
          lineHeight: 1.6,
          marginBottom: '2rem',
        }}
      >
        We couldn&apos;t find this pickup on your account. Head back to your pickup list or reach
        out to support if you think this is a mistake.
      </p>
      <Link href="/profile/pickup" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
        Back to pickups
      </Link>
    </main>
  );
}
