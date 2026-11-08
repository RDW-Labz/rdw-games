// Staff invite endpoint. Admin-only.
//
// Two flows — admin picks per invite:
//   A. Magic-link (initialPassword empty, generateInitialPassword=false): server
//      calls supabase.auth.admin.inviteUserByEmail. Tester gets a Supabase
//      email, clicks the link, sets a password, signs in. Three round-
//      trips, vulnerable to spam-filter delivery delays.
//   B. Direct-password (initialPassword provided OR generateInitialPassword=true):
//      server calls supabase.auth.admin.createUser with email_confirm=true + a
//      password. No email round-trip — admin shares the temp password
//      directly (in-person, Slack, SMS) from the one-time card returned in
//      this response. Invited staff is flagged force_password_rotate=TRUE
//      so the next sign-in redirects to /account/rotate-password.
//
// Both flows then INSERT into operator_users with accepted_at=null.
//
// Security:
//   - This route is the ONLY way to add operator staff for a given operator.
//     Direct INSERT into operator_users is gated by RLS.
//   - Admin auth is verified on every call.
//   - Empty/short passwords are rejected by the 12-char minimum below.
//   - LAUNCH_PLAN §1.7: passwords are generated server-side (browser-side
//     generation was the pre-fix pattern). The plaintext is returned inline
//     in the response payload ONCE so the admin can copy it onto a sticky
//     note / Slack DM / SMS, then it's gone. Sentry breadcrumb redaction
//     in sentry.server.config.ts strips fields named `password` / `temp_password`
//     so a copy of this response never lands in error reports.
//   - operator_users.force_password_rotate=TRUE for Flow B → enforced by
//     the operator-console middleware (see middleware.ts) so the new
//     staff member can't continue past first login without rotating.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { operatorCan } from '@/lib/operator-can';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { requireAAL2ForAdmin } from '@/lib/require-aal2';

export const runtime = 'nodejs';

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'manager', 'picker', 'lead']),
  displayName: z.string().max(100).optional(),
  // Two ways to request Flow B:
  //   - `initialPassword: 'somePassword12+'` (admin picked their own)
  //   - `generateInitialPassword: true` (server picks; recommended path)
  // The client used to do its own generation and POST the plaintext over
  // the wire — moved server-side as part of LAUNCH_PLAN §1.7 so the temp
  // password never appears in a network log on the admin's machine.
  initialPassword: z.string().min(12).max(128).optional(),
  generateInitialPassword: z.boolean().optional(),
});

