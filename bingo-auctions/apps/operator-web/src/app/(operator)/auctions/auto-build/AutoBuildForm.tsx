'use client';

// Auto-build form. The operator fills in source/batching/schedule, hits
// "Preview" to see what would happen, then "Generate" to commit.

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Field,
  buttonStyle,
  inputStyle,
} from '@/components/Form';
import {
  autoBuild,
  previewAutoBuild,
  type AutoBuildInput,
} from './actions';

type Warehouse = { id: string; name: string; timezone: string | null };
type Category = { id: string; name: string; slug: string };

type PreviewItem = {
  index: number;
  startsAt: string;
  endsAt: string;
  lastLotEndsAt: string | null;
  lotCount: number;
  stepSec: number;
  title: string;
};

export function AutoBuildForm({
  warehouses,
  categories,
}: {
  warehouses: Warehouse[];
  categories: Category[];
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState<string>(warehouses[0]?.id ?? '');
  // Derive the IANA timezone for the currently-selected warehouse so preview
  // auction times render in the warehouse's wall-clock zone.
  const DEFAULT_AUTO_BUILD_TZ = 'America/Chicago';
  const selectedWarehouseTz: string =
    warehouses.find((w) => w.id === warehouseId)?.timezone ??
    DEFAULT_AUTO_BUILD_TZ;

  function fmtPreviewDt(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: selectedWarehouseTz,
        timeZoneName: 'short',
      }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: DEFAULT_AUTO_BUILD_TZ,
        timeZoneName: 'short',
      }).format(new Date(iso));
    }
  }

  function fmtPreviewTime(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit',
        timeZone: selectedWarehouseTz,
      }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit',
        timeZone: DEFAULT_AUTO_BUILD_TZ,
      }).format(new Date(iso));
    }
  }
  const [categoryId, setCategoryId] = useState<string>('');
  const [lotsPerAuction, setLotsPerAuction] = useState('100');
  const [firstStartsAt, setFirstStartsAt] = useState(localISOInDays(0));
  const [cookHours, setCookHours] = useState('168');         // 7 days
  const [gapHours, setGapHours] = useState('24');             // 1 day between starts
  const [pickupOffsetHours, setPickupOffsetHours] = useState('24');
  const [pickupDurationHours, setPickupDurationHours] = useState('72');
  // C2-aligned: closing window in minutes per auction. Default 90 — a
  // typical popcorn-close window for liquidation auctions.
  // closeStaggerSeconds is now
  // a hidden legacy fallback used only when closingWindowMinutes is 0.
  const [closingWindowMinutes, setClosingWindowMinutes] = useState('90');
  const [closeStaggerSeconds] = useState('5');
  const [softCloseMinutes, setSoftCloseMinutes] = useState('3');
  const [buyerPremiumBps, setBuyerPremiumBps] = useState('1500');
  const [format, setFormat] = useState<'standard' | 'dutch' | 'last_chance'>('standard');
  const [titleTemplate, setTitleTemplate] = useState(
    'Auto-build · {date} · {n} of {total}',
  );
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [candidateCount, setCandidateCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [_, startTransition] = useTransition();

  function buildInput(): AutoBuildInput {
    return {
      warehouseId,
      categoryId: categoryId || null,
      lotsPerAuction: Number(lotsPerAuction),
      firstStartsAt: new Date(firstStartsAt).toISOString(),
      cookHours: Number(cookHours),
      gapHours: Number(gapHours),
      pickupOffsetHours: Number(pickupOffsetHours),
      pickupDurationHours: Number(pickupDurationHours),
      closingWindowMinutes: Number(closingWindowMinutes),
      closeStaggerSeconds: Number(closeStaggerSeconds),
      softCloseMinutes: Number(softCloseMinutes),
      buyerPremiumBps: Number(buyerPremiumBps),
      format,
      titleTemplate,
    };
  }

  // Auto-preview when key inputs change. Debounced via the React
  // transition so rapid typing doesn't burn server roundtrips.
  useEffect(() => {
    if (!warehouseId) return;
    const handle = setTimeout(() => {
      void runPreview();
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    warehouseId,
    categoryId,
    lotsPerAuction,
    firstStartsAt,
    cookHours,
    gapHours,
    pickupOffsetHours,
    pickupDurationHours,
    closingWindowMinutes,
    titleTemplate,
  ]);

  async function runPreview() {
    setError(null);
    const result = await previewAutoBuild(buildInput());
    if (!result.ok) {
      setError(result.error);
      setPreview(null);
      setCandidateCount(null);
      return;
    }
    startTransition(() => {
      setPreview(result.auctions);
      setCandidateCount(result.candidateCount);
    });
  }

  async function commit() {
    if (!preview || preview.length === 0) return;
    if (
      !confirm(
        `Generate ${preview.length} draft auctions covering ${candidateCount} lots? This is reversible (you can cancel/edit each before scheduling).`,
      )
    )
      return;
    setCommitting(true);
    setError(null);
    const result = await autoBuild(buildInput());
    setCommitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push('/auctions');
    router.refresh();
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginTop: '1.5rem' }}>
      {/* LEFT: form */}
      <div style={{ display: 'grid', gap: '1rem' }}>
        <SectionHeader>Source</SectionHeader>
        <Field label="Warehouse">
          <select
            style={inputStyle}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category filter (optional)" hint="Leave blank to include all categories.">
          <select
            style={inputStyle}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <SectionHeader>Batching</SectionHeader>
        <Field label="Lots per auction (target)" hint="The system even-splits the matching inventory across this many auctions.">
          <input
            style={inputStyle}
            type="number"
            min={10}
            max={500}
            value={lotsPerAuction}
            onChange={(e) => setLotsPerAuction(e.target.value)}
          />
        </Field>

        <SectionHeader>Schedule</SectionHeader>
        <Field label="First auction starts">
          <input
            style={inputStyle}
            type="datetime-local"
            value={firstStartsAt}
            onChange={(e) => setFirstStartsAt(e.target.value)}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <Field label="Cook hours" hint="Time from start to close per auction (168 = 7 days)">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={720}
              value={cookHours}
              onChange={(e) => setCookHours(e.target.value)}
            />
          </Field>
          <Field
            label="Gap hours between starts"
            hint="Run as many per day as you want: 0 = all start together, 4 = several spread across the day, 24 = one per day."
          >
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={168}
              value={gapHours}
              onChange={(e) => setGapHours(e.target.value)}
            />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <Field label="Pickup offset (h)" hint="Hours after close before pickup window opens">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={72}
              value={pickupOffsetHours}
              onChange={(e) => setPickupOffsetHours(e.target.value)}
            />
          </Field>
          <Field label="Pickup duration (h)">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={168}
              value={pickupDurationHours}
              onChange={(e) => setPickupDurationHours(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Closing window per auction (minutes)"
          hint={(() => {
            const wm = Math.max(0, Number(closingWindowMinutes) || 0);
            const lpa = Math.max(1, Number(lotsPerAuction) || 1);
            if (wm === 0) {
              return 'Set to 0 = all lots in an auction close at the same instant. Typical: 90 min for a popcorn-close window.';
            }
            const stepSec = lpa > 1 ? Math.round((wm * 60) / (lpa - 1)) : 0;
            const stepStr =
              stepSec < 60 ? `≈${stepSec}s/lot` : `≈${(stepSec / 60).toFixed(1)}min/lot`;
            return `Each auction's lots close evenly across this window. ${stepStr} for ~${lpa} lots.`;
          })()}
        >
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={720}
            value={closingWindowMinutes}
            onChange={(e) => setClosingWindowMinutes(e.target.value)}
          />
        </Field>

        <SectionHeader>Defaults</SectionHeader>
        <Field label="Format">
          <select
            style={inputStyle}
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            <option value="standard">Standard</option>
            <option value="dutch">Dutch</option>
            <option value="last_chance">Last Chance</option>
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <Field label="Soft-close (min)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={30}
              value={softCloseMinutes}
              onChange={(e) => setSoftCloseMinutes(e.target.value)}
            />
          </Field>
          <Field label="Buyer's premium (bps)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={3000}
              value={buyerPremiumBps}
              onChange={(e) => setBuyerPremiumBps(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Title template" hint="Variables: {n}, {total}, {date}">
          <input
            style={inputStyle}
            type="text"
            value={titleTemplate}
            onChange={(e) => setTitleTemplate(e.target.value)}
          />
        </Field>
      </div>

      {/* RIGHT: preview + commit */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <SectionHeader>Preview</SectionHeader>
        {error && (
          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(255, 90, 90, 0.08)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {candidateCount !== null && preview && (
          <div
            style={{
              padding: '10px 14px',
              background: candidateCount > 0 ? 'var(--bg-elev)' : 'rgba(255, 90, 90, 0.08)',
              border: `1px solid ${candidateCount > 0 ? 'var(--border)' : 'var(--danger)'}`,
              borderRadius: 6,
              fontSize: 13,
              color: candidateCount > 0 ? 'var(--fg)' : 'var(--danger)',
            }}
          >
            {candidateCount === 0 ? (
              <>No in-inventory lots match. Lot from a manifest pool first or adjust the filter.</>
            ) : (
              <>
                <strong>{candidateCount}</strong> matching lots → <strong>{preview.length}</strong>{' '}
                draft auctions @ ~{Math.round(candidateCount / preview.length)} lots each
              </>
            )}
          </div>
        )}

        {preview && preview.length > 0 && (
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              maxHeight: 480,
              overflowY: 'auto',
            }}
          >
            {preview.map((p) => (
              <div
                key={p.index}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {/* Auction-level window: starts → first close. Rendered in warehouse tz. */}
                  Bidding {fmtPreviewDt(p.startsAt)}
                  {' → '}
                  {fmtPreviewDt(p.lastLotEndsAt ?? p.endsAt)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {p.lotCount} lots ·{' '}
                  {p.lastLotEndsAt
                    ? `closes from ${fmtPreviewTime(p.endsAt)} to ${fmtPreviewTime(p.lastLotEndsAt)}`
                    : `close stagger ${p.stepSec}s`}
                  {p.stepSec > 0 && (
                    <>
                      {' · '}
                      {p.stepSec < 60 ? `${p.stepSec}s/lot` : `${(p.stepSec / 60).toFixed(1)}min/lot`}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {preview && preview.length > 0 && (
          <button
            type="button"
            onClick={commit}
            disabled={committing || candidateCount === 0}
            style={{
              ...buttonStyle,
              padding: '0.75rem',
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {committing
              ? 'Generating…'
              : `Generate ${preview.length} draft auction${preview.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        fontWeight: 700,
        borderBottom: '1px solid var(--border)',
        paddingBottom: 4,
        marginTop: 6,
      }}
    >
      {children}
    </div>
  );
}

function localISOInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
