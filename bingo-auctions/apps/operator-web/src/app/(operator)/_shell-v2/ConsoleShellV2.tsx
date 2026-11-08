'use client';

// Console v2 shell: sidebar + header for the (operator) group when the v2
// toggle is on. ../layout.tsx runs every auth / staff / rotate / MFA check
// first and only then picks this or the v1 JSX, so this file is presentation:
// same nav entries and role gating (nav-model.ts), same notices, same sign out,
// same ?ui=v1 switch back.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignOutLink } from '../SignOutLink';
import { ConsoleUiToggle } from '../ConsoleUiToggle';
import {
  activeNavHref,
  nextNavFocusIndex,
  pageContextFor,
  readCollapsedGroups,
  shouldCloseDrawer,
  stageForPath,
  visibleNavGroups,
  writeCollapsedGroups,
  SHELL_NAV_GROUPS,
  type ShellNavGroup,
  type ShellStage,
} from './nav-model';

export const SHELL_NAV_ID = 'console-v2-shell-nav';

export type ConsoleShellV2Props = {
  operatorName: string;
  role: string | null;
  /** Fail closed: omitted or false hides Growth. */
  growthHubEnabled?: boolean;
  /** PostHogIdentify, rendered exactly once like v1. */
  analytics?: ReactNode;
  /** BuildSkewNotice + MfaSetupBanner, in v1's order, above the page. */
  notices?: ReactNode;
  children: ReactNode;
};

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="console-v2-shell__chevron"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Down when open, right when collapsed (a path, not a rotate: reduced
          motion resets transforms). */}
      <path d={open ? 'M6 8l4 4 4-4' : 'M8 6l4 4-4 4'} />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 5h14M3 10h14M3 15h14" />
    </svg>
  );
}

function NavGroupList({
  group,
  collapsed,
  activeHref,
  stage,
  onToggle,
}: {
  group: ShellNavGroup;
  collapsed: boolean;
  activeHref: string | null;
  stage: ShellStage;
  onToggle: (id: string) => void;
}) {
  const listId = `console-v2-shell-group-${group.id}`;
  const holdsCurrent = group.items.some((i) => i.href === activeHref);
  return (
    <li className="console-v2-shell__group" data-group={group.id}>
      {group.label ? (
        <button
          type="button"
          className="console-v2-shell__group-toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => onToggle(group.id)}
        >
          <span>{group.label}</span>
          {collapsed && holdsCurrent ? (
            <span className="console-v2-shell__group-current" data-stage={stage}>
              <span className="console-v2-sr-only">(current page inside)</span>
            </span>
          ) : null}
          <ChevronIcon open={!collapsed} />
        </button>
      ) : null}
      <ul id={listId} className="console-v2-shell__list" hidden={Boolean(group.label) && collapsed}>
        {group.items.map((item) => {
          const active = item.href === activeHref;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`console-v2-shell__link${item.sub ? ' console-v2-shell__link--sub' : ''}`}
                aria-current={active ? 'page' : undefined}
                data-stage={active ? stage : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function ConsoleShellV2({
  operatorName,
  role,
  growthHubEnabled = false,
  analytics,
  notices,
  children,
}: ConsoleShellV2Props) {
  const pathname = usePathname() ?? '';
  const groups = useMemo(
    () => visibleNavGroups(role, SHELL_NAV_GROUPS, { growthHubEnabled: growthHubEnabled === true }),
    [role, growthHubEnabled],
  );
  const activeHref = activeNavHref(pathname, groups);
  const stage = stageForPath(pathname);
  const context = pageContextFor(pathname, groups);

  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Server and first client render are fully expanded; the remembered state
  // applies after hydration so the markup always matches.
  useEffect(() => {
    setCollapsed(readCollapsedGroups(safeLocalStorage()));
  }, []);

  // A nav choice lands on a new page: close the drawer behind it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      writeCollapsedGroups(safeLocalStorage(), next);
      return next;
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    navRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    function onKey(e: globalThis.KeyboardEvent) {
      if (shouldCloseDrawer(e.key, true)) {
        e.preventDefault();
        closeDrawer();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, closeDrawer]);

  function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
    const nav = navRef.current;
    if (!nav) return;
    const targets = Array.from(
      nav.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    ).filter((el) => !el.closest('[hidden]'));
    const current = targets.indexOf(document.activeElement as HTMLElement);
    const next = nextNavFocusIndex(e.key, current, targets.length);
    if (next === null) return;
    e.preventDefault();
    targets[next]?.focus();
  }

  const switchBackHref = `${pathname}?ui=v1`;

  return (
    <div
      data-console-v2
      className="console-v2-shell"
      data-drawer-open={drawerOpen ? 'true' : 'false'}
      data-stage={stage}
    >
      <a href="#main-content" className="console-v2-shell__skip">
        Skip to main content
      </a>
      {analytics}
      {/* Still owns the ?ui= param → cookie sync; its floating badge is replaced
          by the header's Switch back control under this shell. */}
      <ConsoleUiToggle v2 badge={false} />

      <nav
        ref={navRef}
        id={SHELL_NAV_ID}
        className="console-v2-shell__nav"
        aria-label="Primary navigation"
        onKeyDown={onNavKeyDown}
      >
        <Link href="/dashboard" className="console-v2-shell__brand" aria-label="BinGo Auctions dashboard">
          <span className="console-v2-shell__brand-word">BinGo</span>
          <span className="console-v2-shell__brand-sub" aria-hidden="true">
            Auctions
          </span>
        </Link>
        <ul className="console-v2-shell__groups">
          {groups.map((g) => (
            <NavGroupList
              key={g.id}
              group={g}
              collapsed={collapsed.includes(g.id)}
              activeHref={activeHref}
              stage={stage}
              onToggle={toggleGroup}
            />
          ))}
        </ul>
      </nav>
      {drawerOpen ? (
        <div className="console-v2-shell__scrim" aria-hidden="true" onClick={closeDrawer} />
      ) : null}

      <header className="console-v2-shell__header">
        <button
          ref={menuButtonRef}
          type="button"
          className="console-v2-shell__menu"
          aria-expanded={drawerOpen}
          aria-controls={SHELL_NAV_ID}
          onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
        >
          <MenuIcon />
          <span>Menu</span>
        </button>
        <div className="console-v2-shell__context">
          {context.group ? <p className="console-v2-shell__context-group">{context.group}</p> : null}
          <p className="console-v2-shell__context-page console-v2-display">
            <span className="console-v2-shell__stage-dot" data-stage={stage} aria-hidden="true" />
            {context.page}
          </p>
        </div>
        <div className="console-v2-shell__operator">
          <p className="console-v2-shell__operator-label">Operator</p>
          <p className="console-v2-shell__operator-name">{operatorName}</p>
        </div>
        <div className="console-v2-shell__actions">
          {/* Plain <a>: a full load lets ConsoleUiToggle read ?ui=v1 on mount,
              store the cookie and refresh into the v1 shell. */}
          <a href={switchBackHref} className="console-v2-shell__switch">
            Switch back to v1
          </a>
          <span className="console-v2-shell__signout">
            <SignOutLink />
          </span>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="console-v2-shell__main">
        {notices}
        {children}
      </main>
    </div>
  );
}
