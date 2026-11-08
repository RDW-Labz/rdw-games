// v2 button skin (re-skins v1 action components embedded in v2 pages). The
// skin must live entirely under [data-console-v2]; with the toggle off nothing
// may reach those v1 components.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const START = '/* ── v2 button skin START ──';
const END = '/* ── v2 button skin END ── */';
const V2_MARKER = '/* ─── Console v2 · Floor Ledger design tokens';
const ANCHOR = '[data-console-v2] .console-v2-btn--danger {';

const startAt = css.indexOf(START);
const endAt = css.indexOf(END);
const block = css.slice(startAt, endAt + END.length);

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Selector groups of every style rule (at-rule preludes excluded). */
function selectorGroups(s: string): string[] {
  return [...stripComments(s).matchAll(/([^{};]+)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((sel) => sel && !sel.startsWith('@'));
}

/** Top-level comma split (ignores commas inside parentheses). */
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

// Host hooks the skin targets. None of them may be styled outside v2.
const HOSTS = [
  'console-v2-pickups-actions-host',
  'console-v2-pickups-missing-host',
  'console-v2-pickups-pass-row',
  'console-v2-pickups-customer-search',
  'console-v2-pickups-warehouse-form',
  'console-v2-lot-action-body',
];

describe('console v2 button skin CSS', () => {
  it('is one delimited block inside the v2 section, right after the danger button rule', () => {
    expect(startAt).toBeGreaterThan(css.indexOf(V2_MARKER));
    expect(css.indexOf(START, startAt + 1)).toBe(-1);
    expect(endAt).toBeGreaterThan(startAt);
    const anchorAt = css.indexOf(ANCHOR);
    const anchorClose = css.indexOf('}\n', anchorAt);
    expect(css.slice(anchorClose + 2, startAt).trim()).toBe('');
  });

  it('scopes every selector in the block to [data-console-v2]', () => {
    const groups = selectorGroups(block);
    expect(groups.length).toBeGreaterThan(10);
    for (const g of groups) {
      for (const sel of splitSelectors(g)) {
        expect(sel, `unscoped: ${sel}`).toMatch(/^\[data-console-v2\]/);
      }
    }
  });

  it('never targets the skinned hosts or their v1 components outside [data-console-v2]', () => {
    for (const g of selectorGroups(css)) {
      for (const sel of splitSelectors(g)) {
        if (HOSTS.some((h) => sel.includes(h)) || /data-action=/.test(sel)) {
          expect(sel, `host targeted outside v2: ${sel}`).toMatch(/^\[data-console-v2\]/);
        }
      }
    }
    const v1 = css.slice(0, css.indexOf(V2_MARKER));
    for (const h of HOSTS) expect(v1).not.toContain(h);
  });

  it('uses !important only on properties the v1 inline style objects set', () => {
    const allowed = new Set([
      'padding',
      'background',
      'color',
      'border',
      'border-color',
      'border-radius',
      'font-size',
      'font-weight',
      'opacity',
      'cursor',
      'text-decoration',
    ]);
    const decls = [...stripComments(block).matchAll(/([a-z-]+)\s*:[^;{}]*!important/g)].map((m) => m[1]!);
    expect(decls.length).toBeGreaterThan(0);
    for (const prop of decls) expect(allowed.has(prop), prop).toBe(true);
  });

  it('puts press feedback only behind prefers-reduced-motion: no-preference', () => {
    const body = stripComments(block);
    const scale = [...body.matchAll(/transform:\s*scale\(0\.97\)/g)];
    expect(scale.length).toBeGreaterThan(0);
    const media = [...body.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{/g)];
    expect(media.length).toBe(scale.length);
    for (const m of scale) {
      const before = body.lastIndexOf('@media', m.index);
      expect(body.slice(before, before + 46)).toContain('prefers-reduced-motion: no-preference');
    }
  });

  it('keeps disabled controls off lime: the disabled rule resets fill, ink and edge', () => {
    const body = stripComments(block);
    const disabled = /button:disabled \{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(disabled).toContain('background: var(--console-surface-raised) !important');
    expect(disabled).toContain('color: var(--console-ink-secondary) !important');
    expect(disabled).toContain('box-shadow: none');
  });
});
