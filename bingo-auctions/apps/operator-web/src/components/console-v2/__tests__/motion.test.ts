import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOTION_STAGGER_CAP,
  MOTION_STAGGER_MS,
  cappedMotionIndex,
  motionDelayMs,
  revealMotion,
  revealStyle,
  rowMotion,
} from '../motion';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const v2 = css.slice(css.indexOf('/* ─── Console v2 · Floor Ledger design tokens'));

function token(name: string): string | undefined {
  return v2.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
}

describe('cappedMotionIndex / motionDelayMs', () => {
  it('steps 40ms for the first 12 items, then adds no delay', () => {
    const delays = Array.from({ length: 15 }, (_, i) => motionDelayMs(i));
    expect(delays).toEqual([0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 440, 440, 440, 440]);
    expect(cappedMotionIndex(500)).toBe(MOTION_STAGGER_CAP - 1);
  });

  it('treats negative, fractional and non-finite indices safely', () => {
    expect(cappedMotionIndex(-3)).toBe(0);
    expect(cappedMotionIndex(Number.NaN)).toBe(0);
    expect(cappedMotionIndex(Number.POSITIVE_INFINITY)).toBe(0);
    expect(cappedMotionIndex(2.9)).toBe(2);
  });
});

describe('rowMotion / revealMotion', () => {
  it('row props carry the row-in + lift classes and the capped index', () => {
    expect(rowMotion(3)).toEqual({
      className: 'console-v2-motion-row-in console-v2-motion-lift',
      style: { '--console-row-index': 3 },
    });
    expect(rowMotion(40).style).toEqual({ '--console-row-index': MOTION_STAGGER_CAP - 1 });
  });

  it('reveal props carry the reveal class and the capped index', () => {
    expect(revealMotion(2)).toEqual({
      className: 'console-v2-motion-reveal',
      style: { '--console-reveal-index': 2 },
    });
    expect(revealStyle(99)).toEqual({ '--console-reveal-index': MOTION_STAGGER_CAP - 1 });
  });

  it('reduced motion: no entry class, no delay, final state', () => {
    expect(rowMotion(7, { reducedMotion: true })).toEqual({
      className: 'console-v2-motion-lift',
      style: {},
    });
    expect(revealMotion(7, { reducedMotion: true })).toEqual({ className: '', style: {} });
    expect(motionDelayMs(7, { reducedMotion: true })).toBe(0);
  });
});

describe('motion tokens in globals.css', () => {
  it('match the helper (one source of truth for stagger + cap)', () => {
    expect(token('--console-stagger')).toBe(`${MOTION_STAGGER_MS}ms`);
    expect(token('--console-stagger-max-index')).toBe(String(MOTION_STAGGER_CAP - 1));
    expect(token('--console-duration-fast')).toBe('150ms');
    expect(token('--console-duration-base')).toBe('200ms');
    expect(token('--console-duration-slow')).toBe('300ms');
    expect(token('--console-duration-pulse')).toBe('600ms');
    expect(token('--console-ease-spring')).toBe('cubic-bezier(0.34, 1.3, 0.64, 1)');
    expect(token('--console-press-scale')).toBe('0.97');
  });

  it('the motion block clamps every stagger in CSS too', () => {
    const block = v2.slice(v2.indexOf('/* ── v2 motion START'), v2.indexOf('/* ── v2 motion END'));
    expect(block).toContain('min(var(--console-row-index, 0), var(--console-stagger-max-index))');
    expect(block).toContain('min(var(--console-reveal-index, 0), var(--console-stagger-max-index))');
    // Pulse runs exactly once; no other animation in the block loops.
    expect(block).toMatch(/console-v2-pulse var\(--console-duration-pulse\)[^;]* 1 /);
    expect(block).not.toMatch(/infinite/);
    // Only opacity/transform animate: no hard-coded durations in the block.
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\d+m?s\b/);
  });

  it('the only infinite animation in v2 is the aria-busy spinner', () => {
    const infinite = [...v2.matchAll(/^([^{}\n]+)\{[^}]*infinite[^}]*\}/gm)].map((m) => m[1]!.trim());
    expect(infinite).toEqual([
      "[data-console-v2] .console-v2-btn[aria-busy='true'] .console-v2-btn__spinner",
    ]);
  });

  it('reduced motion kills animation, transition and every transform on the root and descendants', () => {
    const at = v2.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const rm = v2.slice(at, v2.indexOf('\n}\n', at));
    expect(rm).toMatch(/\[data-console-v2\],\s*\[data-console-v2\] \*,/);
    for (const decl of [
      'animation: none !important',
      'transition: none !important',
      'transform: none !important',
      'translate: none !important',
      'scale: none !important',
      '--console-stagger: 0ms',
    ]) {
      expect(rm).toContain(decl);
    }
  });
});

describe('v2 TSX uses the motion helper, not literals', () => {
  const roots = [
    'src/components/console-v2',
    'src/app/(operator)/dashboard/v2',
    'src/app/(operator)/pickups/v2',
    'src/app/(operator)/lots/[id]/v2',
    'src/app/(operator)/lotting/inventory/v2',
    'src/app/(operator)/design-system',
  ];
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
      return full.endsWith('.tsx') ? [full] : [];
    });
  }
  const files = roots.flatMap((r) => walk(join(process.cwd(), r)));

  it('no inline animationDelay or hand-set row/reveal index', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/animationDelay/);
      expect(src, f).not.toMatch(/'--console-(row|reveal)-index'/);
    }
  });
});
