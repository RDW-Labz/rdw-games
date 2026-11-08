// v2 button skin: the v1 lot actions render unchanged inside the v2 decision
// hosts, and each host carries the data-action key the scoped CSS targets.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('../../actions', () => ({
  cancelLot: vi.fn(),
  deleteLot: vi.fn(),
  keepLotForBusiness: vi.fn(),
  relistLot: vi.fn(),
  removeLotFromInventory: vi.fn(),
  editLot: vi.fn(),
}));

import { renderToString } from 'react-dom/server';
import { LotDetailV2 } from '../LotDetailV2';
import { lotDetailWithV1Actions } from '../__fixtures__/lot-detail-actions-fixture';

const html = renderToString(<LotDetailV2 {...lotDetailWithV1Actions} />).replace(/<!-- -->/g, '');
const KEYS = ['relist', 'remove', 'keep', 'cancel', 'delete'] as const;

/** The markup inside one decision host (up to the next host or the stack end). */
function hostHtml(key: (typeof KEYS)[number]): string {
  const start = html.indexOf(`data-action="${key}"`);
  expect(start, `host ${key}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', start);
  const next = html.indexOf('data-action="', start + 1);
  return html.slice(open, next === -1 ? html.indexOf('</section>', start) : next);
}

function buttons(fragment: string): Array<{ attrs: string; label: string }> {
  return [...fragment.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1] ?? '',
    label: (m[2] ?? '').replace(/<[^>]+>/g, '').trim(),
  }));
}

describe('LotDetailV2 · v1 actions under the v2 button skin', () => {
  it('wraps every decision in a .console-v2-lot-action-body host keyed by data-action', () => {
    const keys = [...html.matchAll(/class="console-v2-lot-action-body[^"]*" data-action="([a-z]+)"/g)].map(
      (m) => m[1],
    );
    expect(keys).toEqual([...KEYS]);
    expect(hostHtml('relist')).toContain('console-v2-lot-action-body--primary');
  });

  it('keeps the v1 labels, one button each, in their hosts', () => {
    expect(buttons(hostHtml('relist')).map((b) => b.label)).toEqual(['Relist']);
    expect(buttons(hostHtml('remove')).map((b) => b.label)).toEqual(['Remove from inventory']);
    expect(buttons(hostHtml('keep')).map((b) => b.label)).toEqual(['Keep for business']);
    expect(buttons(hostHtml('cancel')).map((b) => b.label)).toEqual(['Cancel lot']);
    expect(buttons(hostHtml('delete')).map((b) => b.label)).toEqual(['Delete']);
  });

  it('keeps the v1 markup the skin selectors rely on', () => {
    // Relist: the auction <select> sits beside the button.
    expect(hostHtml('relist')).toMatch(/<select[\s\S]*<\/select><button/);
    // Remove / Cancel / Delete closed state: the button is the host's direct child.
    for (const key of ['remove', 'cancel', 'delete'] as const) {
      expect(hostHtml(key), key).toMatch(/data-action="[a-z]+"[^>]*><button/);
    }
    // The skin never changes disabled logic: Relist with a target is enabled.
    expect(buttons(hostHtml('relist'))[0]!.attrs).not.toMatch(/disabled/);
  });

  it('puts no v2 button classes onto the v1 buttons (CSS-only skin)', () => {
    for (const key of KEYS) {
      for (const b of buttons(hostHtml(key))) {
        expect(b.attrs, `${key}: ${b.label}`).not.toMatch(/console-v2-btn/);
      }
    }
  });
});
