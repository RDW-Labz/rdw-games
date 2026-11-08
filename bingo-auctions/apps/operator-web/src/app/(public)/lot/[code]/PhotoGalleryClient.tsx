'use client';

// Interactive lot photo gallery (owner ask, 2026-07-06: "pictures seem like
// they should be clickable"). Replaces the static server-rendered gallery:
//   - thumbnails (ALL photos, not just the first 5) swap the main image
//   - clicking the main image opens a full-screen lightbox
//   - lightbox: ‹/› arrows, keyboard (arrows + Esc), click-outside to close
// Uses SafeImg so dead hotlinked URLs still fall back to the placeholder.

import { useCallback, useEffect, useState } from 'react';
import { SafeImg } from '../../_components/SafeImg';

export function PhotoGalleryClient({ photos, title }: { photos: string[]; title: string }) {
  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState(false);

  const count = photos.length;
  const prev = useCallback(() => setActive((i) => (i - 1 + count) % count), [count]);
  const next = useCallback(() => setActive((i) => (i + 1) % count), [count]);

  // Keyboard nav while the lightbox is open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false);
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, prev, next]);

  if (count === 0) {
    return (
      <div
        style={{
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          aspectRatio: '1 / 1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--fg-dim)',
          fontSize: 14,
        }}
      >
        No photos
      </div>
    );
  }

  const main = photos[active] ?? photos[0]!;

  return (
    <div>
      <button
        type="button"
        onClick={() => setLightbox(true)}
        aria-label="View photo full screen"
        style={{
          display: 'block',
          width: '100%',
          padding: 0,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
          aspectRatio: '1 / 1',
          cursor: 'zoom-in',
        }}
      >
        <SafeImg
          src={main}
          alt={title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </button>

      {count > 1 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
            gap: 8,
            marginTop: 8,
          }}
        >
          {photos.map((url, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Photo ${i + 1} of ${count}`}
              style={{
                padding: 0,
                background: 'var(--bg-elev-2)',
                border: i === active ? '2px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'hidden',
                aspectRatio: '1 / 1',
                cursor: 'pointer',
                opacity: i === active ? 1 : 0.75,
              }}
            >
              <SafeImg
                src={url}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </button>
          ))}
        </div>
      )}

      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${title} photos`}
          onClick={() => setLightbox(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            background: 'rgba(8, 10, 14, 0.92)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2.5rem 1rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: 'min(1100px, 96vw)',
              maxHeight: '90vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SafeImg
              src={main}
              alt={title}
              style={{
                maxWidth: '100%',
                maxHeight: '88vh',
                objectFit: 'contain',
                display: 'block',
                borderRadius: 8,
              }}
            />
            {count > 1 && (
              <>
                <LightboxNavButton side="left" label="Previous photo" onClick={prev} />
                <LightboxNavButton side="right" label="Next photo" onClick={next} />
                <div
                  style={{
                    position: 'absolute',
                    bottom: -32,
                    left: 0,
                    right: 0,
                    textAlign: 'center',
                    color: 'rgba(255,255,255,0.75)',
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {active + 1} / {count}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setLightbox(false)}
            style={{
              position: 'fixed',
              top: 16,
              right: 16,
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.12)',
              border: 'none',
              color: '#fff',
              fontSize: 20,
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function LightboxNavButton({
  side,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        position: 'absolute',
        [side]: -8,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.14)',
        border: 'none',
        color: '#fff',
        fontSize: 22,
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  );
}
