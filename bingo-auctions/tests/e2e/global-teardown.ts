// tests/e2e/global-teardown.ts
//
// Runs ONCE after all specs. Cleans up the SIM operator + bound users
// using the mega-sim's cleanup helper, then removes the on-disk auth
// state + context file.
//
// On test failure, leave .auth/ and .sim-context.json alone so the
// developer can poke at the SIM operator in the dashboard — set
// KEEP_SIM=1 in the env to skip teardown.

import * as path from 'node:path';
import * as fs from 'node:fs';

const repoRoot = path.resolve(__dirname, '..', '..');
const simRoot = path.join(repoRoot, 'scripts', 'mega-sim');

require(path.join(simRoot, 'lib', 'env')).loadEnv();
const cleanup = require(path.join(simRoot, 'cleanup'));

async function globalTeardown() {
  const log = (m: string) => console.log('[e2e/global-teardown] ' + m);

  if (process.env.KEEP_SIM === '1') {
    log('KEEP_SIM=1 — leaving SIM operator + auth state in place');
    return;
  }

  const ctxFile = path.resolve(__dirname, '.sim-context.json');
  if (!fs.existsSync(ctxFile)) {
    log('no .sim-context.json — nothing to clean');
    return;
  }

  const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));
  log('tearing down SIM operator ' + ctx.operatorCode);

  try {
    await cleanup.cleanup({
      operatorId: ctx.operatorId,
      adminUserId: ctx.adminUserId,
      pickerUserId: ctx.pickerUserId,
      bidderUserIds: ctx.bidderUserIds || [],
    });
  } catch (e: any) {
    log('cleanup error (continuing): ' + e.message);
  }

  // Remove the persisted artifacts so the next run starts clean.
  try {
    fs.rmSync(path.resolve(__dirname, '.auth'), { recursive: true, force: true });
    fs.rmSync(ctxFile, { force: true });
  } catch {}

  log('global-teardown done');
}

export default globalTeardown;
