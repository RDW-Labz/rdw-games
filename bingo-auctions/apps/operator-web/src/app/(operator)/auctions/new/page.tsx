'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field, PageHeader, buttonStyle, inputStyle } from '@/components/Form';
import {
  BidIncrementScheduleEditor,
  parseDrafts,
  type TierDraft,
} from '@/components/BidIncrementScheduleEditor';
import { createAuction, listWarehouses, getOperatorAuctionDefaults } from './actions';

export default function NewAuctionPage() {
  const router = useRouter();
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState(localISOInDays(0));
  const [endsAt, setEndsAt] = useState(localISOInDays(7));
  // Default last lot to 90min after first lot — a typical popcorn-close
  // window for liquidation auctions. Operator can change.
  const [lastLotEndsAt, setLastLotEndsAt] = useState(localISOInDaysHours(7, 1.5));
  const [pickupStartsAt, setPickupStartsAt] = useState(localISOInDays(8));
  const [pickupEndsAt, setPickupEndsAt] = useState(localISOInDays(11));
  const [softCloseMinutes, setSoftCloseMinutes] = useState('3');
  const [prebidEnabled, setPrebidEnabled] = useState(true); // 0222: on by default
  const [unlisted, setUnlisted] = useState(false); // 0242: link-only test auction
  // Operator's expected lot count. Used only to derive the per-lot
  // stagger preview ("≈30s/lot for 100 lots") — actual stagger is
  // computed at lot-assignment time from the real count.
  const [plannedLotCount, setPlannedLotCount] = useState('100');
  const [buyerPremiumBps, setBuyerPremiumBps] = useState('1500');
  const [format, setFormat] = useState<'standard' | 'dutch' | 'last_chance'>('standard');
  // BID-3: optional per-auction increment override. Empty = inherit the
  // operator default ladder.
  const [incrementDrafts, setIncrementDrafts] = useState<TierDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listWarehouses().then((wh) => {
      setWarehouses(wh);
      // 0293 / multi-location audit: only auto-select when there is exactly ONE
      // warehouse. With two, defaulting to wh[0] silently preselected Harrison
      // for someone building a Dodge City auction — and auctions.warehouse_id
      // is NOT NULL and gates which lots can be assigned, so a mis-set auction
      // is painful to unwind once lots are attached. Force the choice instead.
      if (wh.length === 1 && !warehouseId) setWarehouseId(wh[0]!.id);
    });
    // Seed soft-close + buyer's premium from the operator's configured
    // defaults (operators.default_soft_close_minutes / default_buyer_premium_bps)
    // so this form respects per-operator settings instead of the generic
    // 3min / 1500bps. Falls back to those initial values if the fetch fails
    // or the operator hasn't customized them.
    getOperatorAuctionDefaults().then((d) => {
      if (!d) return;
      setSoftCloseMinutes(String(d.defaultSoftCloseMinutes));
      setBuyerPremiumBps(String(d.defaultBuyerPremiumBps));
    });
    // warehouseId intentionally omitted — we only want to fetch + seed
    // the default ONCE on mount. Including it would re-fetch every time
    // the user changes their dropdown selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // BID-3: validate the optional increment override client-side. Empty list →
    // null → the auction inherits the operator default ladder.
    const parsedSchedule = parseDrafts(incrementDrafts);
    if (!parsedSchedule.ok) {
      setError(parsedSchedule.error);
      return;
    }

    setLoading(true);

    // Derive close_stagger_seconds from the two endpoints + planned lot count
    // so the existing legacy assign_lots_to_auction RPC keeps working when
    // operators add lots before they explicitly call redistribute_close_times.
    const planned = Math.max(1, Number(plannedLotCount) || 1);
    const windowMs = new Date(lastLotEndsAt).getTime() - new Date(endsAt).getTime();
    const derivedStagger =
      planned > 1 ? Math.max(0, Math.min(60, Math.round(windowMs / 1000 / (planned - 1)))) : 0;

    const result = await createAuction({
      warehouseId,
      title,
      description: description || null,
      format,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      lastLotEndsAt: new Date(lastLotEndsAt).toISOString(),
      pickupStartsAt: new Date(pickupStartsAt).toISOString(),
      pickupEndsAt: new Date(pickupEndsAt).toISOString(),
      softCloseMinutes: Number(softCloseMinutes),
      prebidEnabled,
      unlisted,
      buyerPremiumBps: Number(buyerPremiumBps),
      closeStaggerSeconds: derivedStagger,
      bidIncrementSchedule: parsedSchedule.tiers,
    });
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    // BUG-AC-06 fix: redirect to the new auction's detail page so the
    // operator's next click is "Add lots" — not back to the list where
    // they'd have to find the auction they just created.
    router.push(`/auctions/${result.auctionId}`);
    router.refresh();
  }

  return (
    <div>
      <PageHeader title="New auction" />
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 640 }}>
        <Field label="Warehouse">
          <select
            style={inputStyle}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            required
          >
            {/* Placeholder only when there is a real choice to make. Without an
                option matching the empty value, `required` cannot block submit
                and the browser would just display the first warehouse while the
                value stayed empty. */}
            {warehouses.length > 1 && <option value="">Select a warehouse…</option>}
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label="Description">
          <textarea
            style={{ ...inputStyle, minHeight: 80 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Format"
          hint={
            format === 'standard'
              ? 'Proxy/max bidding with soft-close anti-snipe.'
              : format === 'dutch'
                ? 'Price starts high and ticks down; first buyer wins at the current price.'
                : 'Flat-price first-come-first-served. Use for unsold inventory.'
          }
        >
          <select
            style={inputStyle}
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            <option value="standard">Standard (timed bids)</option>
            <option value="dutch">Dutch (declining price)</option>
            <option value="last_chance">Last Chance (flat price)</option>
          </select>
        </Field>
        <Field label="Bidding starts">
          <input
            style={inputStyle}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            required
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <Field
            label="First lot closes at"
            hint="Highest-numbered lots close first. Bidders see this as the auction's start-of-close time."
          >
            <input
              style={inputStyle}
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </Field>
          <Field
            label="Last lot closes at"
            hint="Spread your lots across this window so bidders camp the auction. 60-90min is typical."
          >
            <input
              style={inputStyle}
              type="datetime-local"
              value={lastLotEndsAt}
              onChange={(e) => setLastLotEndsAt(e.target.value)}
              required
            />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <Field label="Pickup window starts">
            <input
              style={inputStyle}
              type="datetime-local"
              value={pickupStartsAt}
              onChange={(e) => setPickupStartsAt(e.target.value)}
              required
            />
          </Field>
          <Field label="Pickup window ends">
            <input
              style={inputStyle}
              type="datetime-local"
              value={pickupEndsAt}
              onChange={(e) => setPickupEndsAt(e.target.value)}
              required
            />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <Field label="Soft-close minutes" hint="Bids in last N minutes extend close by N minutes">
            <input
              style={inputStyle}
              type="number"
              min="0"
              max="30"
              value={softCloseMinutes}
              onChange={(e) => setSoftCloseMinutes(e.target.value)}
            />
          </Field>
          <Field label="Buyer's premium (bps)" hint="1500 = 15.00%">
            <input
              style={inputStyle}
              type="number"
              min="0"
              max="3000"
              value={buyerPremiumBps}
              onChange={(e) => setBuyerPremiumBps(e.target.value)}
            />
          </Field>
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={prebidEnabled}
            onChange={(e) => setPrebidEnabled(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <strong>Allow pre-bidding during preview</strong>
            <span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: 12 }}>
              Bidders can place max bids as soon as the auction is scheduled — before the
              start time. Lots stay marked Upcoming and the anti-snipe clock only runs
              once the auction is live.
            </span>
          </span>
        </label>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={unlisted}
            onChange={(e) => setUnlisted(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <strong>Unlisted (test auction)</strong>
            <span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: 12 }}>
              Hidden from browse, homepage, categories, search, sitemap, and marketing
              emails. Anyone with the direct link can still view and bid — use for staff
              test runs on the live site.
            </span>
          </span>
        </label>

        {/* BID-3 — optional per-auction increment override. Empty = inherit the
            operator's default ladder (Settings → Auction defaults). */}
        <BidIncrementScheduleEditor
          drafts={incrementDrafts}
          onChange={setIncrementDrafts}
          label="Bid increment ladder (override, optional)"
          hint="Leave empty to inherit your operator default. Add tiers to override the minimum bid increment for this auction only. First tier starts at $0.00."
          emptyHint="Inheriting your operator default ladder. Add tiers to override it for this auction."
        />
        <Field
          label="Expected lot count"
          hint={(() => {
            const planned = Math.max(1, Number(plannedLotCount) || 1);
            const windowMs =
              new Date(lastLotEndsAt).getTime() - new Date(endsAt).getTime();
            if (windowMs <= 0 || planned <= 1) {
              return 'Used to preview the per-lot stagger. Actual stagger is recomputed when lots are added.';
            }
            const stepSec = windowMs / 1000 / (planned - 1);
            const stepStr =
              stepSec < 60
                ? `≈${Math.round(stepSec)}s/lot`
                : `≈${(stepSec / 60).toFixed(1)}min/lot`;
            const winMin = Math.round(windowMs / 60000);
            return `${stepStr} across a ${winMin}min window. Recomputed precisely once lots are assigned.`;
          })()}
        >
          <input
            style={inputStyle}
            type="number"
            min="1"
            max="2500"
            value={plannedLotCount}
            onChange={(e) => setPlannedLotCount(e.target.value)}
          />
        </Field>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div>
          <button type="submit" disabled={loading || !warehouseId} style={buttonStyle}>
            {loading ? 'Creating…' : 'Create draft auction'}
          </button>
        </div>
      </form>
    </div>
  );
}

function localISOInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // Format as YYYY-MM-DDTHH:mm in local time
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Variant that allows fractional-hour offset on top of the days. Used to
// pre-fill the "last lot closes" 90 minutes after the first lot.
function localISOInDaysHours(days: number, hours: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setMinutes(d.getMinutes() + Math.round(hours * 60));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
