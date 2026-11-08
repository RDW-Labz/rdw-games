// Service-role Supabase client. Bypasses RLS — use ONLY in trusted server
// code (server actions, route handlers) where we've already verified the
// caller's identity, AND only when the operation legitimately needs to act
// outside RLS (e.g., creating the first operator_users row before the user
// has an operator_id, or applying the result of a verified Square webhook).
//
// If you can express the operation with the user's session client, prefer
// that — service role is a sharp tool.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!admin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase admin env vars');
    admin = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return admin;
}
