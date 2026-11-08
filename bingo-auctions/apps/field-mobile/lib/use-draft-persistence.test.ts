import { describe, expect, it } from 'vitest';
import { shouldFlushDraft } from './draft-flush';

describe('shouldFlushDraft', () => {
  it('flushes when the app is leaving the foreground', () => {
    expect(shouldFlushDraft('background')).toBe(true);
    expect(shouldFlushDraft('inactive')).toBe(true);
  });
  it('does not flush while active', () => {
    expect(shouldFlushDraft('active')).toBe(false);
  });
});
