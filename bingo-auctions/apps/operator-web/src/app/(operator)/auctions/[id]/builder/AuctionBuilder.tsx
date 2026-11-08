'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { lotDisplayCode, stickerLabel } from '@auction-platform/shared';
import { addInventoryToAuction, type CarryoverReport } from './actions';
import { chunkIds, emptyReport, mergeReports, notTried, summarize } from './carryover-batches';
import { buttonStyle } from '@/components/Form';

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
};

type InventoryLot = {
  id: string;
  lot_code: string;
  // Pre-stickered physical label ({op}:{raw}) — displayed + searchable so
  // staff can find the code that's actually on the box.
  sticker_code: string | null;
  title: string;
  // B7: lot status, so the carryover buckets can show a per-row hint.
  status: string;
  category_id: string | null;
  category: string | null;
  msrp_cents: number | null;
  starting_bid_cents: number;
  warehouse_id: string | null;
  intake_at: string | null;
  photo_urls: string[] | null;
  // Bin code resolved server-side (builder/page.tsx) from intake_bin_id so the
  // search box can match a bin like "RDW-01-01". Null when the lot isn't binned.
  binCode: string | null;
};

// B7 source buckets (mirrors page.tsx + /lotting/inventory).
type Bucket = 'available' | 'unsold' | 'unpicked_up';
const BUCKET_ORDER: Bucket[] = ['available', 'unsold', 'unpicked_up'];
const BUCKET_LABELS: Record<Bucket, string> = {
  available: 'Available',
  unsold: 'Unsold',
  unpicked_up: 'Unpicked-Up',
};

type SortKey = 'msrp_desc' | 'intake_desc' | 'lot_code_asc' | 'category';

