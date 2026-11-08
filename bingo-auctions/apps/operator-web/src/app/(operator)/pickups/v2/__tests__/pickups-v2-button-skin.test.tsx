// v2 button skin: PickupsV2 still embeds the v1 pickup actions unchanged,
// inside the host wrappers the scoped CSS targets.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { renderToString } from 'react-dom/server';
import { PickupsV2 } from '../PickupsV2';
import { pickupsV2Fixture } from '../__fixtures__/pickups-fixture';

const html = renderToString(<PickupsV2 {...pickupsV2Fixture} />).replace(/<!-- -->/g, '');

/** Every element opened with `class="…host…"`, sliced to its balanced close. */
function hosts(className: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(div|form) class="[^"]*\\b${className}\\b[^"]*"`, 'g');
  for (const m of html.matchAll(re)) {
    const tag = m[1]!;
    let depth = 0;
    const tagRe = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    tagRe.lastIndex = m.index!;
    let end = html.length;
    for (let t = tagRe.exec(html); t; t = tagRe.exec(html)) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    out.push(html.slice(m.index!, end));
  }
  return out;
}

function buttonLabels(fragment: string): string[] {
  return [...fragment.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, '').trim(),
  );
}

describe('PickupsV2 · v1 actions under the v2 button skin', () => {
  it('keeps Mark complete / No-show / Forfeit, in that order, in every open row host', () => {
    const rowHosts = hosts('console-v2-pickups-actions-host');
    expect(rowHosts.length).toBeGreaterThan(0);
    for (const h of rowHosts) {
      expect(buttonLabels(h)).toEqual(['Mark complete', 'No-show', 'Forfeit']);
    }
  });

  it('keeps the unpaid guard: Mark complete disabled and the Mark paid link', () => {
    const unpaid = hosts('console-v2-pickups-actions-host').filter((h) =>
      h.includes('Not paid — Mark paid (offline) first →'),
    );
    expect(unpaid.length).toBeGreaterThan(0);
    for (const h of unpaid) {
      expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Mark complete<\/button>/);
      expect(h).toMatch(/<a href="\/invoices\/[^"]+"/);
    }
  });

  it('keeps Mark resolved and Refund on invoice in the missing-items host', () => {
    const [missing] = hosts('console-v2-pickups-missing-host');
    expect(missing).toBeDefined();
    const labels = buttonLabels(missing!);
    expect(labels.length).toBe(pickupsV2Fixture.missing.length);
    expect(new Set(labels)).toEqual(new Set(['Mark resolved']));
    expect(missing).toContain('Refund on invoice →');
  });

  it('keeps search, pass toggle and warehouse select in their hosts', () => {
    const [search] = hosts('console-v2-pickups-customer-search');
    expect(search).toMatch(/<input type="search"[^>]*aria-label="Search customers"/);
    const [pass] = hosts('console-v2-pickups-pass-row');
    expect(buttonLabels(pass!)).toEqual([pickupsV2Fixture.sessionsEnabled ? 'Turn off' : 'Turn on']);
    const [form] = hosts('console-v2-pickups-warehouse-form');
    expect(form).toMatch(/<select name="warehouse"[^>]*aria-label="Filter pickups by warehouse"/);
  });

  it('puts no v2 button classes onto the v1 buttons (CSS-only skin)', () => {
    for (const cls of [
      'console-v2-pickups-actions-host',
      'console-v2-pickups-missing-host',
      'console-v2-pickups-pass-row',
    ]) {
      for (const h of hosts(cls)) {
        for (const m of h.matchAll(/<button([^>]*)>/g)) expect(m[1]).not.toMatch(/console-v2-btn/);
      }
    }
  });
});
