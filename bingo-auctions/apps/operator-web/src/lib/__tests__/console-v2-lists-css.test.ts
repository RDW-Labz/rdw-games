// v2 lists block (Braden 2026-10-13: lists keep the v1 table, v2 skin).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const START = '/* ── v2 lists START ──';
const END = '/* ── v2 lists END ── */';
const block = css.slice(css.indexOf(START), css.indexOf(END) + END.length);
const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');

describe('v2 lists CSS block', () => {
  it('exists once, immediately before the v2 shell block', () => {
    expect(css.split(START).length).toBe(2);
    expect(css.split(END).length).toBe(2);
    const after = css.slice(css.indexOf(END) + END.length).trimStart();
    expect(after.startsWith('/* ── v2 shell START ── */')).toBe(true);
  });

  it('scopes every selector to [data-console-v2]', () => {
    const selectors = rules
      .replace(/@media[^{]+\{/g, '')
      .split('}')
      .map((chunk) => chunk.split('{')[0]!.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(10);
    for (const group of selectors) {
      for (const sel of group.split(',')) expect(sel.trim()).toMatch(/^\[data-console-v2\]/);
    }
  });

  it('never caps heights and never hides overflow (the Clone menu must open freely)', () => {
    expect(rules).not.toMatch(/max-height/);
    expect(rules).not.toMatch(/overflow:\s*(hidden|auto|scroll)/);
  });

  it('uses no colour literals: tokens only', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
