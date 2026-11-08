'use client';

// Task #139 — lot detail photo gallery.
//
// Renders the full photo_urls array for a lot:
//   - 0 photos  → renders nothing (existing behaviour preserved)
//   - 1 photo   → hero only, no thumbnail strip
//   - 2+ photos → hero on top, horizontal thumbnail strip below; clicking
//                 a thumbnail swaps the hero to that photo.
//
// Uses unoptimized on all Images — the BinGo lotting-images-prod S3 host is
// not in next.config remotePatterns (consistent with PhotoEditor and the
// existing cover photo render that was here before).

import { useState } from 'react';
import Image from 'next/image';

export function PhotoGallery({
  photoUrls,
  lotTitle,
}: {
  photoUrls: string[];
  lotTitle: string;
}) {
  const [activeIdx, setActiveIdx] = useState(0);

  if (photoUrls.length === 0) return null;

  const activeSrc = photoUrls[activeIdx] ?? photoUrls[0]!;
  const total = photoUrls.length;

  return (
    <div style={{ marginTop: '1rem', maxWidth: 400 }}>
      {/* Hero */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '4 / 3',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
        }}
      >
        <Image
          src={activeSrc}
          alt={`${lotTitle} — photo ${activeIdx + 1} of ${total}`}
          fill
          style={{ objectFit: 'contain' }}
          sizes="(max-width: 800px) 100vw, 400px"
          unoptimized
        />
      </div>

      {/* Thumbnail strip — only rendered when there are 2 or more photos */}
      {total > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 8,
            overflowX: 'auto',
            paddingBottom: 4,
          }}
          role="list"
          aria-label="Photo thumbnails"
        >
          {photoUrls.map((url, idx) => {
            const isActive = idx === activeIdx;
            return (
              <button
                key={url}
                type="button"
                role="listitem"
                onClick={() => setActiveIdx(idx)}
                aria-label={`View photo ${idx + 1} of ${total}`}
                aria-pressed={isActive}
                style={{
                  flexShrink: 0,
                  width: 80,
                  height: 80,
                  padding: 0,
                  border: isActive
                    ? '2px solid var(--accent, #4f8cff)'
                    : '2px solid var(--border)',
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: 'var(--bg-elev)',
                  cursor: isActive ? 'default' : 'pointer',
                  position: 'relative',
                  display: 'block',
                }}
              >
                <Image
                  src={url}
                  alt={`${lotTitle} — thumbnail ${idx + 1}`}
                  width={80}
                  height={80}
                  style={{ objectFit: 'cover', display: 'block' }}
                  unoptimized
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
