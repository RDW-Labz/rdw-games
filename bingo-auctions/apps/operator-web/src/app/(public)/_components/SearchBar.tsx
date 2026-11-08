'use client';

/**
 * SearchBar — global lot/category search for the public header.
 *
 * Behaviour:
 *   - On Enter: navigate to /browse?q={query} for SSR text search.
 *   - On change (debounced 200ms): fetch /api/search/suggest?q={query}&limit=8
 *     and render a positioned dropdown with category + lot suggestions.
 *   - Click outside / Esc: close the suggestion dropdown.
 *
 * Styling: uses CSS custom properties matching the dark theme in globals.css.
 * No external dependencies.
 */

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestCategory {
  slug: string;
  name: string;
  icon_url: string | null;
}

interface SuggestLot {
  lot_code: string;
  title: string;
  photo_url: string | null;
}

interface SuggestResponse {
  categories: SuggestCategory[];
  lots: SuggestLot[];
}

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ── Component ─────────────────────────────────────────────────────────────────

function SearchBarInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 2026-07-05 bidder-QoL: reflect the ACTIVE search from the URL so the box
  // isn't mysteriously empty on /browse?q=grill — and so the ✕ below has
  // something visible to clear.
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [suggestions, setSuggestions] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when the URL's q changes underneath us (chip
  // removal, back/forward, new search from elsewhere).
  useEffect(() => {
    setQuery(urlQuery);
    setDropdownOpen(false);
  }, [urlQuery]);

  const handleClear = useCallback(() => {
    setQuery('');
    setSuggestions(null);
    setDropdownOpen(false);
    inputRef.current?.focus();
    // If a search is actively filtering the page, clearing the box also
    // clears the results — drop q (and stale pagination), keep other filters.
    if (searchParams.get('q')) {
      const qs = new URLSearchParams(searchParams.toString());
      qs.delete('q');
      qs.delete('page');
      const suffix = qs.toString();
      router.push(suffix ? `${pathname}?${suffix}` : pathname);
    }
  }, [pathname, router, searchParams]);

  const debouncedQuery = useDebounce(query, 200);

  // Fetch suggestions whenever debounced query changes
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) {
      setSuggestions(null);
      setDropdownOpen(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch(`/api/search/suggest?q=${encodeURIComponent(trimmed)}&limit=8`)
      .then((res) => {
        if (!res.ok) throw new Error('suggest failed');
        return res.json() as Promise<SuggestResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setSuggestions(data);
        const hasResults = data.categories.length > 0 || data.lots.length > 0;
        setDropdownOpen(hasResults);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSuggestions(null);
        setDropdownOpen(false);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // Close on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    function onPointer(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointer, true);
    return () => document.removeEventListener('mousedown', onPointer, true);
  }, [dropdownOpen]);

  // Close on Esc
  useEffect(() => {
    if (!dropdownOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDropdownOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dropdownOpen]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;
      setDropdownOpen(false);
      // Already browsing? Merge the search into the current filters instead
      // of wiping them (page resets — new result set).
      if (pathname === '/browse') {
        const qs = new URLSearchParams(searchParams.toString());
        qs.set('q', trimmed);
        qs.delete('page');
        router.push(`/browse?${qs.toString()}`);
        return;
      }
      router.push(`/browse?q=${encodeURIComponent(trimmed)}`);
    },
    [query, router, pathname, searchParams],
  );

  const handleResultClick = useCallback(() => {
    setDropdownOpen(false);
    setQuery('');
  }, []);

  const hasCategories = (suggestions?.categories.length ?? 0) > 0;
  const hasLots = (suggestions?.lots.length ?? 0) > 0;
  const hasAny = hasCategories || hasLots;

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', flex: 1, minWidth: 0, maxWidth: 480 }}
    >
      <form onSubmit={handleSubmit} role="search" aria-label="Search lots and categories">
        <div style={{ position: 'relative' }}>
          {/* Search icon */}
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: '0.75rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--fg-muted)',
              fontSize: 14,
              pointerEvents: 'none',
              lineHeight: 1,
            }}
          >
            &#128269;
          </span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length < 2) {
                setDropdownOpen(false);
              }
            }}
            onFocus={() => {
              if (suggestions && (hasCategories || hasLots)) {
                setDropdownOpen(true);
              }
            }}
            placeholder="Search lots, categories..."
            aria-label="Search lots and categories"
            aria-autocomplete="list"
            aria-expanded={dropdownOpen}
            aria-owns="search-suggestions"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              color: 'var(--fg)',
              fontSize: 13,
              fontWeight: 500,
              padding: '0.45rem 2.25rem 0.45rem 2.25rem',
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.12s ease',
            }}
            onFocusCapture={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'var(--accent)';
            }}
            onBlurCapture={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'var(--border)';
            }}
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              title="Clear search"
              style={{
                position: 'absolute',
                right: '0.35rem',
                top: '50%',
                transform: 'translateY(-50%)',
                width: 24,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                borderRadius: '50%',
                color: 'var(--fg-muted)',
                fontSize: 13,
                fontWeight: 800,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          )}
          {loading && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                right: query.length > 0 ? '2rem' : '0.8rem',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--fg-dim)',
                fontSize: 11,
              }}
            >
              ...
            </span>
          )}
        </div>
      </form>

      {/* Suggestion dropdown */}
      {dropdownOpen && hasAny && (
        <div
          id="search-suggestions"
          role="listbox"
          aria-label="Search suggestions"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            background: 'var(--bg-elev-2, #13161e)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            zIndex: 200,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
          }}
        >
          {/* Categories section */}
          {hasCategories && (
            <section>
              <div style={sectionHeaderStyle}>Categories</div>
              {suggestions!.categories.map((cat) => (
                <Link
                  key={cat.slug}
                  href={`/category/${cat.slug}`}
                  role="option"
                  aria-selected={false}
                  onClick={handleResultClick}
                  style={resultRowStyle}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background =
                      'var(--bg-elev)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                  }}
                >
                  {cat.icon_url && (
                    <img
                      src={cat.icon_url}
                      alt=""
                      width={18}
                      height={18}
                      style={{ objectFit: 'contain', flexShrink: 0, opacity: 0.8 }}
                    />
                  )}
                  <span style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600 }}>
                    {cat.name}
                  </span>
                </Link>
              ))}
            </section>
          )}

          {/* Lots section */}
          {hasLots && (
            <section style={{ borderTop: hasCategories ? '1px solid var(--border)' : undefined }}>
              <div style={sectionHeaderStyle}>Lots</div>
              {suggestions!.lots.map((lot) => (
                <Link
                  key={lot.lot_code}
                  href={`/lot/${lot.lot_code}`}
                  role="option"
                  aria-selected={false}
                  onClick={handleResultClick}
                  style={resultRowStyle}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background =
                      'var(--bg-elev)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                  }}
                >
                  {lot.photo_url && (
                    <img
                      src={lot.photo_url}
                      alt=""
                      width={36}
                      height={36}
                      style={{
                        objectFit: 'cover',
                        flexShrink: 0,
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                      }}
                    />
                  )}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13,
                        color: 'var(--fg)',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {lot.title}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--fg-muted)',
                        marginTop: 1,
                      }}
                    >
                      {lot.lot_code}
                    </span>
                  </span>
                </Link>
              ))}
            </section>
          )}

          {/* View all results footer */}
          <div
            style={{
              borderTop: '1px solid var(--border)',
              padding: '0.6rem 1rem',
              textAlign: 'right',
            }}
          >
            <Link
              href={`/browse?q=${encodeURIComponent(query.trim())}`}
              onClick={handleResultClick}
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--accent)',
                textDecoration: 'none',
              }}
            >
              View all results for &ldquo;{query.trim()}&rdquo; &rarr;
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// Suspense boundary: useSearchParams() in a client component requires one so
// static prerender doesn't bail. Fallback mirrors the input's footprint so
// the header doesn't jump during hydration.
export function SearchBar() {
  return (
    <Suspense
      fallback={
        <div style={{ position: 'relative', flex: 1, minWidth: 0, maxWidth: 480 }}>
          <input
            type="search"
            disabled
            placeholder="Search lots, categories..."
            aria-label="Search lots and categories"
            style={{
              width: '100%',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              color: 'var(--fg)',
              fontSize: 13,
              fontWeight: 500,
              padding: '0.45rem 2.25rem 0.45rem 2.25rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      }
    >
      <SearchBarInner />
    </Suspense>
  );
}

// ── Shared micro-styles ───────────────────────────────────────────────────────

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  padding: '0.65rem 1rem 0.35rem',
};

const resultRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0.55rem 1rem',
  textDecoration: 'none',
  background: 'transparent',
  transition: 'background 0.1s ease',
  cursor: 'pointer',
};
