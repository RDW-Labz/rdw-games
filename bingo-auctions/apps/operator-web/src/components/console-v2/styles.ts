import type { CSSProperties } from 'react';

export const focusRing: CSSProperties = {
  outline: 'var(--console-focus-width) solid var(--console-focus)',
  outlineOffset: 'var(--console-focus-offset)',
};

export const controlBase: CSSProperties = {
  minHeight: 'var(--console-control-min)',
  fontSize: 'var(--console-text-base)',
  fontFamily: 'var(--console-font-body)',
  fontWeight: 'var(--console-weight-strong)',
  lineHeight: 'var(--console-leading-control)',
  color: 'var(--console-ink)',
  background: 'var(--console-code-bg)',
  border: 'var(--console-border-width) solid var(--console-border-strong)',
  borderRadius: 'var(--console-radius-control)',
  padding: '10px 14px',
  transition: `border-color var(--console-duration-fast) var(--console-ease-standard), background var(--console-duration-fast) var(--console-ease-standard)`,
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--console-text-sm)',
  fontWeight: 'var(--console-weight-label)',
  letterSpacing: 'var(--console-tracking-label)',
  textTransform: 'uppercase',
  color: 'var(--console-ink-secondary)',
  marginBottom: 'var(--console-space-1)',
};

export const panelStyle: CSSProperties = {
  background: 'var(--console-gradient-section)',
  border: 'var(--console-border-width) solid var(--console-line)',
  borderRadius: 'var(--console-radius-panel)',
  padding: 'var(--console-space-5)',
  boxShadow: 'inset 0 0 0 1px var(--console-line), var(--console-shadow-card)',
};

export const buttonPrimary: CSSProperties = {
  minHeight: 'var(--console-control-min)',
  fontSize: 'var(--console-text-base)',
  fontFamily: 'var(--console-font-body)',
  fontWeight: 'var(--console-weight-strong)',
  lineHeight: 'var(--console-leading-control)',
  background: 'var(--console-gradient-primary)',
  color: 'var(--console-on-action)',
  border: 'none',
  borderRadius: 'var(--console-radius-pill)',
  cursor: 'pointer',
  padding: '10px 20px',
};

export const buttonSecondary: CSSProperties = {
  minHeight: 'var(--console-control-min)',
  fontSize: 'var(--console-text-base)',
  fontFamily: 'var(--console-font-body)',
  fontWeight: 'var(--console-weight-strong)',
  lineHeight: 'var(--console-leading-control)',
  background: 'var(--console-surface-raised)',
  color: 'var(--console-ink)',
  border: 'var(--console-border-width) solid var(--console-border-strong)',
  borderRadius: 'var(--console-radius-pill)',
  cursor: 'pointer',
  padding: '10px 20px',
};
