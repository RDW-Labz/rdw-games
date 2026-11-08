import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';

export function WarehouseFormPageV2({
  title,
  backHref,
  backLabel,
  intro,
  children,
  className = 'console-v2-warehouse-form',
}: {
  title: string;
  backHref: string;
  backLabel: string;
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ConsoleV2Page className={className}>
      <header className="console-v2-motion-reveal console-v2-warehouse-form-head">
        <h1 className="console-v2-display">{title}</h1>
        <Link href={backHref} className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
          {backLabel}
        </Link>
      </header>
      {intro ? (
        <p className="console-v2-warehouse-form-intro console-v2-motion-reveal" style={{ color: 'var(--console-ink-secondary)' }}>
          {intro}
        </p>
      ) : null}
      <div className="console-v2-warehouse-form-body console-v2-motion-reveal">{children}</div>
    </ConsoleV2Page>
  );
}
