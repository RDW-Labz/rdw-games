'use client';

import { useCallback, useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { LotIdentity } from './LotIdentity';
import { Button } from './Button';
import { panelStyle } from './styles';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  children?: ReactNode;
  lot?: {
    lot_code: string;
    sticker_code?: string | null;
    display_code?: string | null;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmDisabled?: boolean;
  confirmDisabledReason?: string;
  loading?: boolean;
  error?: string;
  forceFocusCancel?: boolean;
  /** Inline gallery preview — no fixed scrim. */
  preview?: boolean;
};

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--console-scrim)',
  zIndex: 'var(--console-z-scrim)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--console-page-gutter)',
};

const panel: CSSProperties = {
  background: 'var(--console-surface-raised)',
  border: 'var(--console-border-width) solid var(--console-border-strong)',
  borderRadius: 'var(--console-radius-panel)',
  boxShadow: 'var(--console-elevation-dialog)',
  maxWidth: '480px',
  width: '100%',
  padding: 'var(--console-space-6)',
  zIndex: 'var(--console-z-dialog)',
};

export function ConfirmDialog({
  open,
  title,
  children,
  lot,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  confirmDisabled,
  confirmDisabledReason,
  loading,
  error,
  forceFocusCancel,
  preview,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      cancelRef.current?.focus();
    } else if (triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel?.();
      }
    },
    [onCancel],
  );

  if (!preview && !open) return null;

  const dialogPanel = (
      <div
        role="dialog"
        aria-modal={preview ? undefined : 'true'}
        aria-labelledby={titleId}
        style={preview ? { ...panelStyle, maxWidth: '480px', width: '100%' } : panel}
      >
        <h2 id={titleId} style={{ fontSize: 'var(--console-text-title)', margin: '0 0 var(--console-space-3)', color: 'var(--console-ink)' }}>
          {title}
        </h2>
        {lot ? <LotIdentity lot={lot} /> : null}
        <div style={{ margin: 'var(--console-space-4) 0', color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-base)' }}>
          {children}
        </div>
        {error ? (
          <p role="alert" style={{ color: 'var(--console-danger)', fontSize: 'var(--console-text-sm)' }}>{error}</p>
        ) : null}
        {confirmDisabledReason ? (
          <p style={{ color: 'var(--console-ink-dim)', fontSize: 'var(--console-text-sm)' }}>{confirmDisabledReason}</p>
        ) : null}
        <div style={{ display: 'flex', gap: 'var(--console-space-2)', flexWrap: 'wrap', marginTop: 'var(--console-space-4)' }}>
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} forceState={forceFocusCancel ? 'focus' : undefined}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="primary-lime" disabled={confirmDisabled} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
  );

  if (preview) {
    return dialogPanel;
  }

  return (
    <div style={scrim} onKeyDown={onKeyDown}>
      {dialogPanel}
    </div>
  );
}
