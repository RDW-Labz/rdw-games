// #849 RED TEAM follow-up: a rejected or thrown outcome write must release
// the saving lock, restore the previous outcome, keep the draft and leave the
// controls ready for a retry — never freeze the counter row.

import { describe, expect, it, vi } from 'vitest';
import { runOutcomeSave } from '../outcome-save';

function harness(submit: () => Promise<{ ok: boolean; error?: string }>) {
  const events: string[] = [];
  const state = {
    outcome: 'collected' as 'collected' | 'missing' | 'left_behind' | null,
    saving: false,
    error: null as string | null,
    saved: 0,
  };
  const promise = runOutcomeSave({
    next: 'missing',
    previous: 'collected',
    submit,
    setOutcome: (value) => {
      state.outcome = value;
      events.push(`outcome:${value ?? 'null'}`);
    },
    setSaving: (value) => {
      state.saving = value;
      events.push(`saving:${value}`);
    },
    setError: (message) => {
      state.error = message;
      events.push(`error:${message ?? 'null'}`);
    },
    onSaved: () => {
      state.saved += 1;
      events.push('saved');
    },
  });
  return { promise, state, events };
}

describe('runOutcomeSave (#849 RED TEAM follow-up)', () => {
  it('restores the previous outcome and clears the lock when the action rejects', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('network down'));
    const { promise, state, events } = harness(submit);

    expect(events.slice(0, 3)).toEqual(['error:null', 'outcome:missing', 'saving:true']);
    await expect(promise).resolves.toBe(false);

    expect(state.outcome).toBe('collected');
    expect(state.saving).toBe(false);
    expect(state.error).toBe('Save failed — check the connection and try again.');
    expect(state.saved).toBe(0);
    expect(events).toContain('saving:false');
    // The draft is not cleared on failure (onSaved never ran).
    expect(events).not.toContain('saved');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('restores the previous outcome on a structured failure', async () => {
    const { promise, state } = harness(async () => ({ ok: false, error: 'Invalid input' }));
    await expect(promise).resolves.toBe(false);
    expect(state.outcome).toBe('collected');
    expect(state.saving).toBe(false);
    expect(state.error).toBe('Invalid input');
    expect(state.saved).toBe(0);
  });

  it('keeps the controls usable and retries without duplicating the write', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true });

    const { promise, state } = harness(submit);
    await promise;
    expect(state.saving).toBe(false);
    expect(state.outcome).toBe('collected');

    const retry = await runOutcomeSave({
      next: 'missing',
      previous: 'collected',
      submit,
      setOutcome: (value) => (state.outcome = value),
      setSaving: (value) => (state.saving = value),
      setError: (message) => (state.error = message),
      onSaved: () => (state.saved += 1),
    });

    expect(retry).toBe(true);
    expect(state.outcome).toBe('missing');
    expect(state.saving).toBe(false);
    expect(state.error).toBeNull();
    expect(state.saved).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('releases the lock on success and runs the saved callback once', async () => {
    const { promise, state } = harness(async () => ({ ok: true }));
    await expect(promise).resolves.toBe(true);
    expect(state.outcome).toBe('missing');
    expect(state.saving).toBe(false);
    expect(state.error).toBeNull();
    expect(state.saved).toBe(1);
  });
});
