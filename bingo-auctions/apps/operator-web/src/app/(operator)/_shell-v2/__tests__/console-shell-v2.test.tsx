import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/supabase-browser', () => ({ getSupabaseBrowser: () => ({ auth: { signOut: async () => {} } }) }));

import { renderToString } from 'react-dom/server';
import { ConsoleShellV2, SHELL_NAV_ID } from '../ConsoleShellV2';
import { DashboardV2 } from '../../dashboard/v2/DashboardV2';
import { dashboardV2Fixture } from '../../dashboard/v2/__fixtures__/dashboard-fixture';

function render(role: string | null, pathname: string, children: React.ReactNode = <p>page body</p>) {
  nav.pathname = pathname;
  return renderToString(
    <ConsoleShellV2
      operatorName="BinGo Auctions"
      role={role}
      notices={<div data-testid="notice">build notice</div>}
    >
      {children}
    </ConsoleShellV2>,
  ).replace(/<!-- -->/g, '');
}

function navHrefs(html: string): string[] {
  const navHtml = html.slice(html.indexOf(`id="${SHELL_NAV_ID}"`), html.indexOf('</nav>'));
  return [...navHtml.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]!);
}

describe('ConsoleShellV2', () => {
  beforeEach(() => {
    nav.pathname = '/dashboard';
  });

  it('admin sees the admin-only and admin/manager entries', () => {
    const h = navHrefs(render('admin', '/dashboard'));
    for (const href of ['/dashboard/workers', '/imports/new', '/imports/migrate', '/reports/kept']) {
      expect(h).toContain(href);
    }
    expect(h).not.toContain('/growth');
  });

  it('non-admin staff does not', () => {
    const h = navHrefs(render('staff', '/dashboard'));
    for (const href of ['/dashboard/workers', '/imports/new', '/imports/migrate', '/reports/kept']) {
      expect(h).not.toContain(href);
    }
    expect(h).toContain('/pickups');
    expect(h).toContain('/account/policies');
  });

  it('marks the current page and glows it in the stage hue', () => {
    const html = render('admin', '/pickups');
    expect(html).toMatch(/href="\/pickups"[^>]*aria-current="page"[^>]*data-stage="pickup"|aria-current="page"[^>]*data-stage="pickup"[^>]*href="\/pickups"|href="\/pickups"[^>]*data-stage="pickup"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('data-stage="pickup"');
  });

  it.each([
    ['/loads', 'intake'],
    ['/lotting/drafts', 'intake'],
    ['/lotting/inventory', 'lotting'],
    ['/auctions', 'auction'],
    ['/invoices', 'paid'],
    ['/pickups', 'pickup'],
    ['/settings', 'neutral'],
  ])('%s gets the %s hue on the shell and the active link', (path, stage) => {
    const html = render('admin', path);
    expect(html).toMatch(new RegExp(`class="console-v2-shell"[^>]*data-stage="${stage}"`));
    const active = html.match(/<a [^>]*aria-current="page"[^>]*>/)?.[0] ?? '';
    expect(active).toContain(`href="${path}"`);
    expect(active).toContain(`data-stage="${stage}"`);
  });

  it('Switch back to v1 keeps the ?ui=v1 href on the current path, and sign out is in the header', () => {
    const html = render('staff', '/lotting/inventory');
    expect(html).toContain('href="/lotting/inventory?ui=v1"');
    expect(html).toContain('Switch back to v1');
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('Sign out');
    expect(header).toContain('BinGo Auctions');
    // The floating v1-shell badge is not rendered under the v2 shell.
    expect(html).not.toContain('console-v2-switch-back');
  });

  it('keeps the landmarks, skip link and drawer wiring', () => {
    const html = render('staff', '/pickups');
    expect(html).toContain('href="#main-content"');
    expect(html).toMatch(/<main id="main-content"/);
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toMatch(new RegExp(`aria-expanded="false" aria-controls="${SHELL_NAV_ID}"`));
    // DOM order = tab order: skip → nav → header → main
    const order = ['href="#main-content"', `id="${SHELL_NAV_ID}"`, '<header', '<main'].map((s) => html.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Group disclosures start expanded and point at their lists.
    expect(html).toMatch(/aria-expanded="true" aria-controls="console-v2-shell-group-lotting"/);
    expect(html).toContain('id="console-v2-shell-group-lotting"');
  });

  it('renders notices before the page inside main', () => {
    const html = render('staff', '/dashboard', <section id="page-root">x</section>);
    const main = html.slice(html.indexOf('<main'));
    expect(main.indexOf('build notice')).toBeGreaterThan(-1);
    expect(main.indexOf('build notice')).toBeLessThan(main.indexOf('id="page-root"'));
  });

  it('wraps the dashboard v2 fixture', () => {
    const html = render('admin', '/dashboard', <DashboardV2 {...dashboardV2Fixture} />);
    expect(html).toContain('console-v2-dashboard');
    expect(html.indexOf('console-v2-dashboard')).toBeGreaterThan(html.indexOf('<main'));
  });

  it('uses tokens only (no colour literals in the shell TSX)', () => {
    const dir = join(process.cwd(), 'src/app/(operator)/_shell-v2');
    for (const f of ['ConsoleShellV2.tsx', 'nav-model.ts']) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});
