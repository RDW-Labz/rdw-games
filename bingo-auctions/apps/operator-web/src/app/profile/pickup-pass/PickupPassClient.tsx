'use client';

// Pickup Helper walk UI (mig 0241 Phase 2). The item list arrives already
// in serpentine aisle order from the server; this component owns:
//   • the "next up" card (photo, bin, mark collected, skip)
//   • the remaining/collected checklist
//   • the checkout QR reveal once everything is collected (or on demand —
//     the customer can always jump straight to checkout)
// Progress is mirrored to the server (collected_lot_ids) so a page reload
// or phone swap doesn't lose the walk.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { cdnImageUrl } from '@/lib/img-proxy';
import type { SessionInvoice, SessionItem } from '@/lib/pickup-session';

export function PickupPassClient({
  items,
  invoices,
  initialCollected,
  qrDataUrl,
}: {
  items: SessionItem[];
  invoices: SessionInvoice[];
  initialCollected: string[];
  qrDataUrl: string;
}) {
  const [collected, setCollected] = useState<Set<string>>(new Set(initialCollected));
  // Lots the customer skipped — pushed to the back of the remaining queue.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showQr, setShowQr] = useState(false);

  const remaining = useMemo(() => {
    const notCollected = items.filter((i) => !collected.has(i.lotId));
    const skippedSet = new Set(skipped);
    return [
      ...notCollected.filter((i) => !skippedSet.has(i.lotId)),
      // Preserve skip order at the tail.
      ...skipped
        .map((id) => notCollected.find((i) => i.lotId === id))
        .filter((i): i is SessionItem => !!i),
    ];
  }, [items, collected, skipped]);

  const current = remaining[0] ?? null;
  const done = items.length > 0 && remaining.length === 0;
  const unpaid = invoices.filter(
    (inv) => inv.status !== 'paid' && inv.status !== 'partially_refunded',
  );

  const persist = (lotId: string, action: 'collect' | 'uncollect') => {
    // Fire-and-forget: local state is the UX; the server copy is recovery.
    void fetch('/api/bidder/pickup-pass', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action, lot_id: lotId }),
    }).catch(() => {});
  };

  const markCollected = (lotId: string) => {
    setCollected((prev) => new Set(prev).add(lotId));
    setSkipped((prev) => prev.filter((id) => id !== lotId));
    persist(lotId, 'collect');
  };

  const undoCollected = (lotId: string) => {
    setCollected((prev) => {
      const next = new Set(prev);
      next.delete(lotId);
      return next;
    });
    persist(lotId, 'uncollect');
  };

  const skipCurrent = () => {
    if (!current) return;
    setSkipped((prev) => [...prev.filter((id) => id !== current.lotId), current.lotId]);
  };

  return (
    <div>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 900, letterSpacing: -0.5, marginBottom: 4 }}>
        Pickup pass
      </h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 1.25rem' }}>
        {items.length} item{items.length === 1 ? '' : 's'} across {invoices.length} invoice
        {invoices.length === 1 ? '' : 's'} — in walking order, so you never backtrack.
      </p>

      {/* Checkout QR — always reachable, front and center once the walk is done */}
      {(done || showQr) && (
        <section style={{ ...cardStyle, textAlign: 'center', marginBottom: '1.25rem' }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
            {done ? 'All collected — show this at the counter' : 'Checkout QR'}
          </div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '0 0 0.75rem' }}>
            One scan opens every invoice in this pickup.
          </p>
          {/* Data-URL QR rendered server-side; plain img keeps it crisp. */}
          <img
            src={qrDataUrl}
            alt="Pickup checkout QR code"
            style={{ width: 240, height: 240, borderRadius: 8, background: '#fff', padding: 8 }}
          />
          {unpaid.length > 0 && (
            <p style={{ color: 'var(--warn-yellow, #eab308)', fontSize: 12, marginTop: 10 }}>
              {unpaid.length} invoice{unpaid.length === 1 ? '' : 's'} still need payment — staff
              will take care of it at the counter.
            </p>
          )}
        </section>
      )}

      {/* Next item card */}
      {current && (
        <section style={{ ...cardStyle, marginBottom: '1rem' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              marginBottom: 8,
            }}
          >
            Next up · {items.length - remaining.length + 1} of {items.length}
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            {/* Same tap-through as the list rows. This is the card the customer
                is actually looking at while hunting the shelf, so the link to
                the full original photos matters most here. */}
            <Link
              href={`/lot/${encodeURIComponent(current.lotCode)}`}
              style={{
                display: 'flex',
                gap: 14,
                color: 'inherit',
                textDecoration: 'none',
                minWidth: 0,
              }}
            >
              <ItemPhoto url={current.photoUrl} title={current.title} size={96} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 15, lineHeight: 1.3 }}>
                  {current.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-dim)', margin: '4px 0' }}>
                  {current.displayCode}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>
                  Invoice {current.invoiceId.slice(0, 8)}
                  <span style={{ color: 'var(--accent)' }}> · view original photos →</span>
                </div>
                <BinBadge item={current} large />
                <PickupByChip pickupBy={current.pickupBy} large />
              </div>
            </Link>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => markCollected(current.lotId)}
              style={{
                flex: 1,
                padding: '0.85rem',
                fontSize: 15,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              Got it ✓
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={skipCurrent}
              style={{ padding: '0.85rem 1.1rem', fontSize: 14, cursor: 'pointer' }}
            >
              Skip for now
            </button>
          </div>
        </section>
      )}

      {/* Remaining list */}
      {remaining.length > 1 && (
        <section style={{ marginBottom: '1.25rem' }}>
          <div style={listHeading}>Coming up</div>
          {remaining.slice(1).map((item) => (
            <ItemRow key={item.lotId} item={item} />
          ))}
        </section>
      )}

      {/* Collected list (undo-able) */}
      {collected.size > 0 && (
        <section style={{ marginBottom: '1.25rem' }}>
          <div style={listHeading}>Collected ({collected.size})</div>
          {items
            .filter((i) => collected.has(i.lotId))
            .map((item) => (
              <ItemRow
                key={item.lotId}
                item={item}
                collected
                onUndo={() => undoCollected(item.lotId)}
              />
            ))}
        </section>
      )}

      {!done && !showQr && (
        <button
          type="button"
          onClick={() => setShowQr(true)}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--fg-muted)',
            fontSize: 13,
            padding: '0.6rem 1rem',
            cursor: 'pointer',
          }}
        >
          Show checkout QR now
        </button>
      )}
    </div>
  );
}

