import { describe, expect, it } from 'vitest';
import { decideDraftRecovery } from './draft-recovery';

const saved = {
  editable: { title: 'Lamp' },
  created: { lotId: 'lot-1', lotCode: 'DEV-0001' },
  operatorId: 'op-a',
};

describe('decideDraftRecovery', () => {
  it('does nothing when there is no draft', () => {
    expect(decideDraftRecovery(null, { kind: 'staff', operatorId: 'op-1' })).toEqual({
      action: 'none',
    });
    expect(decideDraftRecovery({ editable: null }, { kind: 'staff', operatorId: 'op-1' })).toEqual({
      action: 'none',
    });
  });

  it('waits instead of giving up while the operator role loads', () => {
    expect(decideDraftRecovery(saved, { kind: 'loading' })).toEqual({ action: 'wait' });
  });

  it('finishes a saved lot once the role resolves to the same operator', () => {
    expect(decideDraftRecovery(saved, { kind: 'staff', operatorId: 'op-a' })).toEqual({
      action: 'finish',
      operatorId: 'op-a',
    });
  });

  it('never uploads a draft under a different operator', () => {
    expect(decideDraftRecovery(saved, { kind: 'staff', operatorId: 'op-b' })).toEqual({
      action: 'blocked',
      reason: 'owner_mismatch',
    });
  });

  it('blocks a legacy draft with no recorded owner instead of guessing', () => {
    expect(
      decideDraftRecovery(
        { editable: { title: 'Lamp' }, created: { lotId: 'lot-1', lotCode: 'DEV-0001' } },
        { kind: 'staff', operatorId: 'op-a' },
      ),
    ).toEqual({ action: 'blocked', reason: 'owner_unknown' });
  });

  it('still offers an unsaved draft while the role loads', () => {
    const draft = { editable: { title: 'Lamp' }, created: null };
    expect(decideDraftRecovery(draft, { kind: 'loading' })).toEqual({ action: 'offer' });
  });
});
