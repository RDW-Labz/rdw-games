import { describe, it, expect } from 'vitest';
import {
  MAX_AI_AUTO_RETRIES,
  bumpAutoRetryCount,
  canAutoRetryAi,
  resetAutoRetryCount,
} from './ai-auto-retry';

describe('ai auto-retry cap', () => {
  it('allows two automatic retries then stops', () => {
    let n = resetAutoRetryCount();
    expect(canAutoRetryAi(n)).toBe(true);
    n = bumpAutoRetryCount(n);
    expect(canAutoRetryAi(n)).toBe(true);
    n = bumpAutoRetryCount(n);
    expect(canAutoRetryAi(n)).toBe(false);
    expect(n).toBe(MAX_AI_AUTO_RETRIES);
  });

  it('resets to zero for a new hero or manual retry', () => {
    expect(resetAutoRetryCount()).toBe(0);
    expect(canAutoRetryAi(bumpAutoRetryCount(bumpAutoRetryCount(0)))).toBe(false);
    expect(canAutoRetryAi(resetAutoRetryCount())).toBe(true);
  });
});
