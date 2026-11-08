// tests/e2e/fixtures/sim.ts
//
// Test fixture that exposes the SIM context (operator id, lot codes,
// admin/picker emails) to spec files. Read from .sim-context.json
// which global-setup writes at the start of the run.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { test as base } from '@playwright/test';

export type SimContext = {
  operatorId: string;
  operatorCode: string;
  operatorSlug: string;
  warehouseId: string;
  adminEmail: string;
  adminUserId: string;
  pickerEmail: string;
  pickerUserId: string;
  password: string;
  quickLotCode: string | null;
};

export const test = base.extend<{ sim: SimContext }>({
  sim: async ({}, use) => {
    const ctxFile = path.resolve(__dirname, '..', '.sim-context.json');
    if (!fs.existsSync(ctxFile)) {
      throw new Error(
        'No .sim-context.json found. Did global-setup run successfully?',
      );
    }
    const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8')) as SimContext;
    await use(ctx);
  },
});

export const expect = test.expect;
