'use client';

// Prev/next navigation between lots (2026-07-07 customer request: "click into
// an item and have to back out to scroll more"). Rendered only when the lot
// was opened from /browse with a `bctx` context param — the neighbors come
// from the SAME filtered, sorted list the customer was scrolling.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export type BrowseLotNavProps = {
  prevHref: string | null;
  nextHref: string | null;
  /** 1-based position within the filtered result set. */
  position: number;
  total: number;
  backHref: string;
};

const btnStyle = (enabled: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0.45rem 0.9rem',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-elev)',
  color: enabled ? 'var(--fg)' : 'var(--fg-dim)',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
  pointerEvents: enabled ? 'auto' : 'none',
  opacity: enabled ? 1 : 0.5,
});

export function BrowseLotNav({ prevHref, nextHref, position, total, backHref }: BrowseLotNavProps) {
  const router = useRouter();

  // Desktop keyboard shortcuts. Skipped while the user is typing (bid input,
  // search box) so arrows keep their native caret behavior there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft' && prevHref) router.push(prevHref);
      if (e.key === 'ArrowRight' && nextHref) router.push(nextHref);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevHref, nextHref, router]);

  // Touch swipe on the mobile web (owner ask 2026-07-08: "no way to make it
  // feel like it swipes better when in a lot on the phone browser"). Swipe
  // right → Prev, swipe left → Next — mirroring the native app's lot pager.
  // Passive listeners that never preventDefault, so taps and vertical scroll
  // are untouched; we only act on a clear, quick horizontal swipe. Gestures
  // that begin inside a horizontal scroller (photo thumbnails, the similar-
  // lots rail) or while the photo lightbox is open are ignored so we never
  // fight those interactions.
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let tracking = false;

    const startsInHorizontalScroller = (el: HTMLElement | null): boolean => {
      let node: HTMLElement | null = el;
      while (node && node !== document.body) {
        const ox = getComputedStyle(node).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 4) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        startsInHorizontalScroller(target) ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        tracking = false;
        return;
      }
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
      startT = e.timeStamp;
      tracking = true;
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking || e.changedTouches.length !== 1) return;
      tracking = false;
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Decisive, quick, and mostly-horizontal — not a scroll or a slow drag.
      if (e.timeStamp - startT > 800) return;
      if (Math.abs(dx) < 60) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.6) return;
      if (dx > 0 && prevHref) router.push(prevHref);
      else if (dx < 0 && nextHref) router.push(nextHref);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [prevHref, nextHref, router]);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <Link href={prevHref ?? '#'} aria-disabled={!prevHref} style={btnStyle(Boolean(prevHref))}>
          <span aria-hidden>‹</span> Prev
        </Link>
        <Link
          href={backHref}
          style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)', textDecoration: 'none' }}
        >
          {position.toLocaleString('en-US')} of {total.toLocaleString('en-US')} · back to results
        </Link>
        <Link href={nextHref ?? '#'} aria-disabled={!nextHref} style={btnStyle(Boolean(nextHref))}>
          Next <span aria-hidden>›</span>
        </Link>
      </div>
      {/* Discoverability hint — touch devices only (no hover, coarse pointer). */}
      <style>{`
        .browse-lot-swipe-hint { display: none; }
        @media (hover: none) and (pointer: coarse) {
          .browse-lot-swipe-hint { display: block; }
        }
      `}</style>
      <div
        className="browse-lot-swipe-hint"
        style={{
          textAlign: 'center',
          fontSize: 11,
          color: 'var(--fg-dim)',
          marginTop: '-0.5rem',
          marginBottom: '1rem',
        }}
      >
        Swipe left or right to move between lots
      </div>
    </>
  );
}
