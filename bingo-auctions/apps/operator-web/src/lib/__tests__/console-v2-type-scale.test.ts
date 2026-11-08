import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector in the block starts with [data-console-v2]. */
function assertV2ScopedSelectors(block: string): void {
  const groups = [...stripCssComments(block).matchAll(/([^{};]+)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((sel) => sel && !sel.startsWith('@'));
  expect(groups.length).toBeGreaterThan(0);
  for (const g of groups) {
    for (const sel of g.split(',')) expect(sel.trim(), sel).toMatch(/^\[data-console-v2\]/);
  }
}

// Braden 2026-10-13: words and names were hard to read on Pickups v2. One type
// scale for every v2 page, set in the v2 token block.
describe('console v2 type scale', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const marker = '/* ─── Console v2 · Floor Ledger design tokens';
  const v2 = css.slice(css.indexOf(marker));
  const open = v2.indexOf('[data-console-v2] {');
  const tokenBlock = v2.slice(open, v2.indexOf('\n}\n', open));
  const tokens = new Map<string, string>();
  for (const [, name, value] of tokenBlock.matchAll(/(--console-[\w-]+):\s*([^;]+);/g)) {
    if (name && value) tokens.set(name, value.trim());
  }

  const START = '/* ── v2 type scale START ──';
  const END = '/* ── v2 type scale END ── */';
  const block = css.slice(css.indexOf(START), css.indexOf(END) + END.length);
  const body = stripCssComments(block);

  it('sets the spec sizes as tokens', () => {
    expect(tokens.get('--console-text-name')).toBe('1.125rem'); // 18px customer name
    expect(tokens.get('--console-weight-name')).toBe('600');
    expect(tokens.get('--console-text-code-chip')).toBe('0.9375rem'); // 15px code
    expect(tokens.get('--console-text-code-bin')).toBe('0.75rem'); // 12px BIN line
    expect(tokens.get('--console-text-section-title')).toBe('1.375rem'); // 22px
    expect(tokens.get('--console-text-nav')).toBe('0.9375rem'); // 15px nav items
    expect(tokens.get('--console-text-nav-header')).toBe('0.8125rem'); // headers unchanged
    expect(tokens.get('--console-text-helper')).toBe('0.9375rem'); // 15px helper
    expect(tokens.get('--console-text-button')).toBe('0.9375rem'); // 15px buttons
    expect(tokens.get('--console-text-base')).toBe('0.9375rem'); // 15px body
    expect(tokens.get('--console-text-sm')).toBe('0.9375rem'); // secondary text now 15px
  });

  it('lifts the helper grey one step: #b8c1d6 → #c8d0e1 on all three aliases', () => {
    for (const t of ['--console-ink-secondary', '--console-ink-dim', '--console-ink-muted']) {
      expect(tokens.get(t), t).toBe('#c8d0e1');
    }
    expect(v2.toLowerCase()).not.toContain('#b8c1d6;');
  });

  it('sits right after the motion block, once, with every selector v2-scoped', () => {
    expect(css.indexOf(START)).toBeGreaterThan(0);
    expect(css.indexOf(START, css.indexOf(START) + 1)).toBe(-1);
    const motionEnd = '/* ── v2 motion END ── */\n';
    expect(css.indexOf(motionEnd) + motionEnd.length + 1).toBe(css.indexOf(START));
    assertV2ScopedSelectors(block);
  });

  it('wires each spec item to its token', () => {
    expect(body).toMatch(/\.console-v2-pickups-row-name\.console-v2-pickups-row-name \{[^}]*font-size: var\(--console-text-name\);[^}]*font-weight: var\(--console-weight-name\);/);
    expect(body).toMatch(/\.console-v2-pickups-owed-chip \.console-v2-code \{[^}]*font-size: var\(--console-text-code-chip\) !important;/);
    expect(body).toMatch(/\.console-v2-code \+ \.console-v2-code \{[^}]*font-size: var\(--console-text-code-bin\) !important;/);
    expect(body).toMatch(/\.console-v2-section-header__title\.console-v2-section-header__title \{[^}]*font-size: var\(--console-text-section-title\);/);
    expect(body).toMatch(/\.console-v2-shell__link\.console-v2-shell__link \{[^}]*font-size: var\(--console-text-nav\);/);
    expect(body).toMatch(/\.console-v2-shell__group-toggle\.console-v2-shell__group-toggle \{[^}]*font-size: var\(--console-text-nav-header\);/);
    expect(body).toMatch(/\.console-v2-btn\.console-v2-btn,[^{]*\{[^}]*font-size: var\(--console-text-button\) !important;/);
  });

  it('never caps a height', () => {
    expect(body).not.toMatch(/max-height/);
  });
});
