import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('LotIdentity typography', () => {
  it('uses the body font variable for operational codes', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/console-v2/LotIdentity.tsx'), 'utf8');
    expect(src).toContain("fontFamily: 'var(--console-body)'");
    expect(src).not.toContain('var(--console-font-mono)');
    expect(src).not.toContain('var(--console-font-display)');
  });
});
