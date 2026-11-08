import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HEX_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/;

function listFilesRecursive(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFilesRecursive(p, acc);
    else if (/\.(tsx?|css)$/.test(name)) acc.push(p);
  }
  return acc;
}

function extractConsoleVars(text: string): Set<string> {
  const vars = new Set<string>();
  const re = /var\((--console-[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]?.split(',')[0]?.trim();
    if (name) vars.add(name);
  }
  return vars;
}

function extractDefinedConsoleVars(css: string): Set<string> {
  const defined = new Set<string>();
  const re = /(--console-[\w-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (m[1]) defined.add(m[1]);
  }
  return defined;
}

describe('console v2 token coverage', () => {
  it('every var(--console-*) used in gallery/components is defined in globals.css', () => {
    const root = process.cwd();
    const globals = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
    const defined = extractDefinedConsoleVars(globals);

    const dirs = [
      join(root, 'src/components/console-v2'),
      join(root, 'src/app/(operator)/design-system'),
    ];

    const used = new Set<string>();
    for (const dir of dirs) {
      for (const file of listFilesRecursive(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const v of extractConsoleVars(text)) used.add(v);
      }
    }

    const missing = [...used].filter((v) => !defined.has(v));
    expect(missing).toEqual([]);
  });

  it('no hex or rgba colour literals in console-v2 components (tokens only)', () => {
    const root = join(process.cwd(), 'src/components/console-v2');
    const offenders: string[] = [];
    for (const file of listFilesRecursive(root)) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (HEX_RE.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('primitive modules stay free of hex/rgb literals', () => {
    const root = join(process.cwd(), 'src/components/console-v2');
    const primitiveNames = [
      'Button.tsx',
      'Chip.tsx',
      'Tabs.tsx',
      'Card.tsx',
      'SectionHeader.tsx',
    ];
    const offenders: string[] = [];
    for (const name of primitiveNames) {
      const file = join(root, name);
      const text = readFileSync(file, 'utf8');
      if (HEX_RE.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
