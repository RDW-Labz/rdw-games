import { describe, expect, it, vi } from 'vitest';
import { GUEST_ESCAPE_FAILED_MESSAGE, escapeToGuest } from '../guest-escape';

describe('escapeToGuest', () => {
  it('reports success when sign-out clears the session', async () => {
    await expect(escapeToGuest(async () => ({ error: null }))).resolves.toEqual({
      ok: true,
    });
    await expect(escapeToGuest(async () => undefined)).resolves.toEqual({
      ok: true,
    });
  });

  it('reports a retryable failure when sign-out RESOLVES with an error', async () => {
    // #825: a network/500 returns `{ error }` without removing the session;
    // navigating then loops through the mandatory finish-profile gate.
    await expect(
      escapeToGuest(async () => ({ error: { message: 'network down' } })),
    ).resolves.toEqual({ ok: false, message: GUEST_ESCAPE_FAILED_MESSAGE });
  });

  it('reports a retryable failure when sign-out throws', async () => {
    await expect(
      escapeToGuest(async () => {
        throw new Error('Failed to fetch');
      }),
    ).resolves.toEqual({ ok: false, message: GUEST_ESCAPE_FAILED_MESSAGE });
  });

  it('reports a retryable failure when the request hangs', async () => {
    const never = new Promise<never>(() => {});
    await expect(escapeToGuest(() => never, 10)).resolves.toEqual({
      ok: false,
      message: GUEST_ESCAPE_FAILED_MESSAGE,
    });
  });

  it('recovers on the next attempt after a failure', async () => {
    const signOut = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: '500' } })
      .mockResolvedValueOnce({ error: null });

    await expect(escapeToGuest(signOut)).resolves.toMatchObject({ ok: false });
    await expect(escapeToGuest(signOut)).resolves.toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
