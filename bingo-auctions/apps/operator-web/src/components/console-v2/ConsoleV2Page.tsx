import type { CSSProperties, ReactNode } from 'react';

export const consoleV2PageStyle: CSSProperties = {
  fontFamily: 'var(--console-font-body)',
  color: 'var(--console-ink)',
  margin: 'calc(-2rem)',
  padding: 'var(--console-page-gutter)',
  background: 'var(--console-gradient-frame)',
  minHeight: '100%',
};

export function ConsoleV2Page({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <div data-console-v2 className={`${className} console-v2-motion-page-in`} style={consoleV2PageStyle}>
      {children}
    </div>
  );
}