// Server-side password generator. Alphanumeric ONLY (no special characters
// like !@#$%) — those tripped real launch-week incidents: admins shared
// the temp password via Slack/SMS/Teams and the platform auto-formatted
// `#` as a channel link, `@` as a user-mention, `!` as a command prefix.
// The staff member then typed what they saw on their end (mangled) into
// the login form and signInWithPassword rejected it as "Invalid login
// credentials." Plain alphanumerics survive every chat/SMS transport.
//
// We compensate for the smaller alphabet by going from 16→20 chars: 49 ^
// 20 ≈ 5.6×10^33 ≈ 112 bits of entropy (vs. ~90 bits previously) — still
// well above what's needed for a one-shot password before forced rotation.
//
// crypto.getRandomValues is required (Node 19+ / Web Crypto), which the
// runtime='nodejs' export guarantees.
function generateInitialPasswordServer(): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const LEN = 20;
  const bytes = new Uint8Array(LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < LEN; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = inviteSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? 'invalid' },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  const { data: caller } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!caller) return NextResponse.json({ error: 'not_operator_staff' }, { status: 403 });
  if (!(await operatorCan(supabase, 'staff.manage'))) {
    return NextResponse.json({ error: 'admin_only' }, { status: 403 });
  }

  // Audit F-03 (2026-05-18): staff invite must be AAL2-gated. Creating a
  // new admin is at least as sensitive as renaming/deleting one (which
  // already requires AAL2 in /api/staff/[id]). Without this an AAL1 admin
  // session can mint a new admin then walk away.
  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  const admin = getSupabaseAdmin();

  // Block re-invites of someone already linked to ANY operator. Cross-
  // operator collisions return 409 with a distinct error so the UI can
  // tell the admin "this email is on another operator's team, not yours."
  const { data: existing } = await admin
    .from('operator_users')
    .select('id, operator_id')
    .eq('email', body.data.email)
    .maybeSingle();
  if (existing) {
    if (existing.operator_id !== caller.operator_id) {
      return NextResponse.json(
        { error: 'email_belongs_to_another_operator' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'already_staff' }, { status: 409 });
  }

  // Resolve the temp password for Flow B. Three valid inputs:
  //   - initialPassword present and >= 12 → use as-is (admin picked it)
  //   - generateInitialPassword true → server generates a 16-char temp
  //   - neither → fall through to Flow A (magic-link)
  // We don't pre-decide the mode; the next branch checks `resolvedPassword`
  // truthiness.
  const wantsDirect =
    !!body.data.initialPassword ||
    !!body.data.generateInitialPassword;
  const resolvedPassword: string | null = wantsDirect
    ? body.data.initialPassword?.length && body.data.initialPassword.length >= 12
      ? body.data.initialPassword
      : generateInitialPasswordServer()
    : null;

  // Helper: shared response shape for both flows. Surfaces the things
  // the admin needs to hand the new tester so they can actually use
  // the apps — sign-in URL + TestFlight install links — in one card.
  //
  // LAUNCH_PLAN §1.7: the temp password is included ONCE here for Flow B.
  // The Sentry beforeSend filter in sentry.server.config.ts scrubs any
  // field key matching /password/i from event payloads, so even if this
  // route raised after the password generation, the value would never
  // reach Sentry. Client-side, StaffList.tsx shows the password ONLY in
  // the in-memory success card (not persisted to localStorage / cookies)
  // and clears it from state when the card is dismissed.
  const baseOrigin = new URL(req.url).origin;
  const buildSuccessPayload = (extras: Record<string, unknown> = {}) => ({
    ok: true,
    email: body.data.email,
    displayName: body.data.displayName ?? null,
    role: body.data.role,
    operatorWebUrl: `${baseOrigin}/login`,
    // Set these as Vercel env vars (App Store Connect → TestFlight →
    // Public Link). When unset, the UI just doesn't render the row.
    testflightFieldUrl: process.env['TESTFLIGHT_FIELD_URL'] ?? null,
    testflightBidderUrl: process.env['TESTFLIGHT_BIDDER_URL'] ?? null,
    // For Flow B only — a single-display marker the client uses to
    // emphasize "copy this NOW, it's not coming back". Distinct from a
    // boolean so any future addition (e.g. expiry timestamp) is additive.
    credentialsDisplay: {
      shownOnce: true,
      message:
        'Staff member created. The temp password is shown ONCE below — copy ' +
        'it now (Slack/SMS the tester directly). It will not be retrievable ' +
        'after this page. They will be forced to rotate the password on first sign-in.',
    },
    ...extras,
  });

  // ── Flow B: direct-password create (no email round-trip) ────────────────
  if (resolvedPassword) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: body.data.email,
      password: resolvedPassword,
      email_confirm: true, // skip the confirmation email
      user_metadata: {
        display_name: body.data.displayName,
        role: body.data.role,
      },
    });
    if (createErr || !created.user) {
      // If user already exists in auth (e.g. signed up as a bidder),
      // we can't set a password without their flow; fall through to the
      // magic-link / reuse path below.
      if (createErr?.message?.toLowerCase().includes('already')) {
        // fall through
      } else {
        return NextResponse.json(
          { error: createErr?.message ?? 'create_failed' },
          { status: 500 },
        );
      }
    }
    if (created?.user) {
      const { error: insErr } = await admin.from('operator_users').insert({
        operator_id: caller.operator_id,
        user_id: created.user.id,
        email: body.data.email,
        display_name: body.data.displayName ?? null,
        role: body.data.role,
        // §1.7: every direct-password invite forces a rotation on first
        // sign-in. Magic-link invites (Flow A) don't need this — the
        // tester picks their own password as part of the email round-trip.
        force_password_rotate: true,
      });
      if (insErr) {
        // Real launch-week incident (2026-05-18): createUser succeeded
        // but operator_users.insert failed (RLS / network blip / dup-email
        // race). The orphaned auth.users row carried the temp password,
        // but no operator_users join existed — so the next invite attempt
        // detected "user already exists" and silently fell through to
        // the magic-link / reuse path, which never echoes a temp password
        // back to the admin. End result: admin saw a success card the
        // second time with NO password, the staff member tried to sign in
        // with the first-attempt temp password from memory, and Supabase
        // rejected it. Clean up the orphan so the next retry takes the
        // happy path.
        try {
          await admin.auth.admin.deleteUser(created.user.id);
        } catch (cleanupErr) {
          // Best-effort. If cleanup fails the admin can still re-invite
          // (we'll detect the orphan and re-attempt). Log so we can see
          // it in Sentry.
          console.warn(
            '[staff/invite] orphan auth user cleanup failed:',
            (cleanupErr as Error).message,
          );
        }
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
      return NextResponse.json(
        buildSuccessPayload({
          mode: 'direct_password',
          // Inline ONLY in this success-response payload. The client renders
          // it in an in-memory dismiss-able card; nothing logs it on the
          // server side (the sentry beforeSend filter strips `password` keys
          // for defence-in-depth even on transport errors).
          initialPassword: resolvedPassword,
        }),
      );
    }
    // fell through — user already existed in auth, handle as reuse below
  }

  // ── Flow A: magic-link invite (or auth-user-exists reuse path) ──────────
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    body.data.email,
    { data: { display_name: body.data.displayName, role: body.data.role } },
  );
  if (inviteErr) {
    // If the user already exists in auth, fetch them by email.
    // The JS SDK's listUsers() only supports page/perPage — no email filter.
    // Call the GoTrue /admin/users?filter= endpoint directly to avoid
    // loading the entire user list just to find one match.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const filterResp = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(`email.eq.${body.data.email}`)}&page=1&per_page=1`,
      { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
    );
    const filterJson = filterResp.ok
      ? (await filterResp.json() as { users?: Array<{ id: string; email?: string }> })
      : { users: [] };
    const found = (filterJson.users ?? []).find((u) => u.email === body.data.email);
    if (!found) {
      return NextResponse.json({ error: inviteErr.message }, { status: 500 });
    }
    // 2026-05-18 fix: if the admin explicitly asked for a direct-password
    // invite (wantsDirect = initialPassword OR generateInitialPassword)
    // AND we hit this "auth user already existed" branch, the admin
    // expects to receive a temp password back. The earlier code path
    // silently downgraded to `mode: 'reused'` without any password,
    // which is how the Jared incident happened (first-attempt orphan).
    // Reset the existing user's password to the temp value and return
    // it so the admin can hand it to the staff member.
    let modeForResponse: 'reused' | 'direct_password' = 'reused';
    let resetPassword: string | null = null;
    if (wantsDirect && resolvedPassword) {
      const { error: updErr } = await admin.auth.admin.updateUserById(found.id, {
        password: resolvedPassword,
        email_confirm: true,
      });
      if (updErr) {
        return NextResponse.json(
          {
            error:
              'reused_password_reset_failed: ' + updErr.message,
          },
          { status: 500 },
        );
      }
      modeForResponse = 'direct_password';
      resetPassword = resolvedPassword;
    }
    const { error: insErr } = await admin.from('operator_users').insert({
      operator_id: caller.operator_id,
      user_id: found.id,
      email: body.data.email,
      display_name: body.data.displayName ?? null,
      role: body.data.role,
      // If we just reset the password on a pre-existing user, force them
      // to rotate. If we didn't (true magic-link reuse case), don't —
      // they may be a bidder with their own already-chosen password.
      force_password_rotate: modeForResponse === 'direct_password',
    });
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    return NextResponse.json(
      buildSuccessPayload(
        modeForResponse === 'direct_password'
          ? { mode: 'direct_password', initialPassword: resetPassword }
          : { mode: 'reused' },
      ),
    );
  }

  if (!invited?.user) {
    return NextResponse.json({ error: 'invite_no_user' }, { status: 500 });
  }

  const { error: insErr } = await admin.from('operator_users').insert({
    operator_id: caller.operator_id,
    user_id: invited.user.id,
    email: body.data.email,
    display_name: body.data.displayName ?? null,
    role: body.data.role,
    // Magic-link path: the user sets their own password during the
    // email-link flow; no forced rotation needed.
    force_password_rotate: false,
  });
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json(buildSuccessPayload({ mode: 'magic_link' }));
}
