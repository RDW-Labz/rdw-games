// #849 RED TEAM follow-up: a failed or rejected outcome save must always
// release the saving lock, surface a message and roll the optimistic state
// back. Keeping this in one place makes every outcome button share the same
// cleanup path instead of relying on the component's `await` completing.

export type OutcomeValue = 'collected' | 'missing' | 'left_behind' | null;

export type OutcomeSaveResponse = { ok: boolean; error?: string };

export type OutcomeSaveHandlers = {
  /** Optimistic value to show while the write is in flight. */
  next: OutcomeValue;
  /** Server value to restore if the write fails. */
  previous: OutcomeValue;
  submit: () => Promise<OutcomeSaveResponse>;
  setOutcome: (value: OutcomeValue) => void;
  setSaving: (value: boolean) => void;
  setError: (message: string | null) => void;
  /** Called only after an accepted write; the draft is kept on failure. */
  onSaved: () => void;
};

/**
 * Runs one outcome write and guarantees `setSaving(false)` in every branch.
 * Returns whether the write was accepted so callers can retry the same draft.
 */
export async function runOutcomeSave({
  next,
  previous,
  submit,
  setOutcome,
  setSaving,
  setError,
  onSaved,
}: OutcomeSaveHandlers): Promise<boolean> {
  setError(null);
  setOutcome(next);
  setSaving(true);
  try {
    const res = await submit();
    if (!res.ok) {
      setOutcome(previous);
      setError(res.error ?? 'Save failed');
      return false;
    }
    onSaved();
    return true;
  } catch {
    setOutcome(previous);
    setError('Save failed — check the connection and try again.');
    return false;
  } finally {
    setSaving(false);
  }
}
