import type { CSSProperties } from 'react';

/**
 * Console v2 motion helper. The CSS (globals.css, v2 motion block) owns timing:
 * `--console-stagger` (40ms) × `--console-row-index` / `--console-reveal-index`,
 * clamped there too by `--console-stagger-max-index`. This helper hands every
 * v2 list and page the same capped index so a long list never waits:
 * the first {@link MOTION_STAGGER_CAP} items step 40ms apart, every later one
 * shares the last step.
 *
 * Keep these numbers equal to the CSS tokens (a test reads globals.css).
 */
export const MOTION_STAGGER_MS = 40;
/** Items that get their own stagger step. Item 13 onward adds no extra delay. */
export const MOTION_STAGGER_CAP = 12;

export const MOTION_ROW_CLASS = 'console-v2-motion-row-in';
export const MOTION_REVEAL_CLASS = 'console-v2-motion-reveal';
export const MOTION_LIFT_CLASS = 'console-v2-motion-lift';

export type MotionOptions = {
  /** Reduced motion: no motion class, no delay — the item renders in its final state. */
  reducedMotion?: boolean;
};

export type MotionProps = {
  className: string;
  style: CSSProperties;
};

/** Zero-based index clamped to [0, CAP - 1]; anything non-finite or negative is 0. */
export function cappedMotionIndex(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), MOTION_STAGGER_CAP - 1);
}

/** The delay the CSS will apply for this index (0 under reduced motion). */
export function motionDelayMs(index: number, options: MotionOptions = {}): number {
  if (options.reducedMotion) return 0;
  return cappedMotionIndex(index) * MOTION_STAGGER_MS;
}

function indexStyle(property: '--console-row-index' | '--console-reveal-index', index: number): CSSProperties {
  return { [property]: cappedMotionIndex(index) } as CSSProperties;
}

/** Just the reveal-index style, for an element that keeps its own static motion class. */
export function revealStyle(index: number): CSSProperties {
  return indexStyle('--console-reveal-index', index);
}

/**
 * Props for one row of a v2 list: staggered row-in plus the 2px hover lift.
 * Spread `className` into the row's own classes and merge `style`.
 */
export function rowMotion(index: number, options: MotionOptions = {}): MotionProps {
  if (options.reducedMotion) return { className: MOTION_LIFT_CLASS, style: {} };
  return {
    className: `${MOTION_ROW_CLASS} ${MOTION_LIFT_CLASS}`,
    style: indexStyle('--console-row-index', index),
  };
}

/** Props for one page section (or rail card): staggered reveal. */
export function revealMotion(index: number, options: MotionOptions = {}): MotionProps {
  if (options.reducedMotion) return { className: '', style: {} };
  return {
    className: MOTION_REVEAL_CLASS,
    style: indexStyle('--console-reveal-index', index),
  };
}
