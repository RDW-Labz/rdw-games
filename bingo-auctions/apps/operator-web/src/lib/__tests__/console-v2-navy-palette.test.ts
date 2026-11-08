import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Braden 2026-10-13: palette A (navy) replaced the violet base.
describe('console v2 navy palette', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const marker = '/* ─── Console v2 · Floor Ledger design tokens';
  const v2 = css.slice(css.indexOf(marker));
  const open = v2.indexOf('[data-console-v2] {');
  const tokenBlock = v2.slice(open, v2.indexOf('\n}\n', open));

  const tokens = new Map<string, string>();
  for (const [, name, value] of tokenBlock.matchAll(/(--console-[\w-]+):\s*([^;]+);/g)) {
    if (name && value) tokens.set(name, value.trim());
  }

  it('finds the token block', () => {
    expect(open).toBeGreaterThan(0);
    expect(tokens.size).toBeGreaterThan(50);
  });

  it('uses the navy surface, border and shadow values', () => {
    expect(tokens.get('--console-bg')).toBe('#0b1020');
    expect(tokens.get('--console-surface')).toBe('#151d33');
    expect(tokens.get('--console-surface-rail')).toBe('#151d33');
    expect(tokens.get('--console-surface-raised')).toBe('#1f2a45');
    expect(tokens.get('--console-surface-hover')).toBe('#283553');
    expect(tokens.get('--console-surface-glass')).toBe('#18213a');
    expect(tokens.get('--console-border')).toBe('#3c4c6e');
    expect(tokens.get('--console-line')).toBe('#3c4c6e');
    expect(tokens.get('--console-shadow-ink')).toBe('#04060d');
    expect(tokens.get('--console-code-bg')).toBe('#111a2e');
  });

  it('keeps lime primary and off-white ink', () => {
    expect(tokens.get('--console-action')).toBe('#c8fa7a');
    expect(tokens.get('--console-ink')).toBe('#e6e0ee');
  });

  it('has no old violet hex anywhere in the v2 CSS', () => {
    const old = [
      '#120d1c', '#2b1f3b', '#443157', '#523c6b', '#352843', '#655577', '#322345',
      '#1b1327', '#3c2d52', '#241b32', '#08050f', '#a599b8', '#bfb3cf', '#453454',
    ];
    const lower = v2.toLowerCase();
    for (const hex of old) expect(lower, hex).not.toContain(hex);
  });

  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const lin = (i: number) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it('keeps every text token at AA (4.5:1) on every navy surface', () => {
    const surfaces = [
      '--console-bg', '--console-surface', '--console-surface-raised', '--console-surface-hover',
      '--console-surface-glass', '--console-code-bg', '--console-violet-bg', '--console-neutral-bg',
    ];
    const texts = [
      '--console-ink', '--console-ink-secondary', '--console-ink-muted', '--console-link',
      '--console-violet-fg', '--console-neutral', '--console-action', '--console-warning',
      '--console-danger', '--console-success',
    ];
    for (const s of surfaces) {
      for (const t of texts) {
        const r = ratio(tokens.get(t)!, tokens.get(s)!);
        expect(r, `${t} on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps status pill text at AA on its own fill', () => {
    const pairs = [...tokens.keys()]
      .filter((k) => /^--console-status-[\w-]+-fg$/.test(k))
      .map((fg) => [fg, fg.replace(/-fg$/, '-bg')] as const);
    expect(pairs.length).toBeGreaterThan(8);
    const resolve = (k: string): string => {
      const v = tokens.get(k)!;
      const ref = /^var\((--console-[\w-]+)\)$/.exec(v);
      return ref?.[1] ? resolve(ref[1]) : v;
    };
    for (const [fg, bg] of pairs) {
      const r = ratio(resolve(fg), resolve(bg));
      expect(r, `${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Scheduled / Sold pills are neutral grey (Braden 2026-10-13)', () => {
  it('uses the neutral grey text, not lavender/orchid', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
    for (const t of ['--console-status-scheduled-fg', '--console-status-sold-fg']) {
      const m = css.match(new RegExp(`${t}:\\s*(#[0-9a-fA-F]{6})`));
      expect(m?.[1]?.toLowerCase(), t).toBe('#d3d8e2');
    }
    expect(css.toLowerCase()).not.toContain('#dbcbf7');
    expect(css.toLowerCase()).not.toContain('#e2c5ef');
  });
});
