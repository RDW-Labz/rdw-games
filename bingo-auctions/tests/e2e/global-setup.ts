// tests/e2e/global-setup.ts
//
// Runs ONCE before any spec. Seeds a fresh SIM operator + warehouse +
// bins + admin/picker users by calling into the mega-sim's operator
// persona directly (no child_process — same Node, same env). Then
// signs each user in via the browser so Playwright captures real
// session cookies into storageState.
//
// We also seed a minimal lotter + picker run so the UI specs have
// realistic data to assert against (a few in_inventory lots, manifest
// rows in `pending`, etc.). AI calls are skipped (--no-ai equivalent).
//
// The seeded context is persisted to .sim-context.json so specs can
// read SIM operator id / lot codes without re-seeding.

import { chromium, FullConfig } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Resolve the mega-sim modules from the workspace root.
const repoRoot = path.resolve(__dirname, '..', '..');
const simRoot = path.join(repoRoot, 'scripts', 'mega-sim');

// Load env (mega-sim's loader walks the standard candidates).
require(path.join(simRoot, 'lib', 'env')).loadEnv();

// Disable color output from assert.js — it makes the captured logs
// noisy and unreadable in Playwright HTML reports.
process.env.NO_COLOR = '1';

const operatorPersona = require(path.join(simRoot, 'personas', 'operator'));
const lotterPersona   = require(path.join(simRoot, 'personas', 'lotter'));
const pickerPersona   = require(path.join(simRoot, 'personas', 'picker'));

async function globalSetup(config: FullConfig) {
  const log = (m: string) => console.log('[e2e/global-setup] ' + m);

  // 1. Seed via mega-sim personas. Same path Phase 1+2 use, fully tested.
  log('seeding SIM operator + warehouse + bins + users');
  const ctx = await operatorPersona.setup({ operatorPrefix: 'UI' });

  log('seeding lotter (manifest + Quick Lot, no AI)');
  await lotterPersona.run({ ctx, noAi: true });

  log('seeding picker (intake flows, manifest fall-through)');
  await pickerPersona.run({ ctx });

  // 2. Mint full session bodies for admin + picker via the Auth REST
  //    API. We need the full payload (access_token, refresh_token,
  //    expires_at, full user object) — not just access_token — so the
  //    @supabase/ssr middleware accepts the cookie we inject.
  log('fetching admin + picker session bodies via Auth API');
  async function fullSignIn(email: string, password: string) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL + '/auth/v1/token?grant_type=password';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) {
      throw new Error(
        'signIn for ' + email + ' failed: ' + res.status + ' ' + JSON.stringify(body).slice(0, 300),
      );
    }
    return body;
  }
  const adminSession = await fullSignIn(ctx.adminEmail, ctx.password);
  const pickerSession = await fullSignIn(ctx.pickerEmail, ctx.password);

  // 3. Persist the SIM context so specs + teardown can find it.
  const authDir = path.resolve(__dirname, '.auth');
  fs.mkdirSync(authDir, { recursive: true });
  const ctxFile = path.resolve(__dirname, '.sim-context.json');
  fs.writeFileSync(
    ctxFile,
    JSON.stringify(
      {
        operatorId: ctx.operatorId,
        operatorCode: ctx.operatorCode,
        operatorSlug: ctx.operatorSlug,
        warehouseId: ctx.warehouseId,
        adminEmail: ctx.adminEmail,
        adminUserId: ctx.adminUserId,
        pickerEmail: ctx.pickerEmail,
        pickerUserId: ctx.pickerUserId,
        password: ctx.password,
        quickLotCode: ctx.quickLotCode,
        bidderUserIds: [],
      },
      null,
      2,
    ),
  );
  log('sim context written → ' + ctxFile);

  // 4. Mint Playwright storageState by injecting the canonical
  //    @supabase/ssr session cookie directly. Bypasses the brittle
  //    browser-form login (which races React hydration with first-
  //    compile of /dashboard on Turbopack cold start).
  //
  //    Cookie schema: `sb-<project-ref>-auth-token` with a `base64-`
  //    prefixed JSON-encoded Session — same payload @supabase/ssr's
  //    cookieHandler reads in the middleware.
  const baseURL =
    (config.projects[0]?.use?.baseURL as string | undefined) ||
    process.env.BASE_URL ||
    'http://localhost:3000';
  const cookieDomain = new URL(baseURL).hostname;
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
  const cookieName = 'sb-' + projectRef + '-auth-token';

  log('minting storageState via direct cookie injection');
  const browser = await chromium.launch();
  const now = Math.floor(Date.now() / 1000);
  for (const [label, session, file] of [
    ['admin', adminSession, 'admin.json'],
    ['picker', pickerSession, 'picker.json'],
  ] as const) {
    const context = await browser.newContext({ baseURL });
    try {
      // Full Session shape — exactly what @supabase/supabase-js stores
      // in its auth client and what @supabase/ssr's cookie helpers
      // expect to read back. Omitting refresh_token or expires_at
      // causes the middleware's getUser() to bail.
      const sessionPayload = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        token_type: session.token_type || 'bearer',
        expires_in: session.expires_in,
        expires_at: session.expires_at || now + (session.expires_in || 3600),
        user: session.user,
      };
      const encoded = 'base64-' + Buffer.from(JSON.stringify(sessionPayload)).toString('base64');

      // The @supabase/ssr cookie handler chunks large values across
      // `.0`, `.1`, etc. The full session payload is ~2.6KB which is
      // under the 4KB per-cookie limit on Chromium, so we keep it
      // single-chunk. If we ever exceed 4KB we'll need to chunk.
      if (encoded.length > 4000) {
        throw new Error('Encoded session > 4KB — would need to chunk cookies');
      }

      await context.addCookies([
        {
          name: cookieName,
          value: encoded,
          domain: cookieDomain,
          path: '/',
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ]);
      await context.storageState({ path: path.join(authDir, file) });
      log(label + ' storageState written → ' + file + ' (cookie ' + encoded.length + ' bytes)');
    } finally {
      await context.close();
    }
  }
  await browser.close();
  log('global-setup done');
}

export default globalSetup;
