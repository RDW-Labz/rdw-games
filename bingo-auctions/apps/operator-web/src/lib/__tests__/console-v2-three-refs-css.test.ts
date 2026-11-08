// v2 three-refs block (ART-DIRECTION.md "Three refs", 2026-10-13): shadcn
// structure, analytics warmth, hud accents used sparingly. These primitives are
// CSS only; this test pins their placement, scope and the rules Braden locked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const START = '/* ── v2 three-refs START ──';
const END = '/* ── v2 three-refs END ── */';
const MOTION_END = '/* ── v2 motion END ── */';

const startAt = css.indexOf(START);
const endAt = css.indexOf(END);
const block = css.slice(startAt, endAt + END.length);

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Selector groups of every style rule (at-rule preludes and keyframe stops excluded). */
function selectorGroups(s: string): string[] {
  return [...stripComments(s).matchAll(/([^{};]+)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((sel) => sel && !sel.startsWith('@') && !/^(from|to|\d+%)$/.test(sel));
}

function splitSelectors(group: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of group) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function rule(selector: string): string {
  const body = stripComments(block);
  const at = body.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf('}', at));
}

function token(name: string): string | undefined {
  return stripComments(block).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.replace(/\s+/g, ' ').trim();
}

describe('console v2 three-refs CSS', () => {
  // Order since #485: motion, then type scale, then three-refs.
  it('is one delimited block placed right after the type-scale block (which follows motion)', () => {
    const TYPE_END = '/* ── v2 type scale END ── */';
    expect(startAt).toBeGreaterThan(-1);
    expect(css.indexOf(START, startAt + 1)).toBe(-1);
    expect(endAt).toBeGreaterThan(startAt);
    const typeEnd = css.indexOf(TYPE_END);
    expect(typeEnd).toBeGreaterThan(css.indexOf(MOTION_END));
    expect(css.slice(typeEnd + TYPE_END.length, startAt).trim()).toBe('');
  });

  it('scopes every selector to [data-console-v2]; root classes use the compound form too', () => {
    const groups = selectorGroups(block);
    expect(groups.length).toBeGreaterThan(15);
    for (const g of groups) {
      for (const sel of splitSelectors(g)) {
        expect(sel, `unscoped: ${sel}`).toMatch(/^\[data-console-v2\]/);
      }
    }
    for (const cls of ['console-v2-refs-page', 'console-v2-texture-grid']) {
      expect(block).toContain(`[data-console-v2].${cls}`);
      expect(block).toContain(`[data-console-v2] .${cls}`);
    }
  });

  it('defines every token it uses on the [data-console-v2] root', () => {
    const defined = new Set([...css.matchAll(/(--console-[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...stripComments(block).matchAll(/var\((--console-[\w-]+)/g)].map((m) => m[1]);
    // The bracket ink is a local prop set on the bracket element itself.
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it('cards are 16px with a soft elevation token', () => {
    expect(token('--console-radius-card')).toBe('var(--console-radius-panel)');
    expect(css).toMatch(/--console-radius-panel:\s*16px;/);
    expect(token('--console-elevation-soft')).toBeTruthy();
    expect(rule('[data-console-v2] .console-v2-card-soft')).toContain('box-shadow: var(--console-elevation-soft)');
  });

  it('mono-style label is Atkinson (body font), uppercase, tracked and small', () => {
    expect(token('--console-label-mono-family')).toBe('var(--console-font-body)');
    const r = rule('[data-console-v2] .console-v2-label-mono');
    expect(r).toContain('text-transform: uppercase');
    expect(r).toContain('letter-spacing: var(--console-label-mono-tracking)');
    expect(r).toContain('font-size: var(--console-label-mono-size)');
    expect(token('--console-label-mono-size')).toBe('0.75rem');
    expect(block).not.toMatch(/monospace|ui-monospace|Menlo|Consolas/);
  });

  it('bracket frame draws on ::before (the pulse owns ::after) in the stage hue', () => {
    expect(block).toContain('[data-console-v2] .console-v2-frame-bracket::before {');
    expect(block).not.toContain('.console-v2-frame-bracket::after');
    expect(rule('[data-console-v2] .console-v2-frame-bracket')).toContain(
      'var(--console-stage-accent-fg, var(--console-bracket-color))',
    );
    expect(rule('[data-console-v2] .console-v2-frame-bracket::before')).toContain('pointer-events: none');
  });

  it('grid texture is ~3% opacity and background-image only', () => {
    expect(token('--console-texture-grid-line')).toBe('color-mix(in srgb, var(--console-neutral) 3%, transparent)');
    const r = rule('[data-console-v2] .console-v2-texture-grid');
    expect(r).toContain('background-image: var(--console-texture-grid), var(--console-gradient-frame)');
    expect(r).not.toMatch(/content:|position:/);
  });

  it('segmented control fills the selected option lime; focus ring is lime', () => {
    expect(block).toContain(".console-v2-segmented__option[aria-pressed='true']");
    expect(block).toContain(".console-v2-segmented__option[aria-current='page']");
    expect(block).toMatch(/aria-selected='true'\] \{\s*background: var\(--console-gradient-primary\);/);
    expect(rule('[data-console-v2] .console-v2-segmented__option:focus-visible')).toContain('var(--console-action)');
    expect(rule('[data-console-v2] .console-v2-segmented__option')).toContain('min-height: var(--console-control-min)');
    expect(token('--console-focus')).toBe('var(--console-action)');
  });

  it('area-chart gradient tokens fade lime to transparent', () => {
    expect(token('--console-chart-area-stroke')).toBe('var(--console-action)');
    expect(token('--console-chart-area-top')).toContain('var(--console-action)');
    expect(token('--console-chart-area-bottom')).toContain('0%, transparent');
    expect(token('--console-chart-area-gradient')).toContain('linear-gradient(');
  });

  it('scan-line: once, opacity/transform only, ends invisible, only when motion is allowed', () => {
    const body = stripComments(block);
    expect(rule('[data-console-v2] .console-v2-scanline')).toContain('display: none');
    const media = body.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(media).toBeGreaterThan(-1);
    expect(body.indexOf('animation: console-v2-scan', media)).toBeGreaterThan(media);
    expect(body.match(/animation: console-v2-scan[^;]*;/g)).toEqual([
      'animation: console-v2-scan var(--console-duration-scan) var(--console-ease-scan) 1 both;',
    ]);
    const kf = body.slice(body.indexOf('@keyframes console-v2-scan'));
    const props = new Set([...kf.matchAll(/([a-z-]+):/g)].map((m) => m[1]));
    expect([...props].sort()).toEqual(['opacity', 'transform']);
    expect(kf).toMatch(/100% \{\s*opacity: 0;/);
    expect(rule('[data-console-v2] .console-v2-scanline::before')).toContain('opacity: 0');
    // The block must not be the first reduced-motion: reduce media in v2 (motion test reads that one).
    expect(body).not.toContain('prefers-reduced-motion: reduce');
  });

  it('keeps every keyframe console-v2-*, nothing loops, nothing caps height', () => {
    const body = stripComments(block);
    for (const m of body.matchAll(/@keyframes ([\w-]+)/g)) expect(m[1]).toMatch(/^console-v2-/);
    expect(body).not.toMatch(/infinite/);
    expect(body).not.toMatch(/max-height/);
  });

  it('adds no colour literals and no cyan / violet / lavender', () => {
    const body = stripComments(block);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(block.toLowerCase()).not.toMatch(/cyan|violet|lavender|purple/);
  });

  it('live chip dot is static (no animation on the chip)', () => {
    expect(rule('[data-console-v2] .console-v2-live-chip')).not.toContain('animation');
    expect(rule('[data-console-v2] .console-v2-live-chip__dot')).not.toContain('animation');
  });
});
