#!/usr/bin/env node
// IPA investigator — fetches v12 and v15 builds via ASC API + EAS, extracts and diffs them.
// Run with: node scripts/ipa-investigate.mjs  (from repo root)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const KEY_ID    = '25M83P99J8';
const ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH  = resolve(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8');
const APP_ID    = '6767012532';

// Work dir on Windows-accessible path
const WORK_DIR  = resolve(REPO_ROOT, '.ipa-diff');

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

// ── JWT ──────────────────────────────────────────────────────────────────────
async function makeJwt() {
  const key = await readFile(KEY_PATH, 'utf8');
  return jwt.sign(
    { iss: ISSUER_ID, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+1200, aud:'appstoreconnect-v1' },
    key,
    { algorithm:'ES256', header:{ alg:'ES256', kid:KEY_ID, typ:'JWT' } }
  );
}

async function ascGet(url, token) {
  const res = await fetch(url, { headers:{ Authorization:`Bearer ${token}` }, redirect:'follow' });
  if (!res.ok) { const b=await res.text().catch(()=>''); throw new Error(`ASC ${res.status} ${url}\n${b.slice(0,600)}`); }
  return res.json();
}

// ── Download ─────────────────────────────────────────────────────────────────
async function downloadFile(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 100000) {
    console.log(`  (cached) ${dest} (${(statSync(dest).size/1024/1024).toFixed(1)} MB)`);
    return;
  }
  console.log(`  Downloading ${url.slice(0,80)}...`);
  const res = await fetch(url, { redirect:'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  await writeFile(dest, Buffer.from(buf));
  console.log(`  Saved ${dest} (${(buf.byteLength/1024/1024).toFixed(1)} MB)`);
}

// ── Extract IPA via unzip (WSL) ───────────────────────────────────────────────
function toWslPath(winPath) {
  // Convert C:\foo\bar → /mnt/c/foo/bar
  return winPath.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

function extractIpa(ipaPath, outDir) {
  const wslIpa = toWslPath(ipaPath);
  const wslOut = toWslPath(outDir);
  if (existsSync(join(outDir, 'Payload'))) {
    console.log(`  (cached extract) ${outDir}`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync('bash', ['-c', `unzip -q "${wslIpa}" -d "${wslOut}"`], { encoding:'utf8', timeout: 60000 });
  if (r.status !== 0 && r.status !== 1) { // unzip exits 1 for warnings which is ok
    throw new Error(`unzip failed (${r.status}): ${r.stderr}`);
  }
  console.log(`  Extracted to ${outDir}`);
}

function bashRun(cmd) {
  const r = spawnSync('bash', ['-c', cmd], { encoding:'utf8', timeout: 30000, maxBuffer: 10*1024*1024 });
  return r.stdout || '';
}

function findApp(extractDir) {
  const payload = join(extractDir, 'Payload');
  const wslPayload = toWslPath(payload);
  const entries = bashRun(`ls "${wslPayload}"`).trim().split('\n').filter(Boolean);
  const app = entries.find(e => e.endsWith('.app'));
  if (!app) throw new Error(`No .app in Payload. Found: ${entries.join(', ')}`);
  return join(payload, app);
}

// ── Plist parser ─────────────────────────────────────────────────────────────
function parsePlist(plistPath) {
  const wsl = toWslPath(plistPath);
  const r = spawnSync('bash', ['-c', `python3 -c "
import plistlib, json, sys
try:
    with open(sys.argv[1], 'rb') as f:
        d = plistlib.load(f)
    print(json.dumps(d, default=str, indent=2))
except Exception as e:
    print(json.dumps({'_error': str(e)}))
" "${wsl}"`], { encoding:'utf8', timeout:10000 });
  try { return JSON.parse(r.stdout); } catch(e) { return { _error: r.stderr || e.message }; }
}

// ── mobileprovision → XML text ────────────────────────────────────────────────
function parseMobileprovision(mpPath) {
  const wsl = toWslPath(mpPath);
  const r = spawnSync('bash', ['-c', `openssl smime -inform der -verify -noverify -in "${wsl}" 2>/dev/null`], { encoding:'utf8', timeout:10000, maxBuffer:1*1024*1024 });
  return r.stdout || '';
}

// ── Frameworks list ───────────────────────────────────────────────────────────
function listFrameworks(appDir) {
  const fw = join(appDir, 'Frameworks');
  if (!existsSync(fw)) return [];
  const wsl = toWslPath(fw);
  return bashRun(`ls "${wsl}"`).trim().split('\n').filter(Boolean).sort();
}

// ── JS bundle info ────────────────────────────────────────────────────────────
function jsBundleInfo(appDir) {
  const wslApp = toWslPath(appDir);
  // Find bundle
  const findR = bashRun(`find "${wslApp}" -maxdepth 4 -type f \\( -name "*.jsbundle" -o -name "main.bundle" -o -name "index.bundle" \\) 2>/dev/null | grep -v Frameworks`);
  const bundles = findR.trim().split('\n').filter(Boolean);
  if (!bundles.length) return { found: false };

  const wslBundle = bundles[0];
  // Convert WSL path back to Windows path for statSync
  const winBundle = wslBundle.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');

  let sizeBytes = 0;
  try { sizeBytes = statSync(winBundle).size; } catch(e) { /* ignore */ }

  const firstBytes = bashRun(`python3 -c "d=open('${wslBundle}','rb').read(16); print(' '.join(f'{b:02x}' for b in d))"`).trim();

  // Hermes magic: c0 1f fc 0d (little-endian 0x0dfc1fc0)
  const isHermes = firstBytes.startsWith('c0 1f fc') || firstBytes.includes('fc 0d');

  // String counts — strings utility or grep on binary
  const grepCount = (pattern) => {
    const r = spawnSync('bash', ['-c', `strings "${wslBundle}" 2>/dev/null | grep -c "${pattern}" 2>/dev/null || echo 0`], { encoding:'utf8', timeout:15000 });
    return parseInt(r.stdout.trim()) || 0;
  };

  const grepSample = (pattern, n=3) => {
    const r = spawnSync('bash', ['-c', `strings "${wslBundle}" 2>/dev/null | grep -m ${n} "${pattern}" 2>/dev/null || true`], { encoding:'utf8', timeout:15000 });
    return r.stdout.trim().split('\n').filter(Boolean);
  };

  return {
    found: true,
    wslPath: wslBundle,
    sizeBytes,
    sizeMB: (sizeBytes/1024/1024).toFixed(2),
    firstBytesHex: firstBytes,
    isHermes,
    stringCounts: {
      Sentry: grepCount('Sentry'),
      expoUpdates: grepCount('expo-updates'),
      EXUpdates: grepCount('EXUpdates'),
      enableNative: grepCount('enableNative'),
      disableAntiBricking: grepCount('disableAntiBrickingMeasures'),
      stripe: grepCount('[Ss]tripe'),
      newArchEnabled: grepCount('newArchEnabled'),
      TurboModule: grepCount('TurboModule'),
      fabricEnabled: grepCount('fabricEnabled'),
      RCTBridge: grepCount('RCTBridge'),
      ExpoUpdatesModule: grepCount('ExpoUpdatesModule'),
      ClovrBid: grepCount('ClovrBid'),
      supabase: grepCount('supabase'),
      jsxDEV: grepCount('jsxDEV'),
      bundleURL: grepCount('bundleURL'),
      modulesConsistencyCheck: grepCount('modulesConsistencyCheck'),
    },
    sentryDsn: grepSample('sentry.io'),
    expoUpdatesSamples: grepSample('updates'),
    expoRuntimeVersion: grepSample('runtimeVersion'),
  };
}

// ── Entitlements from IPA ─────────────────────────────────────────────────────
function getEntitlements(appDir) {
  const wslApp = toWslPath(appDir);
  const appName = appDir.split('\\').pop().replace('.app','');
  // Use ldid or codesign equivalent — try python to read directly from binary
  // More reliable: look for embedded entitlements in main binary via strings
  const mainBin = join(appDir, appName);
  if (existsSync(mainBin)) {
    const wslBin = toWslPath(mainBin);
    const r = spawnSync('bash', ['-c', `
# Try to extract embedded entitlements plist from binary using xmllint or just strings
python3 -c "
import sys
data = open('${wslBin}', 'rb').read()
# Find entitlements plist embedded in binary
start = data.find(b'<?xml version=')
if start == -1:
    start = data.find(b'<!DOCTYPE plist')
if start == -1:
    # Try finding the entitlements dict
    start = data.find(b'<plist version=')
if start != -1:
    end = data.find(b'</plist>', start)
    if end != -1:
        print(data[start:end+8].decode('utf-8', errors='replace'))
    else:
        print(data[start:start+4096].decode('utf-8', errors='replace'))
else:
    print('NO_ENTITLEMENTS_FOUND_IN_BINARY')
"
`], { encoding:'utf8', timeout:20000, maxBuffer:2*1024*1024 });
    return r.stdout.trim();
  }
  return 'main binary not found';
}

// ── List all top-level files ──────────────────────────────────────────────────
function listTopLevelFiles(appDir) {
  const wsl = toWslPath(appDir);
  return bashRun(`ls -la "${wsl}"`).trim();
}

// ── Collect everything for one build ─────────────────────────────────────────
async function investigateBuild(version, ipaUrl, token) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Investigating BUILD v${version}`);
  console.log('='.repeat(60));

  const ipaPath = resolve(WORK_DIR, `v${version}.ipa`);
  const extractDir = resolve(WORK_DIR, `v${version}`);

  // Download
  await downloadFile(ipaUrl, ipaPath);

  // Extract
  extractIpa(ipaPath, extractDir);

  // Find .app
  const appDir = findApp(extractDir);
  console.log(`  .app path: ${appDir}`);

  // 1. Info.plist
  const infoPlist = parsePlist(join(appDir, 'Info.plist'));

  // 2. embedded.mobileprovision
  const mpPath = join(appDir, 'embedded.mobileprovision');
  const mpText = existsSync(mpPath) ? parseMobileprovision(mpPath) : 'NOT FOUND';

  // Parse entitlements from mobileprovision XML
  let mpEntitlements = {};
  if (mpText && mpText.includes('<plist')) {
    // Extract entitlements section
    const entMatch = mpText.match(/<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    if (entMatch) mpEntitlements = { _raw: entMatch[0].slice(0, 3000) };
    else mpEntitlements = { _fullText: mpText.slice(0, 2000) };
  }

  // 3. Frameworks
  const frameworks = listFrameworks(appDir);

  // 4. JS bundle
  const jsbundle = jsBundleInfo(appDir);

  // 5. ExpoConfig
  const expoConfigs = {};
  for (const name of ['ExpoConfig.plist', 'EXUpdates.plist', 'app.config.json']) {
    const p = join(appDir, name);
    if (existsSync(p)) {
      if (name.endsWith('.plist')) expoConfigs[name] = parsePlist(p);
      else expoConfigs[name] = JSON.parse(bashRun(`cat "${toWslPath(p)}"`));
    }
  }

  // Extra plists
  const wslApp = toWslPath(appDir);
  const allPlists = bashRun(`find "${wslApp}" -maxdepth 1 -name "*.plist" 2>/dev/null`).trim().split('\n').filter(Boolean);
  for (const p of allPlists) {
    const name = p.split('/').pop();
    if (!expoConfigs[name] && name !== 'Info.plist') {
      const winP = p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
      expoConfigs[name] = parsePlist(winP);
    }
  }

  // Top-level files
  const topFiles = listTopLevelFiles(appDir);

  const result = {
    version,
    ipaPath,
    appDir,
    infoPlist,
    mpEntitlements,
    frameworks,
    jsbundle,
    expoConfigs,
    topFiles,
  };

  await writeFile(resolve(WORK_DIR, `v${version}-result.json`), JSON.stringify(result, null, 2));
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(WORK_DIR, { recursive: true });

  console.log('\n=== Step 1: JWT ===');
  const token = await makeJwt();
  console.log('OK');

  console.log('\n=== Step 2: EAS build list ===');
  const EXPO_TOKEN = 'KDiteVCime1gH0tmNuhs4Nz_7D7ZmOQi5nZis-vl';

  let v12Url = null, v15Url = null;
  let v12EasId = null, v15EasId = null;

  try {
    const easResult = spawnSync(
      'node',
      [resolve(REPO_ROOT, 'node_modules/.bin/eas'), 'build:list', '--json', '--platform', 'ios', '--limit', '25', '--non-interactive'],
      {
        cwd: resolve(REPO_ROOT, 'apps', 'bidder-app'),
        encoding: 'utf8',
        env: { ...process.env, EXPO_TOKEN, PATH: process.env.PATH },
        timeout: 120000
      }
    );

    if (easResult.status === 0 && easResult.stdout.trim()) {
      // EAS outputs JSON after possible preamble — find the JSON array
      const jsonStart = easResult.stdout.indexOf('[');
      const jsonStr = jsonStart >= 0 ? easResult.stdout.slice(jsonStart) : easResult.stdout;
      const easBuilds = JSON.parse(jsonStr);
      console.log(`EAS returned ${easBuilds.length} builds`);

      await writeFile(resolve(WORK_DIR, 'eas-builds.json'), JSON.stringify(easBuilds, null, 2));

      for (const b of easBuilds) {
        const bv = b.appBuildVersion || b.buildNumber || b.runtimeVersion;
        console.log(`  EAS build: id=${b.id} appBuildVersion=${b.appBuildVersion} platform=${b.platform} status=${b.status} created=${b.createdAt} url=${b.artifacts?.applicationArchiveUrl?.slice(0,60)}`);
      }

      const find = (ver) => easBuilds.find(b =>
        String(b.appBuildVersion) === String(ver) ||
        String(b.buildNumber) === String(ver)
      );
      const b12 = find('12');
      const b15 = find('15');

      if (b12) { v12Url = b12.artifacts?.applicationArchiveUrl; v12EasId = b12.id; }
      if (b15) { v15Url = b15.artifacts?.applicationArchiveUrl; v15EasId = b15.id; }

      console.log(`v12 URL: ${v12Url || 'NOT FOUND'}`);
      console.log(`v15 URL: ${v15Url || 'NOT FOUND'}`);
    } else {
      console.log('EAS STDOUT:', easResult.stdout?.slice(0,1000));
      console.log('EAS STDERR:', easResult.stderr?.slice(0,1000));
    }
  } catch(e) {
    console.log('EAS error:', e.message);
  }

  // Fallback: ASC API builds
  if (!v12Url || !v15Url) {
    console.log('\n=== Fallback: ASC builds API ===');
    const buildsUrl = `https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${APP_ID}&filter[platform]=IOS&sort=-uploadedDate&limit=25&fields[builds]=version,uploadedDate,processingState,minOsVersion,usesNonExemptEncryption`;
    const ascBuilds = await ascGet(buildsUrl, token);
    for (const b of ascBuilds.data || []) {
      console.log(`  ASC build: id=${b.id} version=${b.attributes?.version} state=${b.attributes?.processingState} uploaded=${b.attributes?.uploadedDate}`);
    }

    // Note: ASC API v1 doesn't expose IPA download URLs directly (only TestFlight diag)
    // We'll need to use the EAS URLs or note they're unavailable
    if (!v12Url) console.log('WARNING: v12 IPA URL not available via EAS');
    if (!v15Url) console.log('WARNING: v15 IPA URL not available via EAS');
  }

  if (!v12Url && !v15Url) {
    console.log('\nFATAL: Could not find IPA download URLs for either build. Dumping EAS build file for manual inspection.');
    process.exit(1);
  }

  // Now investigate both
  const results = {};
  if (v12Url) results.v12 = await investigateBuild('12', v12Url, token);
  if (v15Url) results.v15 = await investigateBuild('15', v15Url, token);

  // ── Diff output ────────────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(70));
  console.log('DIFF REPORT: v12 vs v15');
  console.log('='.repeat(70));

  if (results.v12 && results.v15) {
    const v12 = results.v12;
    const v15 = results.v15;

    // 1. Info.plist diff
    console.log('\n--- 1. Info.plist DIFFERENCES ---');
    const ip12 = v12.infoPlist;
    const ip15 = v15.infoPlist;
    const allKeys = new Set([...Object.keys(ip12||{}), ...Object.keys(ip15||{})]);
    let plistDiffs = 0;
    for (const k of [...allKeys].sort()) {
      const v12val = JSON.stringify(ip12?.[k]);
      const v15val = JSON.stringify(ip15?.[k]);
      if (v12val !== v15val) {
        plistDiffs++;
        console.log(`  KEY: ${k}`);
        console.log(`    v12: ${v12val?.slice(0,200)}`);
        console.log(`    v15: ${v15val?.slice(0,200)}`);
      }
    }
    if (plistDiffs === 0) console.log('  (no differences)');

    // 2. Entitlements diff
    console.log('\n--- 2. Entitlements DIFFERENCES ---');
    const ent12 = JSON.stringify(v12.mpEntitlements);
    const ent15 = JSON.stringify(v15.mpEntitlements);
    if (ent12 === ent15) {
      console.log('  (identical)');
    } else {
      console.log('  v12 entitlements:');
      console.log(JSON.stringify(v12.mpEntitlements, null, 2).split('\n').map(l=>'    '+l).join('\n'));
      console.log('  v15 entitlements:');
      console.log(JSON.stringify(v15.mpEntitlements, null, 2).split('\n').map(l=>'    '+l).join('\n'));
    }

    // 3. Frameworks diff
    console.log('\n--- 3. Frameworks DIFFERENCES ---');
    const fw12 = new Set(v12.frameworks);
    const fw15 = new Set(v15.frameworks);
    const addedFw = v15.frameworks.filter(f => !fw12.has(f));
    const removedFw = v12.frameworks.filter(f => !fw15.has(f));
    if (addedFw.length) console.log('  ADDED in v15:', addedFw);
    if (removedFw.length) console.log('  REMOVED in v15:', removedFw);
    if (!addedFw.length && !removedFw.length) console.log('  (identical framework list)');
    console.log(`  v12 count: ${v12.frameworks.length}, v15 count: ${v15.frameworks.length}`);

    // 4. JS bundle diff
    console.log('\n--- 4. JS Bundle DIFFERENCES ---');
    const jb12 = v12.jsbundle;
    const jb15 = v15.jsbundle;
    console.log(`  v12: found=${jb12.found} size=${jb12.sizeMB}MB hermes=${jb12.isHermes} firstBytes=${jb12.firstBytesHex}`);
    console.log(`  v15: found=${jb15.found} size=${jb15.sizeMB}MB hermes=${jb15.isHermes} firstBytes=${jb15.firstBytesHex}`);
    if (jb12.found && jb15.found) {
      const sc12 = jb12.stringCounts || {};
      const sc15 = jb15.stringCounts || {};
      const allSC = new Set([...Object.keys(sc12), ...Object.keys(sc15)]);
      for (const k of allSC) {
        if (sc12[k] !== sc15[k]) {
          console.log(`  stringCount[${k}]: v12=${sc12[k]} v15=${sc15[k]}`);
        }
      }
      if (jb15.sentryDsn?.length) console.log(`  v15 Sentry DSN samples: ${JSON.stringify(jb15.sentryDsn)}`);
      if (jb12.sentryDsn?.length) console.log(`  v12 Sentry DSN samples: ${JSON.stringify(jb12.sentryDsn)}`);
      if (jb15.expoRuntimeVersion?.length) console.log(`  v15 runtimeVersion samples: ${JSON.stringify(jb15.expoRuntimeVersion)}`);
      if (jb12.expoRuntimeVersion?.length) console.log(`  v12 runtimeVersion samples: ${JSON.stringify(jb12.expoRuntimeVersion)}`);
    }

    // 5. ExpoConfig diff
    console.log('\n--- 5. ExpoConfig / EXUpdates DIFFERENCES ---');
    const ec12Keys = Object.keys(v12.expoConfigs||{});
    const ec15Keys = Object.keys(v15.expoConfigs||{});
    const allEC = new Set([...ec12Keys, ...ec15Keys]);
    for (const fname of allEC) {
      const v12c = JSON.stringify(v12.expoConfigs?.[fname], null, 2);
      const v15c = JSON.stringify(v15.expoConfigs?.[fname], null, 2);
      if (v12c !== v15c) {
        console.log(`  File: ${fname}`);
        if (!v12.expoConfigs?.[fname]) console.log('    ADDED in v15');
        else if (!v15.expoConfigs?.[fname]) console.log('    REMOVED in v15');
        else {
          // Sub-key diff
          const o12 = v12.expoConfigs?.[fname] || {};
          const o15 = v15.expoConfigs?.[fname] || {};
          const allECKeys = new Set([...Object.keys(o12), ...Object.keys(o15)]);
          for (const k of allECKeys) {
            const s12 = JSON.stringify(o12[k]);
            const s15 = JSON.stringify(o15[k]);
            if (s12 !== s15) {
              console.log(`    KEY: ${k}`);
              console.log(`      v12: ${s12?.slice(0,300)}`);
              console.log(`      v15: ${s15?.slice(0,300)}`);
            }
          }
        }
      } else {
        console.log(`  ${fname}: identical`);
      }
    }

    // Print specific high-suspicion Info.plist keys
    console.log('\n--- 6. High-suspicion Info.plist key VALUES ---');
    const suspectKeys = [
      'UILaunchStoryboardName', 'UIBackgroundModes', 'LSApplicationQueriesSchemes',
      'CFBundleURLTypes', 'UIRequiredDeviceCapabilities', 'NSPrincipalClass',
      'EXUpdatesEnabled', 'EXUpdatesURL', 'EXUpdatesReleaseChannel', 'EXUpdatesRuntimeVersion',
      'EXUpdatesCheckOnLaunch', 'EXUpdatesLaunchWaitMs', 'EXUpdatesHasEmbeddedUpdate',
      'SentryDSN', 'CFBundleVersion', 'CFBundleShortVersionString',
      'UIMainStoryboardFile', 'NSAppTransportSecurity', 'ITSAppUsesNonExemptEncryption',
    ];
    for (const k of suspectKeys) {
      const v12v = ip12?.[k];
      const v15v = ip15?.[k];
      const changed = JSON.stringify(v12v) !== JSON.stringify(v15v);
      const marker = changed ? ' <<CHANGED>>' : '';
      if (v12v !== undefined || v15v !== undefined) {
        console.log(`  ${k}${marker}`);
        if (changed || v12v !== undefined) console.log(`    v12: ${JSON.stringify(v12v)?.slice(0,200)}`);
        if (changed || v15v !== undefined) console.log(`    v15: ${JSON.stringify(v15v)?.slice(0,200)}`);
      }
    }
  }

  console.log('\n\nDone. Full results in:', WORK_DIR);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
