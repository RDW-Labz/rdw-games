import { describe, it, expect } from 'vitest';
import { normaliseUsZip } from '../bidder-postal-code-from-card';

describe('normaliseUsZip', () => {
  it('keeps a 5-digit ZIP and cuts ZIP+4 to 5', () => {
    expect(normaliseUsZip('72701')).toBe('72701');
    expect(normaliseUsZip(' 72701 ', 'US')).toBe('72701');
    expect(normaliseUsZip('72701-1234', 'us')).toBe('72701');
  });

  it('rejects non-US, blank and malformed values', () => {
    for (const v of [undefined, null, 72701, '', '  ', '7270', '727011', '72701-12', '727011234', '72701 1234', 'A1B 2C3']) {
      expect(normaliseUsZip(v)).toBeNull();
    }
    expect(normaliseUsZip('72701', 'CA')).toBeNull();
    expect(normaliseUsZip('72701', 'GB')).toBeNull();
  });
});
