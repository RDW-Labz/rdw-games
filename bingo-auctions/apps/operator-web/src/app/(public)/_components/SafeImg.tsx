'use client';

// Safe image renderers for the public storefront (2026-07-05).
//
// ~99% of catalog photos are hotlinked from retail CDNs (Wayfair, Amazon,
// legacy S3) by the AI enrichment pipeline. All probed alive today, but any
// individual URL can rot or start hotlink-blocking — and when one does, the
// browser paints a broken-image glyph. These wrappers fall back to the
// branded no-photo placeholder instead, and send no Referer so hotlink
// filters keyed on referrer never trigger.

import Image from 'next/image';
import { useState } from 'react';
import { nextPhotoAttempt, photoSourceChain } from '@auction-platform/shared';
import { cdnImageUrl } from '@/lib/img-proxy';

const FALLBACK = '/art/photo/no-photo.webp';

/**
 * Plain <img> with dead-URL fallback — for the lot detail gallery and its
 * full-screen lightbox. Tries the edge-cached /img proxy path, then the
 * original object URL (a proxy miss is short-cached as a 404, so the direct
 * object can still load), then the placeholder. Each step is tried once; the
 * attempt only moves forward, and restarts when `src` changes (the gallery
 * reuses one SafeImg for the main photo as the bidder switches photos).
 */
export function SafeImg({
  src,
  alt,
  style,
}: {
  src: string;
  alt: string;
  style?: React.CSSProperties;
}) {
  const chain = photoSourceChain(src, cdnImageUrl(src));
  const [tried, setTried] = useState({ src, attempt: 0 });
  const attempt = tried.src === src ? tried.attempt : 0;
  const current = chain[attempt];
  return (
    <img
      src={current ?? FALLBACK}
      alt={current ? alt : 'No photo available'}
      style={style}
      referrerPolicy="no-referrer"
      onError={() => {
        // The placeholder is a bundled asset; never advance past it.
        if (!current) return;
        setTried({ src, attempt: nextPhotoAttempt(attempt, chain.length) });
      }}
    />
  );
}

/** next/image fill variant with the same fallback — for LotCard. */
export function SafeLotImage({
  src,
  alt,
  sizes,
}: {
  src: string;
  alt: string;
  sizes: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <img
        src={FALLBACK}
        alt="No photo available"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />
    );
  }
  return (
    <Image
      src={cdnImageUrl(src)}
      alt={alt}
      fill
      sizes={sizes}
      style={{ objectFit: 'cover' }}
      referrerPolicy="no-referrer"
      // Next's optimizer is unavailable on Cloudflare Workers — see LotCard.
      unoptimized
      onError={() => setFailed(true)}
    />
  );
}
