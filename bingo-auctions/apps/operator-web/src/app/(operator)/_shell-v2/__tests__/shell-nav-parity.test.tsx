// Renders the real (operator)/layout.tsx with a mocked Supabase session and
// checks two things:
//   1. The v2 shell's nav (nav-model.ts) is the same list as v1's inline JSX —
//      same groups, hrefs, labels, indent and role gating — for each role.
//   2. The auth / staff / rotate gates still run before the shell is chosen,
//      and the v2 cookie swaps only the shell.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'staff@example.com' } as { id: string; email: string } | null,
  staff: null as Record<string, unknown> | null,
  cookie: 'v1' as string | undefined,
  pathname: '/dashboard',
  headerPath: '/dashboard',
}));

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: { listFactors: async () => ({ data: { all: [] } }) },
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: state.staff }),
      };
      return q;
    },
    rpc: async () => ({ error: null }),
  }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (n === 'console_ui' && state.cookie ? { value: state.cookie } : undefined),
  }),
  headers: async () => new Map([['x-pathname', state.headerPath]]),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  usePathname: () => state.pathname,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/super-admin', () => ({ isSuperAdmin: () => false }));
vi.mock('@/lib/posthog', () => ({ PostHogIdentify: () => null }));
vi.mock('@/lib/build-id', () => ({ currentBuildId: () => 'test-build' }));
vi.mock('@/lib/supabase-browser', () => ({ getSupabaseBrowser: () => ({ auth: { signOut: async () => {} } }) }));
vi.mock('../../BuildSkewNotice', () => ({
  BuildSkewNotice: ({ pageBuild }: { pageBuild: string }) => <div data-notice="build-skew">{pageBuild}</div>,
}));
vi.mock('../../MfaSetupBanner', () => ({ MfaSetupBanner: () => <div data-notice="mfa" /> }));

import { renderToString } from 'react-dom/server';
import OperatorLayout from '../../layout';
import { SHELL_NAV_GROUPS, visibleNavGroups } from '../nav-model';

type Entry = { group: string | null; href: string; label: string; sub: boolean };

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

async function renderLayout(): Promise<string> {
  const el = await OperatorLayout({ children: <div id="page-root">page</div> });
  return renderToString(el).replace(/<!-- -->/g, '');
}

/** Walks v1's <aside> nav in DOM order: NavSection headings and Links. */
function v1Entries(html: string): Entry[] {
  const aside = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  const out: Entry[] = [];
  let group: string | null = null;
  const re = /<div style="[^"]*text-transform:uppercase[^"]*">([^<]+)<\/div>|<a ([^>]*)>([^<]+)<\/a>/g;
  for (const m of aside.matchAll(re)) {
    if (m[1]) {
      group = decode(m[1]);
      continue;
    }
    const attrs = m[2] ?? '';
    const href = attrs.match(/href="([^"]+)"/)?.[1] ?? '';
    if (href === '/login') continue; // SignOutLink — lives in the v2 header
    out.push({
      group,
      href,
      label: decode(m[3] ?? ''),
      sub: /padding-left:16px/.test(attrs),
    });
  }
  return out;
}

function v2Entries(role: string | null, growthHubEnabled = false): Entry[] {
  return visibleNavGroups(role, SHELL_NAV_GROUPS, { growthHubEnabled }).flatMap((g) =>
    g.items.map((i) => ({ group: g.label, href: i.href, label: i.label, sub: Boolean(i.sub) })),
  );
}

function staffRow(role: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'ou-1',
    operator_id: 'op-1',
    role,
    force_password_rotate: false,
    admin_first_seen_at: null,
    operators: { business_name: 'BinGo Auctions' },
    ...extra,
  };
}

describe('v2 shell nav parity with the v1 sidebar', () => {
  beforeEach(() => {
    state.user = { id: 'user-1', email: 'staff@example.com' };
    state.cookie = 'v1';
    state.pathname = '/dashboard';
    state.headerPath = '/dashboard';
    delete process.env.GROWTH_HUB_ENABLED;
  });

  it.each(['admin', 'manager', 'staff', 'lotter'])('same groups, hrefs, labels, indent for role %s', async (role) => {
    state.staff = staffRow(role);
    const html = await renderLayout();
    expect(html).toContain('op-shell');
    const v1 = v1Entries(html);
    expect(v1.length).toBeGreaterThan(20);
    expect(v2Entries(role)).toEqual(v1);
    expect(v1.some((e) => e.href === '/growth')).toBe(false);
  });

  it('flag on: admin Growth nav matches in v1 and v2; manager does not see it', async () => {
    process.env.GROWTH_HUB_ENABLED = 'true';
    state.staff = staffRow('admin');
    const adminHtml = await renderLayout();
    const adminV1 = v1Entries(adminHtml);
    expect(adminV1.some((e) => e.href === '/growth' && e.group === 'Growth')).toBe(true);
    expect(v2Entries('admin', true)).toEqual(adminV1);
    state.cookie = 'v2';
    const v2html = await renderLayout();
    expect(v2html).toContain('href="/growth"');
    expect(v2html).toContain('class="console-v2-shell"');
    state.cookie = 'v1';

    state.staff = staffRow('manager');
    const managerV1 = v1Entries(await renderLayout());
    expect(managerV1.some((e) => e.group === 'Growth')).toBe(false);
    expect(v2Entries('manager', true)).toEqual(managerV1);
  });

  it('v1 still has its sign out, and the v2 header has it too', async () => {
    state.staff = staffRow('staff');
    const v1 = await renderLayout();
    expect(v1).toMatch(/<a href="\/login"[^>]*>Sign out<\/a>/);
    state.cookie = 'v2';
    const v2 = await renderLayout();
    const header = v2.slice(v2.indexOf('<header'), v2.indexOf('</header>'));
    expect(header).toMatch(/<a href="\/login"[^>]*>Sign out<\/a>/);
  });
});

describe('layout gates run before the shell is chosen', () => {
  beforeEach(() => {
    state.user = { id: 'user-1', email: 'staff@example.com' };
    state.staff = staffRow('staff');
    state.pathname = '/dashboard';
    state.headerPath = '/dashboard';
    delete process.env.GROWTH_HUB_ENABLED;
  });

  it.each(['v1', 'v2'])('no session → /login (cookie %s)', async (cookie) => {
    state.cookie = cookie;
    state.user = null;
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/login');
  });

  it.each(['v1', 'v2'])('no staff row → / (cookie %s)', async (cookie) => {
    state.cookie = cookie;
    state.staff = null;
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/');
  });

  it.each(['v1', 'v2'])('forced password rotate → rotate page (cookie %s)', async (cookie) => {
    state.cookie = cookie;
    state.staff = staffRow('staff', { force_password_rotate: true });
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/account/rotate-password');
    state.headerPath = '/account/rotate-password';
    await expect(renderLayout()).resolves.toContain('page-root');
  });

  it('v2 cookie renders the v2 shell with the notices and the page; v1 cookie renders op-shell', async () => {
    state.cookie = 'v2';
    const v2 = await renderLayout();
    expect(v2).toContain('class="console-v2-shell"');
    expect(v2).not.toContain('op-shell');
    expect(v2).toContain('data-notice="build-skew"');
    expect(v2.indexOf('data-notice="build-skew"')).toBeLessThan(v2.indexOf('id="page-root"'));
    expect(v2).toContain('BinGo Auctions');

    for (const cookie of ['v1', undefined]) {
      state.cookie = cookie;
      const v1 = await renderLayout();
      expect(v1).toContain('class="op-shell"');
      expect(v1).not.toContain('console-v2-shell');
    }
  });
});
