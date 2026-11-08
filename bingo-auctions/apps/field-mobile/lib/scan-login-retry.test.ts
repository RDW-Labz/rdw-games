import { describe, expect, it, vi } from 'vitest';
import { callWithLoginRetry, isStaleLoginError } from './scan-login-retry';

describe('isStaleLoginError', () => {
  it('recognises an expired staff JWT', () => {
    expect(isStaleLoginError({ message: 'JWT expired', code: 'PGRST301' })).toBe(true);
    expect(isStaleLoginError({ message: 'JWT expired' })).toBe(true);
    expect(isStaleLoginError({ code: 'PGRST303' })).toBe(true);
  });
  it('does not treat other failures as a login problem', () => {
    expect(isStaleLoginError(null)).toBe(false);
    expect(isStaleLoginError({ message: 'Network request failed' })).toBe(false);
    expect(isStaleLoginError({ message: 'permission denied for table pickups' })).toBe(false);
  });
});

describe('callWithLoginRetry', () => {
  it('passes a good result straight through without refreshing', async () => {
    const call = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    const refresh = vi.fn();
    const r = await callWithLoginRetry(call, refresh);
    expect(r).toMatchObject({ data: { ok: true }, loginExpired: false, retried: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes once and retries when the staff JWT is stale (the 10-13 floor case)', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'JWT expired', code: 'PGRST301' } })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    const refresh = vi.fn().mockResolvedValue('new-token');
    const r = await callWithLoginRetry(call, refresh);
    expect(r).toMatchObject({ data: { ok: true }, error: null, loginExpired: false, retried: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports loginExpired when the session cannot be refreshed', async () => {
    const call = vi.fn().mockResolvedValue({ data: null, error: { message: 'JWT expired' } });
    const r = await callWithLoginRetry(call, vi.fn().mockResolvedValue(null));
    expect(r.loginExpired).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not retry ordinary errors', async () => {
    const call = vi.fn().mockResolvedValue({ data: null, error: { message: 'Network request failed' } });
    const refresh = vi.fn();
    const r = await callWithLoginRetry(call, refresh);
    expect(r).toMatchObject({ loginExpired: false, retried: false });
    expect(refresh).not.toHaveBeenCalled();
  });
});
