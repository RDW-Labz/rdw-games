'use client';

// Keyword search UI. Type a query → POST /api/lottr/search-keyword →
// render result cards. Pick one → POST /api/lottr/save-draft → redirect
// to /inventory or show "saved as RDW-NNN" inline.

import { useState, useTransition } from 'react';
import { buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import type { LotCandidate } from '@auction-platform/domain-lotting';
import { Lightbox, useLightbox } from '@/components/Lightbox';

type Hit = {
  candidate: LotCandidate;
  upc: string;
  sources: string[];
  cached: boolean;
};

export function KeywordSearch() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});       // id → lot_code
  const [_, startTransition] = useTransition();
  const lightbox = useLightbox();

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setHits([]);
    setError(null);
    try {
      const res = await fetch('/api/lottr/search-keyword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const body = (await res.json()) as
        | { ok: true; hits: Hit[] }
        | { ok: false; reason: string };
      if (!body.ok) {
        setError(body.reason);
        return;
      }
      if (body.hits.length === 0) {
        setError('No results. Try a different query (model number gets the cleanest match).');
        return;
      }
      startTransition(() => setHits(body.hits));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveHit(hit: Hit, idx: number) {
    const id = String(idx);
    setSavingId(id);
    try {
      const res = await fetch('/api/lottr/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: hit.candidate }),
      });
      const body = (await res.json()) as
        | { ok: true; lotCode: string }
        | { ok: false; reason: string };
      if (body.ok) {
        setSaved((prev) => ({ ...prev, [id]: body.lotCode }));
      } else {
        setError(`Save failed: ${body.reason}`);
      }
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1rem', marginTop: '1.5rem', maxWidth: 1080 }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="DeWalt DCD771C2"
          style={{ ...inputStyle, flex: 1 }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={runSearch}
          disabled={busy || !query.trim()}
          style={{
            ...buttonStyle,
            opacity: busy || !query.trim() ? 0.5 : 1,
            cursor: busy || !query.trim() ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '0.5rem 0.75rem',
            background: 'rgba(255, 90, 90, 0.08)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {hits.length > 0 && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {hits.map((h, i) => {
            const id = String(i);
            const c = h.candidate;
            const price = c.avg ?? c.startBid ?? c.msrp ?? null;
            const savedAs = saved[id];
            return (
              <div
                key={id}
                style={{
                  display: 'flex',
                  gap: '1rem',
                  padding: '0.75rem',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  alignItems: 'flex-start',
                }}
              >
                {c.stockPhotos[0] && (
                  // plain <img> — opennextjs has known edge cases with <Image> over CF resizing
                  <img
                    src={c.stockPhotos[0]}
                    alt=""
                    onClick={() => lightbox.open(c.stockPhotos, 0)}
                    style={{
                      width: 96,
                      height: 96,
                      objectFit: 'cover',
                      borderRadius: 4,
                      background: 'var(--bg)',
                      cursor: 'zoom-in',
                    }}
                  />
                )}
                <div style={{ flex: 1, display: 'grid', gap: 4 }}>
                  <div style={{ fontWeight: 600 }}>{c.title || '(untitled)'}</div>
                  {(c.brand || c.model) && (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                      {[c.brand, c.model].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.75rem',
                      alignItems: 'center',
                      fontSize: 13,
                    }}
                  >
                    {price != null && (
                      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                        ${price.toFixed(2)}
                      </span>
                    )}
                    <Tag label={h.cached ? 'cached' : 'fresh'} />
                    {h.sources.map((s) => (
                      <Tag key={s} label={s} muted />
                    ))}
                  </div>
                </div>
                <div>
                  {savedAs ? (
                    <span style={{ color: 'var(--success, #34d39a)', fontWeight: 600 }}>
                      ✓ {savedAs}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => saveHit(h, i)}
                      disabled={!!savingId}
                      style={savingId === id ? secondaryButtonStyle : buttonStyle}
                    >
                      {savingId === id ? 'Saving…' : 'Save as draft lot'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Lightbox state={lightbox.state} onClose={lightbox.close} />
    </div>
  );
}

function Tag({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 3,
        background: muted ? 'var(--bg)' : 'var(--bg-elev)',
        border: `1px solid ${muted ? 'var(--border)' : 'var(--accent)'}`,
        color: muted ? 'var(--fg-muted)' : 'var(--accent)',
      }}
    >
      {label}
    </span>
  );
}
