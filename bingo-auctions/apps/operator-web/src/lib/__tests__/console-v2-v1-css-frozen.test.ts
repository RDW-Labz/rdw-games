// Console v2 ships behind the ?ui=v2 toggle. With it off, the live console must
// render exactly as before, so everything in globals.css ahead of the v2 block
// is frozen byte-for-byte, and the v2 block may only target [data-console-v2].
// (Stage B review caught `.op-shell` — the live v1 wrapper — in the v2 selectors.)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const V2_MARKER = '/* ─── Console v2 · Floor Ledger design tokens';
// sha256 of globals.css before console v2 (trailing newlines trimmed).
const V1_SHA256 = '512121e43b583a7ac05c2fd4b5b347e683194e6f31a3798eb7534fe26c506687';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const at = css.indexOf(V2_MARKER);

export function stripCssComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Pulls every `@keyframes name { … }` from a CSS string (brace-balanced). */
export function extractKeyframes(block: string): { stripped: string; names: string[] } {
  const names: string[] = [];
  let stripped = '';
  let i = 0;
  while (i < block.length) {
    const tail = block.slice(i);
    const head = tail.match(/^@keyframes\s+([^\s{]+)\s*\{/);
    if (head) {
      names.push(head[1]!);
      let depth = 0;
      let j = i + head[0]!.length - 1;
      for (; j < block.length; j++) {
        const ch = block[j];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      i = j;
      continue;
    }
    stripped += block[i];
    i++;
  }
  return { stripped, names };
}

export function listV2RuleSelectors(v2Block: string): string[] {
  const withoutComments = stripCssComments(v2Block);
  const { stripped } = extractKeyframes(withoutComments);
  return [...stripped.matchAll(/([^{};]+)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((s) => s && !s.startsWith('@'));
}

export function assertV2ScopedSelectors(v2Block: string): void {
  const selectors = listV2RuleSelectors(v2Block);
  expect(selectors.length).toBeGreaterThan(0);
  for (const group of selectors) {
    for (const sel of group.split(',')) {
      expect(sel.trim(), `unscoped v2 selector: ${sel.trim()}`).toMatch(/^\[data-console-v2\]/);
    }
  }
}

export function assertV2KeyframeNames(v2Block: string): void {
  const { names } = extractKeyframes(stripCssComments(v2Block));
  for (const name of names) {
    expect(name, `v2 keyframes must be prefixed: ${name}`).toMatch(/^console-v2-/);
  }
}

describe('console v2 leaves v1 CSS untouched', () => {
  it('has the v2 block appended once', () => {
    expect(at).toBeGreaterThan(0);
    expect(css.indexOf(V2_MARKER, at + 1)).toBe(-1);
  });

  it('keeps every byte before the v2 block', () => {
    const v1 = css.slice(0, at).replace(/\n+$/, '');
    expect(createHash('sha256').update(v1, 'utf8').digest('hex')).toBe(V1_SHA256);
  });

  it('scopes every v2 rule to [data-console-v2] and prefixes v2 keyframes', () => {
    const block = css.slice(at);
    assertV2KeyframeNames(block);
    assertV2ScopedSelectors(block);
  });

  it('rejects unprefixed @keyframes in the v2 block', () => {
    const sample = `
[data-console-v2] { color: red; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
    const { names } = extractKeyframes(stripCssComments(sample));
    expect(names).toContain('spin');
    expect(names.some((n) => !n.startsWith('console-v2-'))).toBe(true);
    expect(() => {
      for (const name of names) {
        if (!name.startsWith('console-v2-')) {
          throw new Error(`unprefixed keyframes: ${name}`);
        }
      }
    }).toThrow(/unprefixed keyframes/);
  });

  it('still rejects unscoped selectors when keyframes are present', () => {
    const sample = `
@keyframes console-v2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.op-shell { color: red; }
`;
    expect(() => assertV2ScopedSelectors(sample)).toThrow(/unscoped v2 selector/);
  });
});
