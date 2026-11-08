import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('console v2 Nightshift token block', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const marker = '/* ─── Console v2 · Floor Ledger design tokens';
  const block = css.slice(css.indexOf(marker));

  it('defines display/body font aliases and motion tokens', () => {
    expect(block).toContain('--console-display:');
    expect(block).toContain('--console-body:');
    expect(block).toContain('--console-duration-fast: 150ms');
    expect(block).toContain('--console-duration-base: 200ms');
    expect(block).toContain('--console-duration-slow: 300ms');
    expect(block).toContain('--console-ease-spring:');
    expect(block).toContain('--console-ease-out:');
    expect(block).toContain('--console-stagger: 40ms');
    expect(block).toContain('--console-duration-pulse: 600ms');
    expect(block).toContain('@keyframes console-v2-row-in');
    expect(block).toContain('@keyframes console-v2-spin');
    expect(block).toContain('.console-v2-motion-row-in');
  });
});