export function AuctionBuilder({
  auctionId,
  warehouseId,
  inventory,
  categories,
  firstLotNumber,
  firstClosesAt,
  lastClosesAt,
  existingLotCount,
  closeStaggerSeconds,
  activeBucket,
  bucketCounts,
}: {
  auctionId: string;
  warehouseId: string | null;
  inventory: InventoryLot[];
  categories: CategoryRow[];
  firstLotNumber: number;
  firstClosesAt: string;
  /** May be null for legacy auctions still on fixed-stagger mode. */
  lastClosesAt: string | null;
  existingLotCount: number;
  closeStaggerSeconds: number;
  // B7: which source bucket is active + per-bucket counts for the tab badges.
  activeBucket: Bucket;
  bucketCounts: Record<Bucket, number>;
}) {
  void warehouseId;
  const router = useRouter();
  // B7: unsold / unpicked-up lots are CARRIED OVER (relisted), minting a new
  // lot code per lot, rather than plain-assigned.
  const isCarryover = activeBucket === 'unsold' || activeBucket === 'unpicked_up';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // Default to MSRP-desc — the "high-value lots get the latest
  // close_at" pattern needs the operator to add high-MSRP
  // first so they end up at the bottom of the lot_number sequence
  // (highest numbers close last).
  const [sort, setSort] = useState<SortKey>('msrp_desc');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Per-lot result of a carryover that did not fully succeed: what made it in,
  // what did not, and why — so staff know exactly what still needs adding.
  const [report, setReport] = useState<CarryoverReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Build top-level categories + leaf-id mapping for filter chips.
  const topLevels = useMemo(
    () => categories.filter((c) => c.parent_id == null),
    [categories],
  );
  const leafIdsByParent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const top of topLevels) {
      map.set(top.id, [
        top.id,
        ...categories.filter((c) => c.parent_id === top.id).map((c) => c.id),
      ]);
    }
    return map;
  }, [categories, topLevels]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filteredList = inventory.filter((l) => {
      if (categoryFilter) {
        const allowed = leafIdsByParent.get(categoryFilter) ?? [categoryFilter];
        if (!l.category_id || !allowed.includes(l.category_id)) return false;
      }
      if (q) {
        // INV-search: match the query substring against ANY searchable field
        // present on the loaded lot shape, not just title + lot_code. Lots
        // known to exist (binned, valid location) were vanishing from this
        // picker when the operator searched by category. Additive OR — the
        // existing title/lot_code matching is preserved.
        //
        // NOTE: brand / model / sticker_code / description live on the `lots`
        // table but are NOT in this component's loaded shape (see baseCols in
        // builder/page.tsx). Searching them would require widening the server
        // query, which is intentionally out of scope here.
        // binCode IS loaded (resolved server-side from intake_bin_id), so a
        // search like "RDW-01-01" / "16-02" finds lots binned there. The
        // builder is already scoped to the auction's single warehouse, so bin
        // search spans only that warehouse.
        const haystacks = [l.title, l.lot_code, stickerLabel(l.sticker_code), l.category, l.binCode];
        const hit = haystacks.some((v) => v != null && v.toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });
    // Sort. Stable sort via Array.prototype.sort in modern engines;
    // each branch uses a deterministic tiebreaker so the order doesn't
    // jitter between renders.
    const sorted = filteredList.slice();
    switch (sort) {
      case 'msrp_desc':
        sorted.sort((a, b) => {
          const am = a.msrp_cents ?? -1;
          const bm = b.msrp_cents ?? -1;
          if (bm !== am) return bm - am;
          return a.lot_code.localeCompare(b.lot_code);
        });
        break;
      case 'intake_desc':
        sorted.sort((a, b) => {
          const ai = a.intake_at ? new Date(a.intake_at).getTime() : 0;
          const bi = b.intake_at ? new Date(b.intake_at).getTime() : 0;
          if (bi !== ai) return bi - ai;
          return a.lot_code.localeCompare(b.lot_code);
        });
        break;
      case 'lot_code_asc':
        sorted.sort((a, b) => a.lot_code.localeCompare(b.lot_code));
        break;
      case 'category':
        sorted.sort((a, b) => {
          const ac = a.category ?? 'zzz';
          const bc = b.category ?? 'zzz';
          if (ac !== bc) return ac.localeCompare(bc);
          return a.lot_code.localeCompare(b.lot_code);
        });
        break;
    }
    return sorted;
  }, [inventory, search, categoryFilter, leafIdsByParent, sort]);

  // Timeline preview: given the auction's window + currently-selected
  // count, predict when the first / last lot in this batch will close.
  // Uses the same math as the redistribute_close_times RPC (linear
  // interpolation across [firstClosesAt, lastClosesAt]) so the live
  // preview agrees with the eventual stored close_at values.
  //
  // Edge cases handled:
  //   - lastClosesAt null (legacy auction): fall back to fixed stagger
  //     (close_stagger_seconds × index)
  //   - 0 selected: show empty hint instead of computing
  //   - existingLotCount > 0 (lots already in auction): the new batch's
  //     numbers start at firstLotNumber, NOT 1. The preview shows when
  //     THIS BATCH's first/last close. Bidders see the full auction's
  //     range; operators care about the batch they're committing.
  const timeline = useMemo(() => {
    const n = selected.size;
    if (n === 0) return null;
    const totalAfter = existingLotCount + n;
    const firstMs = new Date(firstClosesAt).getTime();
    if (lastClosesAt) {
      // Two-endpoint mode. Stagger = (window) / (totalAfter - 1).
      const lastMs = new Date(lastClosesAt).getTime();
      const stepMs = totalAfter > 1 ? (lastMs - firstMs) / (totalAfter - 1) : 0;
      const batchFirstNumber = firstLotNumber; // first new lot's number
      const batchLastNumber = firstLotNumber + n - 1;
      const batchFirstMs = firstMs + (batchFirstNumber - 1) * stepMs;
      const batchLastMs = firstMs + (batchLastNumber - 1) * stepMs;
      return {
        firstClose: new Date(batchFirstMs),
        lastClose: new Date(batchLastMs),
        stepSec: Math.round(stepMs / 1000),
        mode: 'window' as const,
        totalAfter,
      };
    }
    // Legacy fixed-stagger mode.
    const stepSec = Math.max(0, closeStaggerSeconds);
    const batchFirstMs = firstMs + (firstLotNumber - 1) * stepSec * 1000;
    const batchLastMs = firstMs + (firstLotNumber + n - 2) * stepSec * 1000;
    return {
      firstClose: new Date(batchFirstMs),
      lastClose: new Date(batchLastMs),
      stepSec,
      mode: 'fixed' as const,
      totalAfter,
    };
  }, [selected, firstLotNumber, firstClosesAt, lastClosesAt, existingLotCount, closeStaggerSeconds]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const l of filtered) next.add(l.id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function onCommit() {
    if (selected.size === 0) {
      setError('Pick at least one lot to add.');
      return;
    }
    setError(null);
    setReport(null);
    setProgress(null);
    const ids = Array.from(selected);
    startTransition(async () => {
      if (!isCarryover) {
        await commitAvailable(ids);
        return;
      }
      await commitCarryover(ids);
    });
  }

  // 2026-10-23 (Error Code 520): the request died after the database had
  // already done the work, the grid kept the old rows, and the retry reported
  // every one as "already carried over". Whatever happened server-side,
  // reload the lists so the grid shows the truth.
  const LOST_ANSWER =
    "The console didn't get an answer from the server. Some lots may have been added anyway — the list is reloading to show what is left.";

  async function commitAvailable(ids: string[]) {
    let result: Awaited<ReturnType<typeof addInventoryToAuction>>;
    try {
      result = await addInventoryToAuction({ auction_id: auctionId, lot_ids: ids, source: activeBucket });
    } catch {
      setError(LOST_ANSWER);
      setSelected(new Set());
      router.refresh();
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.push(`/auctions/${auctionId}`);
  }

  // Carry-over goes CARRYOVER_CHUNK lots per request, one after another, with
  // progress on the button (owner, 2026-10-23), so no request runs long.
  async function commitCarryover(ids: string[]) {
    const chunks = chunkIds(ids);
    let merged = emptyReport();
    let sent = 0;
    setProgress({ done: 0, total: ids.length });
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      let result: Awaited<ReturnType<typeof addInventoryToAuction>>;
      try {
        result = await addInventoryToAuction({ auction_id: auctionId, lot_ids: chunk, source: activeBucket });
      } catch {
        setError(LOST_ANSWER);
        setReport(merged);
        setSelected(new Set());
        setProgress(null);
        router.refresh();
        return;
      }
      sent += chunk.length;
      if (!result.carryover) {
        // Refused before any lot was tried (auth, role, bad input): stop here.
        setError(result.ok ? null : result.error);
        setReport(merged.carried.length + merged.failed.length + merged.already.length > 0 ? merged : null);
        setProgress(null);
        if (merged.carried.length > 0) router.refresh();
        return;
      }
      merged = mergeReports(merged, result.carryover);
      setProgress({ done: sent, total: ids.length });
      if (result.carryover.stopped) {
        const rest = chunks.slice(i + 1).flat();
        const codeOf = (id: string) => {
          const lot = inventory.find((l) => l.id === id);
          return lot ? (lotDisplayCode(lot) ?? lot.lot_code) : id;
        };
        merged = mergeReports(merged, {
          carried: [],
          failed: notTried(rest, result.carryover.stopped, codeOf),
          already: [],
        });
        break;
      }
    }
    setProgress(null);
    const summary = summarize(merged, ids.length);
    if (summary.ok) {
      router.push(`/auctions/${auctionId}`);
      return;
    }
    setError(summary.message);
    setReport(merged);
    setSelected(new Set());
    router.refresh();
  }


  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 1200 }}>
      {/* B7 source tabs — pick where lots come from. Switching navigates
          (full reload) so the selection resets and the lot grid reloads
          server-side for the new bucket. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {BUCKET_ORDER.map((b) => (
          <SourceTab
            key={b}
            href={`/auctions/${auctionId}/builder${b === 'available' ? '' : `?bucket=${b}`}`}
            label={BUCKET_LABELS[b]}
            count={bucketCounts[b]}
            active={activeBucket === b}
          />
        ))}
        {isCarryover && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 12, marginLeft: 4 }}>
            Carried-over lots are relisted — each mints a new lot code and keeps a link to its origin.
          </span>
        )}
      </div>

      {/* Filter + sort row */}
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder="Search by title, lot code, category, or bin (e.g. RDW-000123)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 240,
              padding: '8px 12px',
              background: 'var(--bg-elev)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--fg-muted)' }}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              style={{
                padding: '6px 10px',
                background: 'var(--bg-elev)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              <option value="msrp_desc">MSRP (high → low)</option>
              <option value="intake_desc">Newest intake</option>
              <option value="lot_code_asc">Lot code (A → Z)</option>
              <option value="category">Category</option>
            </select>
          </label>
        </div>
        {topLevels.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <FilterPill
              active={categoryFilter === null}
              onClick={() => setCategoryFilter(null)}
              label="All categories"
            />
            {topLevels.map((c) => (
              <FilterPill
                key={c.id}
                active={categoryFilter === c.id}
                onClick={() => setCategoryFilter(categoryFilter === c.id ? null : c.id)}
                label={c.name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Live timeline preview — appears once 1+ lots selected. Shows
          "your auction will close from X to Y at Zs/lot" so the
          operator sees the schedule as they curate. */}
      {timeline && (
        <div
          style={{
            padding: '10px 14px',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 800 }}>
            Closes #{firstLotNumber} → #{firstLotNumber + selected.size - 1}
          </span>
          <span>
            {timeline.firstClose.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            {' → '}
            {timeline.lastClose.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          <span style={{ opacity: 0.85 }}>
            ·{' '}
            {timeline.stepSec < 60
              ? `${timeline.stepSec}s/lot`
              : `${(timeline.stepSec / 60).toFixed(1)}min/lot`}
            {' '}
            ({timeline.mode === 'window' ? 'evenly distributed across the window' : 'fixed stagger'})
          </span>
          {timeline.mode === 'fixed' && !lastClosesAt && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              Set "Last lot closes at" on the auction edit page to switch to evenly-distributed mode.
            </span>
          )}
        </div>
      )}

      {/* Sticky action bar */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          padding: '10px 14px',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--fg)', fontWeight: 700 }}>
          {selected.size} selected
        </span>
        <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
          {filtered.length} of {inventory.length} shown
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={selectAllVisible}
          disabled={filtered.length === 0}
          style={{
            padding: '6px 12px',
            background: 'transparent',
            color: 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Select visible ({filtered.length})
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={clearSelection}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={onCommit}
          disabled={pending || selected.size === 0}
          style={{
            ...buttonStyle,
            color: '#000',
            fontWeight: 800,
            opacity: pending || selected.size === 0 ? 0.4 : 1,
            cursor: pending || selected.size === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {pending
            ? isCarryover
              ? progress
                ? `Carrying over ${progress.done} of ${progress.total}…`
                : 'Carrying over…'
              : 'Adding…'
            : selected.size === 0
              ? isCarryover
                ? 'Carry over to auction'
                : 'Add to auction'
              : isCarryover
                ? `Carry over ${selected.size} lot${selected.size === 1 ? '' : 's'} →`
                : `Add ${selected.size} as #${firstLotNumber}–#${firstLotNumber + selected.size - 1}`}
        </button>
        {error && (
          <span style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 600 }}>{error}</span>
        )}
      </div>

      {report && <CarryoverResult report={report} />}

      {/* Lot grid */}
      {filtered.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--fg-muted)',
          }}
        >
          {inventory.length === 0
            ? activeBucket === 'unsold'
              ? 'No unsold lots at this warehouse. Lots land here when an auction closes without a winning bid.'
              : activeBucket === 'unpicked_up'
                ? 'No unpicked-up lots at this warehouse. Lots land here when a winning bidder no-shows or forfeits a pickup.'
                : 'No inventory at this warehouse yet. Run intake from the picker app to land lots here.'
            : 'Nothing matches the current filters.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {filtered.map((lot) => {
            const isSel = selected.has(lot.id);
            const photo = lot.photo_urls?.[0];
            return (
              <button
                key={lot.id}
                type="button"
                onClick={() => toggleOne(lot.id)}
                style={{
                  display: 'block',
                  padding: 0,
                  textAlign: 'left',
                  background: 'transparent',
                  border: '2px solid',
                  borderColor: isSel ? 'var(--accent)' : 'var(--border)',
                  borderRadius: 10,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    aspectRatio: '1',
                    background: 'var(--bg-elev)',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {photo ? (
                    /* plain <img> — opennextjs has known edge cases with <Image> over CF resizing */
                    <img
                      src={photo}
                      alt=""
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--fg-dim)',
                        fontSize: 24,
                      }}
                    >
                      📦
                    </div>
                  )}
                  {isSel && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        color: '#000',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 900,
                        fontSize: 14,
                      }}
                    >
                      ✓
                    </div>
                  )}
                </div>
                <div style={{ padding: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: 'var(--accent)',
                        fontWeight: 700,
                      }}
                    >
                      {lotDisplayCode(lot) ?? lot.lot_code}
                    </div>
                    {/* MSRP gets the prominent right-side spot — operator
                        scanning for high-value items can read it at a
                        glance when sorted by msrp_desc. */}
                    {lot.msrp_cents != null && lot.msrp_cents > 0 && (
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: 'var(--fg)',
                        }}
                      >
                        ${(lot.msrp_cents / 100).toFixed(0)}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      color: 'var(--fg)',
                      fontSize: 13,
                      fontWeight: 600,
                      lineHeight: 1.3,
                      maxHeight: 36,
                      overflow: 'hidden',
                    }}
                  >
                    {lot.title}
                  </div>
                  {lot.category && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-muted)',
                        marginTop: 4,
                      }}
                    >
                      {lot.category}
                    </div>
                  )}
                  {/* B7: carryover hint — these lots are relisted, not moved,
                      so the operator knows a fresh lot code will be minted. */}
                  {isCarryover && (
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: 0.4,
                        color: 'var(--accent)',
                        marginTop: 6,
                        textTransform: 'uppercase',
                      }}
                    >
                      ↻ Carryover — mints new code
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// B7 source tab — same visual language as FilterPill but with a count badge
// and rendered as a Link so switching buckets navigates server-side.
function SourceTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.4,
        textDecoration: 'none',
      }}
      aria-current={active ? 'page' : undefined}
    >
      <span>{label}</span>
      <span
        style={{
          minWidth: 20,
          textAlign: 'center',
          padding: '1px 7px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 800,
          background: active ? 'var(--accent)' : 'var(--bg-elev)',
          color: active ? 'var(--bg)' : 'var(--fg-muted)',
        }}
      >
        {count}
      </span>
    </Link>
  );
}

function FilterPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 12px',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function CarryoverResult({ report }: { report: CarryoverReport }) {
  return (
    <div
      role="status"
      data-testid="carryover-result"
      style={{
        display: 'grid',
        gap: 12,
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      {report.failed.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--danger)', marginBottom: 6 }}>
            Not added ({report.failed.length}) — these still need adding
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {report.failed.map((f) => (
              <li key={f.lotId}>
                <Link href={`/lots/${f.lotId}`} style={{ fontWeight: 600 }}>
                  {f.code}
                </Link>{' '}
                — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.carried.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Carried over ({report.carried.length})
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {report.carried.map((c) => (
              <li key={c.lotId}>
                {c.code} → {c.newCode}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(report.already ?? []).length > 0 && (
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Already carried over earlier ({report.already.length})
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {report.already.map((c) => (
              <li key={c.lotId}>
                {c.code}
                {c.newCode ? ` → ${c.newCode}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
