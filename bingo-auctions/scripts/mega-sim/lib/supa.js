// scripts/mega-sim/lib/supa.js
//
// Dependency-free Supabase REST + Auth helpers (no @supabase/supabase-js
// to avoid the Expo session-storage shim). Matches the idiom used in
// scripts/smoke-test-e2e.js.
//
// Two auth modes:
//   • service-role (for setup): bypasses RLS, can write any table, run
//     any RPC. Used to mint SIM operators, warehouses, bins, users.
//   • user JWT (for personas): same auth.uid() the real apps use.
//     SECURITY DEFINER RPCs see the right operator scope. Use this for
//     anything that exercises the actual permission boundary.

'use strict';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

function ensureConfigured() {
  if (!SUPABASE_URL) throw new Error('[supa] NEXT_PUBLIC_SUPABASE_URL is not set');
  if (!SUPABASE_ANON) throw new Error('[supa] NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
}

// ── Auth ─────────────────────────────────────────────────────────────────

async function signInWithPassword(email, password) {
  ensureConfigured();
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    throw new Error(
      `[supa] signInWithPassword failed (${res.status}): ${
        body && body.error_description ? body.error_description : 'unknown'
      }`,
    );
  }
  return { token: body.access_token, userId: body.user && body.user.id };
}

async function adminCreateUser({ email, password, userMetadata }) {
  ensureConfigured();
  if (!SUPABASE_SERVICE_ROLE) {
    throw new Error('[supa] SUPABASE_SERVICE_ROLE_KEY required to create users');
  }
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: userMetadata || {},
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.id) {
    throw new Error(
      `[supa] adminCreateUser failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return { userId: body.id, email: body.email };
}

// Generate a magic-link URL for an existing user. Used by the Phase 3
// Playwright global-setup to bypass the password login form (which
// races with Next/Turbopack first-compile of /dashboard) and get a
// real Supabase session cookie via the canonical /auth/v1/verify
// flow. Returns the full `action_link` ready to be visited.
async function adminGenerateMagicLink({ email, redirectTo }) {
  ensureConfigured();
  if (!SUPABASE_SERVICE_ROLE) {
    throw new Error('[supa] SUPABASE_SERVICE_ROLE_KEY required to generate links');
  }
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
    },
    body: JSON.stringify({
      type: 'magiclink',
      email,
      options: redirectTo ? { redirect_to: redirectTo } : {},
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error(
      `[supa] adminGenerateMagicLink failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  // Newer Supabase returns { properties: { action_link, ... } }; older
  // returns { action_link, ... } flat. Handle both.
  const link =
    (body.properties && body.properties.action_link) || body.action_link;
  if (!link) {
    throw new Error('[supa] adminGenerateMagicLink: no action_link in response');
  }
  return link;
}

async function adminDeleteUser(userId) {
  ensureConfigured();
  if (!SUPABASE_SERVICE_ROLE) throw new Error('[supa] SUPABASE_SERVICE_ROLE_KEY required');
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
    },
  });
  return res.ok;
}

// ── REST helpers ──────────────────────────────────────────────────────────

function makeHdrs(token, useServiceKey) {
  const k = useServiceKey ? SUPABASE_SERVICE_ROLE : SUPABASE_ANON;
  return {
    'Content-Type': 'application/json',
    apikey: useServiceKey ? k : SUPABASE_ANON,
    Authorization: 'Bearer ' + (useServiceKey ? k : token),
  };
}

async function supaSelect(token, table, filter, cols, useServiceKey) {
  const url =
    SUPABASE_URL +
    '/rest/v1/' +
    table +
    '?' +
    (filter || '') +
    (cols ? (filter ? '&' : '') + 'select=' + encodeURIComponent(cols) : '');
  const res = await fetch(url, { headers: makeHdrs(token, useServiceKey) });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: body || { status: res.status }, data: null };
  return { error: null, data: body };
}

async function supaInsert(token, table, row, useServiceKey) {
  const url = SUPABASE_URL + '/rest/v1/' + table;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...makeHdrs(token, useServiceKey), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: body || { status: res.status }, data: null };
  return { error: null, data: Array.isArray(body) ? body[0] : body };
}

async function supaInsertMany(token, table, rows, useServiceKey) {
  const url = SUPABASE_URL + '/rest/v1/' + table;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...makeHdrs(token, useServiceKey), Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: body || { status: res.status }, data: null };
  return { error: null, data: Array.isArray(body) ? body : [] };
}

async function supaUpdate(token, table, filter, patch, useServiceKey) {
  const url = SUPABASE_URL + '/rest/v1/' + table + '?' + filter;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...makeHdrs(token, useServiceKey), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: body || { status: res.status }, data: null };
  return { error: null, data: body };
}

async function supaDelete(token, table, filter, useServiceKey) {
  const url = SUPABASE_URL + '/rest/v1/' + table + '?' + filter;
  const res = await fetch(url, { method: 'DELETE', headers: makeHdrs(token, useServiceKey) });
  return { error: res.ok ? null : { status: res.status }, ok: res.ok };
}

async function supaRpc(token, fn, params, useServiceKey) {
  const url = SUPABASE_URL + '/rest/v1/rpc/' + fn;
  const res = await fetch(url, {
    method: 'POST',
    headers: makeHdrs(token, useServiceKey),
    body: JSON.stringify(params || {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: body || { status: res.status }, data: null };
  return { error: null, data: body };
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_ANON,
  SUPABASE_SERVICE_ROLE,
  signInWithPassword,
  adminCreateUser,
  adminGenerateMagicLink,
  adminDeleteUser,
  supaSelect,
  supaInsert,
  supaInsertMany,
  supaUpdate,
  supaDelete,
  supaRpc,
};
