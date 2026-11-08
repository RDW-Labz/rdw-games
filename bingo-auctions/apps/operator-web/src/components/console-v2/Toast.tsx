'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type ToastVariant = 'default' | 'success' | 'error' | 'info' | 'loading';

export type ToastProps = {
  message: string;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  forceHoverAction?: boolean;
  forceFocusClose?: boolean;
  actionForceState?: GalleryVisualState;
  actionDisabledReason?: string;
  children?: ReactNode;
};

const toastBase: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--console-space-3)',
  padding: 'var(--console-space-3) var(--console-space-4)',
  borderRadius: 'var(--console-radius-panel)',
  border: 'var(--console-border-width) solid var(--console-border-strong)',
  background: 'var(--console-surface-raised)',
  boxShadow: 'var(--console-elevation-popover)',
  maxWidth: '420px',
  color: 'var(--console-ink)',
  fontSize: 'var(--console-text-base)',
};

function variantColors(variant: ToastVariant): CSSProperties {
  switch (variant) {
    case 'success':
      return { borderColor: 'var(--console-success)', color: 'var(--console-success)' };
    case 'error':
      return { borderColor: 'var(--console-danger)', color: 'var(--console-danger)' };
    case 'info':
      return { borderColor: 'var(--console-stage-intake-fg)', color: 'var(--console-stage-intake-text)' };
    case 'loading':
      return { color: 'var(--console-ink-secondary)' };
    default:
      return {};
  }
}

export function Toast({
  message,
  variant = 'default',
  actionLabel,
  onAction,
  onClose,
  forceHoverAction,
  forceFocusClose,
  actionForceState,
  actionDisabledReason,
}: ToastProps) {
  const actionState = actionForceState ?? (forceHoverAction ? 'hover' : undefined);
  if (!message) return null;

  return (
    <div style={{ ...toastBase, ...variantColors(variant) }} role="status">
      <div style={{ flex: 1 }}>{message}</div>
      {actionLabel ? (
        <Button
          type="button"
          variant="secondary"
          className="console-v2-toast-action"
          onClick={onAction}
          disabled={!!actionDisabledReason}
          forceState={actionState}
        >
          {actionLabel}
        </Button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onClose}
        className="console-v2-btn console-v2-btn--secondary"
        style={{
          minHeight: 'var(--console-control-min)',
          minWidth: 'var(--console-control-min)',
        }}
        {...galleryStateProps(forceFocusClose ? 'focus' : undefined)}
      >
        ×
      </button>
      {actionDisabledReason ? (
        <span style={{ fontSize: 'var(--console-text-helper)', color: 'var(--console-ink-dim)' }}>{actionDisabledReason}</span>
      ) : null}
    </div>
  );
}

export function ToastRegion({ children }: { children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'var(--console-space-6)',
        right: 'var(--console-page-gutter)',
        zIndex: 'var(--console-z-toast)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--console-space-2)',
      }}
    >
      {children}
    </div>
  );
}
