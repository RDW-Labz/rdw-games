// One-shot admin tool: set a password for any auth user by email.
//
// Bypasses Supabase's email rate limit on /forgot-password (~2-4/hr).
// Use this when you need to unblock a tester who tripped the limit, or
// when you just want to hand someone a temp password directly without
// the email round-trip.
//
// Usage (SUPABASE_URL is required — there is no default project; BinGo prod
// is https://npwseclcxcatjhgjrtwe.supabase.co):
//   SUPABASE_URL=<project-url> SERVICE_KEY=<service-role-key> node scripts/admin-set-password.mjs <email> [password]
//
// If `password` is omitted, generates a strong random one. The script
// prints the email + password block to stdout — you copy/paste it to
// the user via Slack / SMS. They sign in, then change it under their
// account settings.
//
// Why this is safe: only callable from a machine with the service-role
// key (gitignored, in .env.smoke.local). Same trust boundary as the
// /api/staff/invite endpoint's direct-password path.

// Direct REST call to Supabase Admin API — avoids supabase-js's
// realtime-js WebSocket dependency that breaks on Node 20.
// The URL was hardcoded to the upstream project (this repo's upstream) with no
// override at all, so this reset passwords on another company's auth users.
// This script writes credentials; it does not guess.
const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SB_KEY = process.env.SERVICE_KEY ?? '';
if (!SB_KEY) {
  console.error('Set SERVICE_KEY env var to the service-role key.');
  process.exit(1);
}
if (!SB_URL) {
  console.error(
    '[admin-set-password] SUPABASE_URL is not set.\n\n' +
      '  There is no default Supabase project. Set the URL the SERVICE_KEY\n' +
      '  belongs to:\n\n' +
      '    SUPABASE_URL=https://npwseclcxcatjhgjrtwe.supabase.co SERVICE_KEY=... \\\n' +
      '      node scripts/admin-set-password.mjs <email> [password]\n\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm before resetting anyone.',
  );
  process.exit(1);
}

const [, , email, passwordArg] = process.argv;
if (!email) {
  console.error('Usage: SUPABASE_URL=... SERVICE_KEY=... node scripts/admin-set-password.mjs <email> [password]');
  process.exit(1);
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

const password = passwordArg ?? generatePassword();

const headers = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

// Look up the user by email via the admin REST endpoint. The /admin/users
// route supports `email=...` filter querystring.
const listUrl = `${SB_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
const listRes = await fetch(listUrl, { headers });
if (!listRes.ok) {
  console.error('listUsers failed:', listRes.status, await listRes.text());
  process.exit(1);
}
const listBody = await listRes.json();
const user = (listBody.users ?? listBody).find?.(
  (u) => u.email?.toLowerCase() === email.toLowerCase(),
);
if (!user) {
  console.error(`No auth user found for email: ${email}`);
  process.exit(1);
}

// PUT /auth/v1/admin/users/<id> with password in the body sets the password
// without sending an email.
const updateRes = await fetch(`${SB_URL}/auth/v1/admin/users/${user.id}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ password }),
});
if (!updateRes.ok) {
  console.error('updateUser failed:', updateRes.status, await updateRes.text());
  process.exit(1);
}

console.log();
console.log('  ───────────────────────────────────────────');
console.log(`   Email:    ${email}`);
console.log(`   Password: ${password}`);
console.log('  ───────────────────────────────────────────');
console.log();
console.log('  Share with the user. They can change it under their');
console.log('  account settings after first sign-in.');
console.log();
