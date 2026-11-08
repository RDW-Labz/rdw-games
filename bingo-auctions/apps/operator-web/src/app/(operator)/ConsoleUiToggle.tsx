'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  cookieHeaderFor,
  parseUiParam,
  stripUiParam,
} from '@/lib/console-ui';

// `badge={false}`: the v2 shell shows its own Switch back control in the
// header, but still needs this component's ?ui= → cookie sync.
export function ConsoleUiToggle({ v2, badge = true }: { v2: boolean; badge?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const choice = parseUiParam(window.location.search);
    if (!choice) return;

    const secure = window.location.protocol === 'https:';
    document.cookie = cookieHeaderFor(choice, secure);

    const nextUrl = stripUiParam(window.location.href);
    window.history.replaceState(window.history.state, '', nextUrl);

    const becomesV2 = choice === 'v2';
    if (becomesV2 !== v2) {
      router.refresh();
    }
  }, [router, v2]);

  if (!v2 || !badge) {
    return null;
  }

  const switchBackHref = `${pathname}?ui=v1`;

  return (
    <div
      data-console-v2
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        minHeight: 'var(--console-control-min, 44px)',
        padding: 'var(--console-space-2) var(--console-space-3)',
        background: 'var(--console-surface-raised)',
        color: 'var(--console-ink-secondary)',
        borderTopRightRadius: 'var(--console-radius-panel)',
        border: 'var(--console-border-width) solid var(--console-border)',
        borderLeft: 'none',
        borderBottom: 'none',
        fontSize: 'var(--console-text-sm)',
        fontFamily: 'var(--console-font-body)',
        boxShadow: 'var(--console-shadow-elevated, 0 4px 12px rgba(0,0,0,0.25))',
      }}
      role="status"
      aria-label="Console v2 is on. Switch back to the current console"
    >
      <span>
        Console v2 ·{' '}
        <Link
          href={switchBackHref}
          style={{
            color: 'var(--console-link)',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            minHeight: 44,
            minWidth: 44,
            display: 'inline-flex',
            alignItems: 'center',
          }}
          className="console-v2-switch-back"
        >
          Switch back
        </Link>
      </span>
      <style>{`
        [data-console-v2] a.console-v2-switch-back:focus-visible {
          outline: 2px solid var(--console-link);
          outline-offset: 2px;
          border-radius: var(--console-radius-control, 4px);
        }
      `}</style>
    </div>
  );
}