function ItemRow({
  item,
  collected,
  onUndo,
}: {
  item: SessionItem;
  collected?: boolean;
  onUndo?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0.5rem 0.6rem',
        borderBottom: '1px solid var(--border)',
        opacity: collected ? 0.55 : 1,
      }}
    >
      {/* Tap-through to the original listing (customer request 2026-07-29):
          "customers (and staff) should be able to tap an item to open the
          original listing... to view the original photos — especially the photo
          of the box or packaging — to help locate an item if it's difficult to
          find during pickup." The thumbnail here is one small image; the
          listing has the full set. /lot/[code] renders for won/closed lots too,
          so the link still resolves at pickup time. */}
      <Link
        href={`/lot/${encodeURIComponent(item.lotCode)}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flex: 1,
          minWidth: 0,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <ItemPhoto url={item.photoUrl} title={item.title} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textDecoration: collected ? 'line-through' : 'none',
            }}
          >
            {item.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {item.displayCode}
            <PickupByChip pickupBy={item.pickupBy} />
          </div>
          {/* Invoice reference — the counter asks "which invoice?" and the
              customer had no way to answer from this screen. */}
          <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 1 }}>
            Invoice {item.invoiceId.slice(0, 8)}
            <span style={{ opacity: 0.7 }}> · tap for photos</span>
          </div>
        </div>
      </Link>
      <BinBadge item={item} />
      {collected && onUndo && (
        <button
          type="button"
          onClick={onUndo}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent)',
            fontSize: 12,
            cursor: 'pointer',
            padding: 4,
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

// Customer feedback 2026-07-09: the pickup deadline must be visible on every
// item — regulars with wins across several auctions need to see which expire
// first, and sorting alone shifts as items are collected or new wins land.
// Amber inside 24h, red once past.
function PickupByChip({ pickupBy, large }: { pickupBy: string | null; large?: boolean }) {
  if (!pickupBy) return null;
  const ts = Date.parse(pickupBy);
  if (!Number.isFinite(ts)) return null;
  const msLeft = ts - Date.now();
  const overdue = msLeft < 0;
  const soon = !overdue && msLeft < 24 * 3600_000;
  const dateLabel = new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
  const color = overdue ? '#f87171' : soon ? 'var(--warn-yellow, #eab308)' : 'var(--fg-muted)';
  return (
    <span
      style={{
        display: large ? 'block' : 'inline',
        marginTop: large ? 6 : 0,
        marginLeft: large ? 0 : 8,
        fontSize: large ? 12 : 11,
        fontWeight: overdue || soon ? 700 : 500,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {overdue ? `Pickup ended ${dateLabel}` : `Pick up by ${dateLabel}`}
    </span>
  );
}

function BinBadge({ item, large }: { item: SessionItem; large?: boolean }) {
  // Jared's test (2026-07-06): aisle+bay alone made him search several
  // shelves — the bin CODE is the complete location (aisle-bay-shelf,
  // exactly what's printed on the shelf label), so it leads.
  const label = item.binCode
    ? item.binCode
    : item.aisle
      ? `Aisle ${item.aisle}${item.bay ? ` · Bay ${item.bay}` : ''}`
      : 'Ask at counter';
  return (
    <span
      style={{
        flexShrink: 0,
        background: 'var(--accent-dim)',
        color: 'var(--accent)',
        fontWeight: 800,
        fontSize: large ? 14 : 11,
        padding: large ? '5px 12px' : '3px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function ItemPhoto({ url, title, size }: { url: string | null; title: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          background: 'var(--bg-elev-2)',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <img
      src={cdnImageUrl(url)}
      alt={title}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
    />
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elev-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '1.1rem 1.25rem',
};

const listHeading: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1.5,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  marginBottom: 6,
};
