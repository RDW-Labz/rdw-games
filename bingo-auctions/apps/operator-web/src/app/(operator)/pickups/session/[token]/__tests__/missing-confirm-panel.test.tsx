// #849 RED TEAM follow-up: the rendered confirmation panel caps the typed note
// by the remaining budget after the selected reason, and it never submits a
// composed note the server would reject for length.

import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('../actions', () => ({ setLotOutcome: vi.fn() }));

import { renderToString } from 'react-dom/server';
import type { SessionItem } from '@/lib/pickup-session';
import { MISSING_NOTE_MAX, MISSING_QUICK_REASONS, missingNoteBudget } from '../missing-confirm';
import { MissingConfirmPanel } from '../SessionItems';

const ITEM = {
  lotId: 'lot-1',
  displayCode: 'LOT-1',
  binCode: '3-09-01',
  warehouseName: 'Harrison',
} as unknown as SessionItem;

function render(reason: string | null, note: string) {
  return renderToString(
    <MissingConfirmPanel
      item={ITEM}
      reason={reason}
      note={note}
      busy={false}
      error={null}
      onReason={() => {}}
      onNote={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  ).replace(/<!-- -->/g, '');
}

function maxLength(html: string): number | null {
  const m =
    html.match(/<input[^>]*maxLength="(\d+)"/) ?? html.match(/<input[^>]*maxlength="(\d+)"/);
  return m ? Number(m[1]) : null;
}

function confirmButton(html: string): string {
  const m = html.match(/<button[^>]*>Confirm missing<\/button>/);
  return m?.[0] ?? '';
}

describe('MissingConfirmPanel note budget (#849 RED TEAM follow-up)', () => {
  it('caps typed-only notes at the server limit', () => {
    const html = render(null, '');
    expect(maxLength(html)).toBe(MISSING_NOTE_MAX);
    expect(confirmButton(html)).not.toMatch(/disabled/);
    expect(html).not.toMatch(/role="alert"/);
  });

  it('caps the input at the remaining budget for each quick reason', () => {
    for (const reason of MISSING_QUICK_REASONS) {
      const budget = missingNoteBudget(reason);
      const html = render(reason, 'x'.repeat(budget));
      expect(maxLength(html), reason).toBe(budget);
      expect(confirmButton(html), reason).not.toMatch(/disabled/);
      expect(html).toContain(`${budget} characters available`);
      expect(html).toContain(reason);
    }
  });

  it('blocks a composed note over 500 and explains the budget', () => {
    const reason = MISSING_QUICK_REASONS[0];
    const budget = missingNoteBudget(reason);
    const html = render(reason, 'x'.repeat(budget + 1));
    expect(confirmButton(html)).toMatch(/disabled/);
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain(`Shorten it to ${budget}`);
    // The extra character is never silently dropped from the rendered value.
    const value = html.match(/<input[^>]*value="(x+)"/)?.[1] ?? '';
    expect(value.length).toBe(budget + 1);
  });

  it('accepts a blank note with a reason and shows the current bin', () => {
    const html = render(MISSING_QUICK_REASONS[1], '');
    expect(confirmButton(html)).not.toMatch(/disabled/);
    expect(html).toContain('3-09-01');
    expect(html).toContain('Harrison');
    expect(html).toMatch(/Current bin/);
  });

  it('says plainly when no bin is recorded', () => {
    const item = { ...ITEM, binCode: null, warehouseName: 'Harrison' } as unknown as SessionItem;
    const html = renderToString(
      <MissingConfirmPanel
        item={item}
        reason={null}
        note=""
        busy={false}
        error={null}
        onReason={() => {}}
        onNote={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    ).replace(/<!-- -->/g, '');
    expect(html).toMatch(/No bin recorded/);
    expect(html).not.toContain('Harrison');
  });
});
