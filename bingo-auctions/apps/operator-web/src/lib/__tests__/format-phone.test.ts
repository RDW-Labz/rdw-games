import { describe, expect, it } from 'vitest';
import { formatUsPhone } from '../format-phone';

describe('formatUsPhone', () => {
  it('formats 10 digits', () => {
    expect(formatUsPhone('8705775971')).toBe('(870) 577-5971');
    expect(formatUsPhone('870-577-5971')).toBe('(870) 577-5971');
  });

  it('drops a leading 1 (with or without +)', () => {
    expect(formatUsPhone('18705775971')).toBe('(870) 577-5971');
    expect(formatUsPhone('+18174011953')).toBe('(817) 401-1953');
  });

  it('shows the raw value when it is not 10 digits', () => {
    expect(formatUsPhone('5775971')).toBe('5775971');
    expect(formatUsPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatUsPhone('28705775971')).toBe('28705775971');
  });

  it('returns null for empty values', () => {
    expect(formatUsPhone(null)).toBeNull();
    expect(formatUsPhone(undefined)).toBeNull();
    expect(formatUsPhone('  ')).toBeNull();
  });
});
