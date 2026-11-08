'use client';

import { useCallback, useState } from 'react';
import { thumbUrl } from '@/lib/thumb-url';

// Same thumbnail behaviour as v1 InventoryTable's ThumbImg (60px, thumbUrl's
// small variant, lazy + async decode, one fallback to the original URL).
export function InventoryThumb({ src, alt }: { src: string; alt: string }) {
  const initial = thumbUrl(src) ?? src;
  const [current, setCurrent] = useState(initial);
  const onError = useCallback(() => {
    setCurrent((c) => (c === src ? c : src));
  }, [src]);
  return (
    // plain <img>, as v1: opennextjs has known edge cases with <Image> over CF resizing
    <img
      src={current}
      alt={alt}
      width={60}
      height={60}
      loading="lazy"
      decoding="async"
      onError={onError}
      className="console-v2-list-thumb console-v2-list-thumb--lot"
    />
  );
}
