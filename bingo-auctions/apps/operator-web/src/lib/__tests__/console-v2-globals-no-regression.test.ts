import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** :root custom properties and values before Console v2 Stage B (unchanged). */
const ROOT_VARS_BEFORE_STAGE_B: Record<string, string> = {
  '--bg': '#15233a',
  '--bg-elev': '#1c2e49',
  '--bg-elev-2': '#18283f',
  '--surface-2': '#243a5c',
  '--ink-2': '#f4f7fb',
  '--fg': '#e9eff7',
  '--fg-muted': '#9fb1c8',
  '--fg-dim': '#6f829c',
  '--accent': '#f6911e',
  '--accent-hi': '#ffa53a',
  '--accent-dim': 'rgba(246, 145, 30, 0.15)',
  '--cyan': '#2ba9cb',
  '--cyan-hi': '#45c2e2',
  '--cyan-dim': 'rgba(43, 169, 203, 0.16)',
  '--gold': '#2ba9cb',
  '--gold-hi': '#45c2e2',
  '--gold-dim': 'rgba(43, 169, 203, 0.16)',
  '--winning': '#f0b429',
  '--warn-yellow': '#f0b429',
  '--warn-yellow-dim': 'rgba(240, 180, 41, 0.18)',
  '--border': '#2b3f5e',
  '--danger': '#ff5a5f',
  '--urgent-red': '#ff5a5f',
  '--urgent-red-dim': 'rgba(255, 90, 95, 0.16)',
  '--success': '#2ecc71',
  '--success-dim': 'rgba(46, 204, 113, 0.14)',
  '--warning': '#f0b429',
  '--warning-dim': 'rgba(240, 180, 41, 0.16)',
  '--radius-sm': '6px',
  '--radius': '10px',
  '--radius-lg': '16px',
  '--radius-pill': '999px',
};

function parseRootBlock(css: string): Record<string, string> {
  const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
  if (!rootMatch?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of rootMatch[1].split('\n')) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (m?.[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

describe('globals.css :root no-regression', () => {
  it('preserves every pre-Stage-B :root variable with the same value', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const root = parseRootBlock(css);
    for (const [name, value] of Object.entries(ROOT_VARS_BEFORE_STAGE_B)) {
      expect(root[name], `missing ${name}`).toBe(value);
    }
  });
});
