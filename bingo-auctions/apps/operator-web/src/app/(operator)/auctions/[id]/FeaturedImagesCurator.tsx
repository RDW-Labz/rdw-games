'use client';

// FeaturedImagesCurator — auction-level cover/hero images
//
// Up to 6 image URLs that drive the auction's listing card. Operators
// can:
//   - Auto-pick: random sample from the top 20 highest-MSRP lots that
//     have a safe photo URL. Replaces the entire array.
//   - Swap one: click a tile to remove + auto-pick a replacement
//     excluding all currently shown URLs (so you don't see the same
//     suggestion twice).
//   - Clear all: reset to an empty array; operator can then manually
//     paste URLs (deferred — out of MVP) or auto-pick again.
//
// The displayed images are the ones currently saved on the auction
// row. Optimistic update: on swap, we replace the tile immediately
// then sync the server row in the background.

import { useState, useTransition } from 'react';
import { autoPickFeaturedImages, saveFeaturedImages } from './featured-actions';

type Props = {
  auctionId: string;
  initial: string[];
  /** Auctions in live/closed/canceled states are read-only. */
  canEdit: boolean;
};

export function FeaturedImagesCurator({ auctionId, initial, canEdit }: Props) {
  const [urls, setUrls] = useState<string[]>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAutoPick() {
    setError(null);
    startTransition(async () => {
      // Empty exclude list — replace the entire array with a fresh pick.
      const r = await autoPickFeaturedImages({ auctionId, excludeUrls: [] });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.urls.length === 0) {
        setError(
          'No qualifying photos. Featured images come from lots in this auction with photos on an allowlisted retailer CDN.',
        );
        return;
      }
      setUrls(r.urls);
    });
  }

  function handleSwapAt(index: number) {
    setError(null);
    startTransition(async () => {
      // Exclude every URL currently shown (including the one being
      // swapped) so the replacement is genuinely different.
      const r = await autoPickFeaturedImages({
        auctionId,
        excludeUrls: urls,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.urls.length === 0) {
        // No more candidates — drop the tile rather than replace it.
        const next = urls.filter((_, i) => i !== index);
        setUrls(next);
        const save = await saveFeaturedImages({ auctionId, urls: next });
        if (!save.ok) setError(save.error);
        return;
      }
      // The RPC returns a fresh sample of up to 6; pick its first item
      // as the swap target. Then recompute the array preserving order
      // for the rest.
      const replacement = r.urls[0]!;
      const next = urls.map((u, i) => (i === index ? replacement : u));
      setUrls(next);
      const save = await saveFeaturedImages({ auctionId, urls: next });
      if (!save.ok) setError(save.error);
    });
  }

  function handleRemoveAt(index: number) {
    setError(null);
    startTransition(async () => {
      const next = urls.filter((_, i) => i !== index);
      setUrls(next);
      const save = await saveFeaturedImages({ auctionId, urls: next });
      if (!save.ok) setError(save.error);
    });
  }

  function handleClearAll() {
    setError(null);
    startTransition(async () => {
      setUrls([]);
      const save = await saveFeaturedImages({ auctionId, urls: [] });
      if (!save.ok) setError(save.error);
    });
  }

  return (
    <section
      style={{
        marginBottom: '2rem',
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Featured images</h2>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          {urls.length}/6 — bidder-facing cover for this auction
        </span>
        <span style={{ flex: 1 }} />
        {canEdit && (
          <>
            <button
              type="button"
              onClick={handleAutoPick}
              disabled={pending}
              style={{
                padding: '6px 12px',
                background: 'var(--accent-dim)',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: pending ? 'wait' : 'pointer',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {pending ? 'Picking…' : urls.length > 0 ? 'Re-pick all' : 'Auto-pick best 6'}
            </button>
            {urls.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                disabled={pending}
                style={{
                  padding: '6px 12px',
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: pending ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                Clear
              </button>
            )}
          </>
        )}
      </header>

      {urls.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--fg-muted)',
            fontSize: 13,
            border: '1px dashed var(--border)',
            borderRadius: 6,
            background: 'var(--bg)',
          }}
        >
          No featured images yet.{' '}
          {canEdit
            ? 'Click "Auto-pick best 6" — we’ll sample randomly from your top-20 highest-MSRP lots so multiple auctions get distinct covers.'
            : 'Read-only — auction is live or closed.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 8,
          }}
        >
          {urls.map((url, i) => (
            <div
              key={`${url}-${i}`}
              style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--border)',
                background: 'var(--bg)',
              }}
            >
              {/* plain <img> — opennextjs has known edge cases with <Image> over CF resizing */}
              <img
                src={url}
                alt={`Featured ${i + 1}`}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {canEdit && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    background: 'linear-gradient(to top, rgba(0,0,0,0.65), transparent)',
                    opacity: 0,
                    transition: 'opacity 150ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      padding: 8,
                      justifyContent: 'space-between',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleSwapAt(i)}
                      disabled={pending}
                      title="Pick another"
                      style={{
                        flex: 1,
                        padding: '4px 8px',
                        background: 'rgba(255,255,255,0.95)',
                        color: '#000',
                        border: 'none',
                        borderRadius: 3,
                        cursor: pending ? 'wait' : 'pointer',
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      ↺ Swap
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveAt(i)}
                      disabled={pending}
                      title="Remove"
                      style={{
                        padding: '4px 8px',
                        background: 'rgba(220,38,38,0.95)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 3,
                        cursor: pending ? 'wait' : 'pointer',
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p
          style={{
            color: 'var(--danger)',
            fontSize: 12,
            marginTop: 12,
            marginBottom: 0,
            fontWeight: 600,
          }}
        >
          {error}
        </p>
      )}
    </section>
  );
}
