'use client';

// Lightbox — full-screen image overlay for LotTR thumbnails.
//
// Usage:
//   const lb = useLightbox();
//   <img src={url} onClick={() => lb.open([url1, url2, url3], 0)} />
//   <Lightbox state={lb.state} onClose={lb.close} />
//
// Design:
//   - Fixed overlay above all content, darkened backdrop (z-index 9999)
//   - Click backdrop or × button to close, Escape key also closes
//   - Multi-image swipe via prev/next buttons + arrow keys
//   - Image uses object-fit:contain so portrait/landscape both display
//     without crop
//   - No external deps — pure React + inline styles to match the rest
//     of operator-web (it doesn't use a CSS-in-JS lib)

import { useCallback, useEffect, useState } from 'react';
import { nextPhotoAttempt, photoSourceChain } from '@auction-platform/shared';

export type LightboxState = {
  open: boolean;
  urls: string[];
  index: number;
};

const CLOSED: LightboxState = { open: false, urls: [], index: 0 };

export function useLightbox(): {
  state: LightboxState;
  open: (urls: string[], index?: number) => void;
  close: () => void;
} {
  const [state, setState] = useState<LightboxState>(CLOSED);
  return {
    state,
    open: useCallback((urls: string[], index = 0) => {
      const cleaned = urls.filter((u) => typeof u === 'string' && u.trim().length > 0);
      if (cleaned.length === 0) return;
      const safeIdx = Math.max(0, Math.min(index, cleaned.length - 1));
      setState({ open: true, urls: cleaned, index: safeIdx });
    }, []),
    close: useCallback(() => setState(CLOSED), []),
  };
}

export function Lightbox({
  state,
  onClose,
}: {
  state: LightboxState;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(state.index);

  // Sync internal index when state.index changes (e.g. opening to a new image).
  useEffect(() => {
    if (state.open) setIndex(state.index);
  }, [state.open, state.index]);

  // Keyboard nav: Escape to close, Arrow keys to navigate.
  useEffect(() => {
    if (!state.open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        setIndex((i) => Math.min(state.urls.length - 1, i + 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open, state.urls.length, onClose]);

  if (!state.open) return null;
  const url = state.urls[index];
  if (!url) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.92)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <LightboxImage url={url} />

      {/* Close button — visible on backdrop */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 40,
          height: 40,
          borderRadius: 20,
          background: 'rgba(255,255,255,0.15)',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          fontSize: 20,
          lineHeight: 1,
        }}
      >
        ×
      </button>

      {state.urls.length > 1 && (
        <>
          <button
            type="button"
            disabled={index === 0}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.max(0, i - 1));
            }}
            aria-label="Previous"
            style={navBtnStyle('left', index === 0)}
          >
            ‹
          </button>
          <button
            type="button"
            disabled={index === state.urls.length - 1}
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.min(state.urls.length - 1, i + 1));
            }}
            aria-label="Next"
            style={navBtnStyle('right', index === state.urls.length - 1)}
          >
            ›
          </button>
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              fontFamily: 'monospace',
              padding: '4px 12px',
              background: 'rgba(0,0,0,0.5)',
              borderRadius: 12,
            }}
          >
            {index + 1} / {state.urls.length}
          </div>
        </>
      )}
    </div>
  );
}

// One full-screen image with a bounded fallback: the untransformed original
// (a Supabase render URL is mapped back to its object), then a text
// placeholder instead of the browser's broken-image glyph. Each source is
// tried once and the attempt restarts when the URL changes, so paging to the
// next photo after a failure still loads it.
function LightboxImage({ url }: { url: string }) {
  const chain = photoSourceChain(url);
  const [tried, setTried] = useState({ url, attempt: 0 });
  const attempt = tried.url === url ? tried.attempt : 0;
  const current = chain[attempt];
  if (!current) {
    return (
      <div
        role="img"
        aria-label="Photo unavailable"
        onClick={(e) => e.stopPropagation()}
        style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, cursor: 'default' }}
      >
        Photo unavailable
      </div>
    );
  }
  return (
    <img
      src={current}
      alt=""
      onClick={(e) => e.stopPropagation()}
      onError={() => setTried({ url, attempt: nextPhotoAttempt(attempt, chain.length) })}
      style={{
        maxWidth: '92vw',
        maxHeight: '92vh',
        objectFit: 'contain',
        cursor: 'default',
      }}
    />
  );
}

function navBtnStyle(side: 'left' | 'right', disabled: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 16,
    transform: 'translateY(-50%)',
    width: 48,
    height: 48,
    borderRadius: 24,
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    border: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.3 : 1,
    fontSize: 28,
    lineHeight: 1,
  };
}
