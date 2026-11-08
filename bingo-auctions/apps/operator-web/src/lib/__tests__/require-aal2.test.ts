// Unit tests for requireAAL2ForAdmin — the AAL2/MFA gate reused by sensitive
// /api/* mutations (refund-items, refund, staff/[id], staff/invite). This is
// the auth-bypass surface flagged as untested in the 2026-06-06 platform audit
// (CHK-04). The highest-value coverage is the BEARER path added for the mobile
// + staff clients: a sessionless bearer client makes
// supabase.auth.mfa.getAuthenticatorAssuranceLevel() return currentLevel=null,
// so the code must decode the `aal` claim from the already-validated JWT
// instead. The original bug: that null was read directly and wrongly 403'd an
// admin who genuinely authenticated at aal2.

import { describe, it, expect, vi } from 'vitest';
import { requireAAL2ForAdmin } from '../require-aal2';

const VERIFIED_TOTP = [{ factor_type: 'totp', status: 'verified' }];

// Build a structurally valid JWT (header.payload.signature). Only the payload
// matters — requireAAL2ForAdmin decodes it WITHOUT verifying the signature
// (it runs only after supabase.auth.getUser() has already validated the token).
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

type MockOpts = {
  user?: { id: string } | null;
  role?: string | null;
  factors?: Array<{ factor_type: string; status: string }>;
  currentLevel?: string | null;
};

// Minimal SupabaseClient stub covering exactly the calls the function makes:
// auth.getUser, from('operator_users').select().eq().maybeSingle(),
// auth.mfa.listFactors, auth.mfa.getAuthenticatorAssuranceLevel.
function mockSupabase(opts: MockOpts = {}) {
  const { user = { id: 'user-1' }, role = null, factors = [], currentLevel = null } = opts;
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: factors } }),
        getAuthenticatorAssuranceLevel: vi
          .fn()
          .mockResolvedValue({ data: { currentLevel } }),
      },
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi
            .fn()
            .mockResolvedValue({ data: role === null ? null : { role } }),
        }),
      }),
    }),
    // cast through unknown — the stub intentionally implements only the surface
    // requireAAL2ForAdmin touches.
  } as unknown as Parameters<typeof requireAAL2ForAdmin>[0];
}

describe('requireAAL2ForAdmin', () => {
  it('401s when not authenticated', async () => {
    const r = await requireAAL2ForAdmin(mockSupabase({ user: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('allows non-admin staff (not MFA-gated)', async () => {
    const r = await requireAAL2ForAdmin(mockSupabase({ role: 'staff' }));
    expect(r.ok).toBe(true);
  });

  it('allows an authenticated user not in operator_users (role null)', async () => {
    const r = await requireAAL2ForAdmin(mockSupabase({ role: null }));
    expect(r.ok).toBe(true);
  });

  it('allows an admin with no verified TOTP (7-day grace period)', async () => {
    const r = await requireAAL2ForAdmin(mockSupabase({ role: 'admin', factors: [] }));
    expect(r.ok).toBe(true);
  });

  it('allows an admin whose only factor is unverified (nothing to step up against)', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({
        role: 'admin',
        factors: [{ factor_type: 'totp', status: 'unverified' }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  // ── Bearer path (mobile / staff app): decode aal from the JWT ──
  it('allows an admin on the bearer path when the JWT aal claim is aal2', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({ role: 'admin', factors: VERIFIED_TOTP }),
      makeJwt({ aal: 'aal2' }),
    );
    expect(r.ok).toBe(true);
  });

  it('403s aal2_required for an admin on the bearer path when the JWT aal claim is aal1', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({ role: 'admin', factors: VERIFIED_TOTP }),
      makeJwt({ aal: 'aal1' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      const body = (await r.response.json()) as { error?: string; step_up_url?: string };
      expect(body.error).toBe('aal2_required');
      expect(body.step_up_url).toBe('/account/security/step-up');
    }
  });

  it('403s when the bearer token is malformed (aal undecodable → not aal2)', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({ role: 'admin', factors: VERIFIED_TOTP }),
      'not-a-jwt',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  // ── REGRESSION: the exact bug CHK-04 fixed ──
  // A sessionless bearer client makes getAuthenticatorAssuranceLevel() return
  // currentLevel=null. The bearer path must trust the JWT, NOT that null — else
  // an admin who genuinely authenticated at aal2 gets wrongly 403'd.
  it('trusts the JWT (not the null session AAL) on the bearer path', async () => {
    const supabase = mockSupabase({
      role: 'admin',
      factors: VERIFIED_TOTP,
      currentLevel: null, // sessionless — reading this would wrongly 403
    });
    const r = await requireAAL2ForAdmin(supabase, makeJwt({ aal: 'aal2' }));
    expect(r.ok).toBe(true);
    // The session-AAL lookup must not even be consulted on the bearer path.
    expect(
      (supabase as unknown as {
        auth: { mfa: { getAuthenticatorAssuranceLevel: ReturnType<typeof vi.fn> } };
      }).auth.mfa.getAuthenticatorAssuranceLevel,
    ).not.toHaveBeenCalled();
  });

  // ── Cookie path (web console): read currentLevel from the stored session ──
  it('allows an admin on the cookie path when currentLevel is aal2', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({ role: 'admin', factors: VERIFIED_TOTP, currentLevel: 'aal2' }),
    );
    expect(r.ok).toBe(true);
  });

  it('403s an admin on the cookie path when currentLevel is aal1', async () => {
    const r = await requireAAL2ForAdmin(
      mockSupabase({ role: 'admin', factors: VERIFIED_TOTP, currentLevel: 'aal1' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
});
