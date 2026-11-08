import type { CSSProperties } from 'react';
import { statusPresentation, type ConsoleGalleryStatus } from './status';

export type StatusPillProps = {
  status: ConsoleGalleryStatus | string;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  domainHint?: string;
  /** Operator wording when it differs from the meaning's label ("Completed · 4:12 PM"). */
  label?: string;
};

const basePill: CSSProperties = {
  fontSize: 'var(--console-text-xs)',
  fontWeight: 'var(--console-weight-strong)',
  lineHeight: 'var(--console-leading-control)',
};

export function StatusPill({ status, loading, error, empty, domainHint, label }: StatusPillProps) {
  if (empty) {
    return (
      <span className="console-v2-status-pill" style={{ ...basePill, background: 'var(--console-neutral-bg)', color: 'var(--console-ink-dim)' }}>
        Not recorded
      </span>
    );
  }
  if (loading) {
    return (
      <span className="console-v2-status-pill" style={{ ...basePill, background: 'var(--console-neutral-bg)', color: 'var(--console-neutral)' }}>
        Checking status
      </span>
    );
  }
  if (error) {
    return (
      <span className="console-v2-status-pill" style={{ ...basePill, background: 'var(--console-neutral-bg)', color: 'var(--console-ink-secondary)' }}>
        Status unavailable
      </span>
    );
  }

  const pres = statusPresentation(status);
  return (
    <span
      className="console-v2-status-pill"
      style={{
        ...basePill,
        background: pres.background,
        color: pres.foreground,
      }}
      title={domainHint ?? pres.domain}
    >
      {label ?? pres.label}
    </span>
  );
}
