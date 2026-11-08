'use client';

// SavedSearchList — client component for delete + notify-toggle interactions.
//
// The server page (page.tsx) passes the initial list as a prop (SSR-rendered,
// no JS needed for the first paint). This component takes over for mutations:
//   - Delete: server action deleteSavedSearch → optimistic local removal +
//     revalidatePath to confirm.
//   - Toggle notify: server action toggleSavedSearchNotify → optimistic
//     flip + revert on failure (keeps UI honest).
//
// Parity target: apps/bidder-app/app/profile/saved-searches.tsx.
// Web has no expo-router tabs, so the "Apply" CTA links to the browse page
// with criteria as query params instead of pushing to /(tabs).

import { useState, useTransition } from 'react';
import { deleteSavedSearch, toggleSavedSearchNotify } from './actions';

interface SavedSearchCriteria {
  q?: string;
  category_id?: string;
  operator_id?: string;
  min_discount_pct?: number;
}

export interface SavedSearchRow {
  id: string;
  name: string;
  criteria: SavedSearchCriteria;
  notify: boolean;
  last_matched_at: string | null;
  created_at: string;
}

interface Props {
  initialItems: SavedSearchRow[];
}

function buildBrowseHref(criteria: SavedSearchCriteria): string {
  const params = new URLSearchParams();
  if (criteria.q) params.set('q', criteria.q);
  if (criteria.category_id) params.set('category_id', criteria.category_id);
  if (criteria.operator_id) params.set('operator_id', criteria.operator_id);
  if (criteria.min_discount_pct != null)
    params.set('min_discount_pct', String(criteria.min_discount_pct));
  const qs = params.toString();
  return qs ? `/auctions?${qs}` : '/auctions';
}

function summarizeCriteria(c: SavedSearchCriteria): string {
  const parts: string[] = [];
  if (c.q) parts.push(`"${c.q}"`);
  if (c.min_discount_pct != null) parts.push(`≥${c.min_discount_pct}% off MSRP`);
  if (!parts.length) parts.push('All lots');
  return parts.join(' · ');
}

export function SavedSearchList({ initialItems }: Props) {
  const [items, setItems] = useState<SavedSearchRow[]>(initialItems);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(id: string) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This search will stop sending alerts.`)) return;
    clearError(id);
    setDeletingId(id);
    // Optimistic: remove immediately.
    setItems((prev) => prev.filter((s) => s.id !== id));
    startTransition(async () => {
      const result = await deleteSavedSearch(id);
      setDeletingId(null);
      if (!result.ok) {
        // Revert: put the item back.
        setItems((prev) => {
          const exists = prev.find((s) => s.id === id);
          if (exists) return prev;
          // Re-insert at its original position is impractical; append at top.
          return [initialItems.find((s) => s.id === id)!, ...prev].filter(Boolean);
        });
        setErrors((prev) => ({ ...prev, [id]: result.error }));
      }
    });
  }

  function handleToggleNotify(id: string, next: boolean) {
    clearError(id);
    setTogglingId(id);
    // Optimistic flip.
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, notify: next } : s)));
    startTransition(async () => {
      const result = await toggleSavedSearchNotify(id, next);
      setTogglingId(null);
      if (!result.ok) {
        // Revert.
        setItems((prev) => prev.map((s) => (s.id === id ? { ...s, notify: !next } : s)));
        setErrors((prev) => ({ ...prev, [id]: result.error }));
      }
    });
  }

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: '3rem 1rem',
          textAlign: 'center',
          color: 'var(--fg-muted)',
        }}
      >
        <p
          style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            color: 'var(--fg)',
            marginBottom: '0.5rem',
          }}
        >
          No saved searches yet
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 320, margin: '0 auto' }}>
          Browse auctions, search for items you want, and save your search to get alerted when new
          matching lots are listed.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {items.map((item) => {
        const busy = deletingId === item.id || togglingId === item.id;
        const errMsg = errors[item.id];
        return (
          <div
            key={item.id}
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '1rem',
              opacity: deletingId === item.id ? 0.4 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontWeight: 700,
                    fontSize: 15,
                    color: 'var(--fg)',
                  }}
                >
                  {item.name}
                </p>
                <p
                  style={{
                    margin: '0.25rem 0 0',
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  {summarizeCriteria(item.criteria)}
                </p>
                {item.last_matched_at && (
                  <p style={{ margin: '0.375rem 0 0', fontSize: 11, color: 'var(--fg-dim)' }}>
                    Last match: {new Date(item.last_matched_at).toLocaleString()}
                  </p>
                )}
              </div>

              {/* Notify toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={item.notify}
                  aria-label={`Push notifications for ${item.name}`}
                  disabled={busy}
                  onClick={() => handleToggleNotify(item.id, !item.notify)}
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    border: 'none',
                    cursor: busy ? 'wait' : 'pointer',
                    background: item.notify ? 'var(--accent)' : 'var(--border)',
                    position: 'relative',
                    transition: 'background 0.15s',
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: item.notify ? 22 : 2,
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background: '#fff',
                      transition: 'left 0.15s',
                    }}
                  />
                </button>
                <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
                  {item.notify ? 'Alerts on' : 'Muted'}
                </span>
              </div>
            </div>

            {errMsg && (
              <p
                style={{
                  margin: '0.5rem 0 0',
                  fontSize: 12,
                  color: 'var(--danger)',
                }}
              >
                {errMsg}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: '0.75rem' }}>
              <a
                href={buildBrowseHref(item.criteria)}
                style={{
                  flex: 1,
                  padding: '0.6rem',
                  background: 'var(--accent)',
                  color: '#000',
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: 'none',
                  textAlign: 'center',
                  display: 'block',
                }}
              >
                Browse matches
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDelete(item.id, item.name)}
                style={{
                  padding: '0.6rem 1rem',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  color: 'var(--danger)',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? 'wait' : 'pointer',
                  minWidth: 72,
                }}
              >
                {deletingId === item.id ? '…' : 'Delete'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
