import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { useEffect, useLayoutEffect, useRef } from 'react';

gsap.registerPlugin(CustomEase);
// Drafting-table eases (same curves as the reference): a long, soft settle.
CustomEase.create('joe.in', 'M0,0 C0.8,0 0.8,0.5 1,1');
CustomEase.create('joe.out', 'M0,0 C0.2,0 0.1,1 1,1');
CustomEase.create('joe.inOut', 'M0,0 C0.333,0 0,1 1,1');
gsap.defaults({ ease: 'joe.out', duration: 0.8 });

export { gsap };

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const useIso = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Page-enter choreography. Elements opt in with data attributes:
 *  data-chars   → characters fade in one by one (typewriter on drafting paper)
 *  data-line    → scaleX 0→1 (a ruled line being drawn)
 *  data-rise    → fade + rise
 *  data-hand    → handwritten note: slight rotate + fade
 *  data-pop     → sheet drops onto the table (rotation settles)
 *  data-wipe    → a framed drawing is unrolled from the bottom (clip reveal)
 */
export function useEnter<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);
  useIso(() => {
    const root = ref.current;
    if (!root) return;
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'joe.out', duration: 0.8 } });
      root.querySelectorAll<HTMLElement>('[data-chars]').forEach((el, i) => {
        const chars = el.querySelectorAll('.ch');
        if (chars.length) tl.fromTo(chars, { opacity: 0 }, { opacity: 1, stagger: 0.02, duration: 0.35, ease: 'none' }, 0.05 + i * 0.12);
      });
      const lines = root.querySelectorAll('[data-line]');
      if (lines.length) tl.fromTo(lines, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, ease: 'joe.inOut', stagger: 0.05, duration: 0.6, transformOrigin: 'left center' }, 0.15);
      const hands = root.querySelectorAll('[data-hand]');
      if (hands.length) tl.fromTo(hands, { opacity: 0, y: 6, rotate: (_i, el) => Number((el as HTMLElement).dataset.rot ?? -4) - 6 }, { opacity: 1, y: 0, rotate: (_i, el) => Number((el as HTMLElement).dataset.rot ?? -4), stagger: 0.08, duration: 0.9 }, 0.45);
      const rise = root.querySelectorAll('[data-rise]');
      if (rise.length) tl.fromTo(rise, { opacity: 0, y: 18 }, { opacity: 1, y: 0, stagger: 0.045, duration: 0.9 }, 0.2);
      const wipes = root.querySelectorAll('[data-wipe]');
      if (wipes.length) tl.fromTo(wipes, { clipPath: 'inset(100% 0% 0% 0%)', y: 40 }, { clipPath: 'inset(0% 0% 0% 0%)', y: 0, duration: 1.2, ease: 'joe.inOut', stagger: 0.1, clearProps: 'clipPath' }, 0.15);
      const pops = root.querySelectorAll('[data-pop]');
      if (pops.length) tl.fromTo(pops, { opacity: 0, y: 30, rotate: (_i, el) => Number((el as HTMLElement).dataset.rot ?? 0) - 4 }, { opacity: 1, y: 0, rotate: (_i, el) => Number((el as HTMLElement).dataset.rot ?? 0), stagger: 0.06, duration: 1 }, 0.25);
    }, root);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Reveal children marked [data-reveal] as they scroll into view. */
export function useScrollReveal<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (reducedMotion()) return;
    items.forEach((el) => gsap.set(el, { opacity: 0, y: 22 }));
    const io = new IntersectionObserver(
      (entries) => {
        const batch = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement);
        if (batch.length) gsap.to(batch, { opacity: 1, y: 0, stagger: 0.05, duration: 0.9, ease: 'joe.out' });
        batch.forEach((el) => io.unobserve(el));
      },
      { rootMargin: '0px 0px -8% 0px' }
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Animated number counter (used on stat plates). */
export function useCountUp(value: number, duration = 1.1) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) {
      el.textContent = String(value);
      return;
    }
    const o = { v: 0 };
    const tw = gsap.to(o, { v: value, duration, ease: 'joe.out', delay: 0.25, onUpdate: () => (el.textContent = String(Math.round(o.v))) });
    return () => {
      tw.kill();
    };
  }, [value, duration]);
  return ref;
}
