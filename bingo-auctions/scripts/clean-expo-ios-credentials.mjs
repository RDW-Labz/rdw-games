#!/usr/bin/env node
// Force-clean the bidder iOS provisioning profile from Expo's credential cache
// via Expo's GraphQL API. EAS Cloud caches *.mobileprovision files on Expo's
// own servers, separate from Apple Developer Portal. Deleting the profile in
// Apple alone isn't enough — EAS keeps reusing its cached copy.
//
// What this script does:
//   1. Look up the bidder app by full name @rdw_cluer/auction-platform-bidder
//   2. Read its iOS app credentials, listing all build-credential entries
//   3. For each entry, GRAB the provisioning profile ID and DELETE it via
//      the appleProvisioningProfile.deleteAppleProvisioningProfiles mutation
//   4. EAS will mint a fresh profile on the next build because none exists
//
// Auth: uses EXPO_TOKEN from apps/bidder-app/.env (the user's token).
//
// Safety: this script does NOT touch the distribution certificate
// (only the provisioning profile). Certificates have a 1-year shelf life
// and are expensive to revoke. Profiles are cheap — Apple generates a
// new one each build.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function readExpoToken() {
  const candidates = [
    join(REPO, 'apps', 'bidder-app', '.env'),
    join(REPO, 'apps', 'field-mobile', '.env'),
  ];
  for (const path of candidates) {
    try {
      const txt = readFileSync(path, 'utf8');
      const m = txt.match(/^EXPO_TOKEN=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  if (process.env.EXPO_TOKEN) return process.env.EXPO_TOKEN;
  throw new Error('EXPO_TOKEN not found in env files or env var');
}

const TOKEN = readExpoToken();
const APP_FULL_NAME = '@rdw_cluer/auction-platform-bidder';

async function gql(query, variables = {}) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'expo-api-version': '1',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error('GraphQL errors: ' + JSON.stringify(body.errors, null, 2));
  }
  return body.data;
}

(async () => {
  console.log(`Looking up app ${APP_FULL_NAME}...`);
  const lookup = await gql(`
    query AppByFullName($fullName: String!) {
      app {
        byFullName(fullName: $fullName) {
          id
          slug
          fullName
          iosAppCredentials {
            id
            appleAppIdentifier {
              id
              bundleIdentifier
            }
            iosAppBuildCredentialsList {
              id
              provisioningProfile {
                id
                developerPortalIdentifier
              }
              distributionCertificate {
                id
                serialNumber
              }
            }
          }
        }
      }
    }
  `, { fullName: APP_FULL_NAME });

  const app = lookup.app?.byFullName;
  if (!app) {
    console.error('App not found.');
    process.exit(1);
  }
  console.log(`App id: ${app.id}, slug: ${app.slug}`);
  console.log('');

  const credsList = app.iosAppCredentials ?? [];
  if (credsList.length === 0) {
    console.log('No iOS app credentials. EAS will mint fresh on next build.');
    return;
  }

  console.log(`Found ${credsList.length} iOS app credentials record(s):`);
  for (const c of credsList) {
    console.log(`  - bundle=${c.appleAppIdentifier.bundleIdentifier}  buildCreds count=${c.iosAppBuildCredentialsList.length}`);
  }
  console.log('');

  const profileIds = [];
  for (const c of credsList) {
    for (const bc of c.iosAppBuildCredentialsList) {
      if (bc.provisioningProfile?.id) {
        profileIds.push(bc.provisioningProfile.id);
        console.log(`Will delete provisioning profile: ${bc.provisioningProfile.id}  (Apple UUID: ${bc.provisioningProfile.developerPortalIdentifier})`);
      }
    }
  }

  if (profileIds.length === 0) {
    console.log('No provisioning profiles cached. Nothing to delete. EAS will mint fresh on next build.');
    return;
  }

  console.log('');
  console.log(`Deleting ${profileIds.length} cached provisioning profile(s)...`);
  const del = await gql(`
    mutation DeleteProfiles($ids: [ID!]!) {
      appleProvisioningProfile {
        deleteAppleProvisioningProfiles(ids: $ids) {
          id
        }
      }
    }
  `, { ids: profileIds });
  console.log('Delete result:', JSON.stringify(del, null, 2));
  console.log('');
  console.log('OK. EAS will mint a fresh provisioning profile on the next iOS build.');
  console.log('Distribution certificate is untouched (do not need to re-mint).');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
