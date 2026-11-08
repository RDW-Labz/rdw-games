// Tiny form primitives — used everywhere in the operator console. No
// external UI lib for Phase 1; we'll layer Tailwind/CSS modules in Phase 8.

import type { ReactNode } from 'react';

export function Field(props: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const hintId = props.htmlFor ? `${props.htmlFor}-hint` : undefined;
  const errorId = props.htmlFor ? `${props.htmlFor}-error` : undefined;
  // Expose computed describedby ids as data attributes on the wrapper so
  // callers that render a native <input id={htmlFor}> can read them if
  // needed. The ids are also consumed by the hint/error <span> elements
  // below, which AT will announce via aria-describedby on the input.
  return (
    <label htmlFor={props.htmlFor} style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{props.label}</span>
      {props.children}
      {props.hint && (
        <span id={hintId} style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          {props.hint}
        </span>
      )}
      {props.error && (
        <span id={errorId} role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>
          {props.error}
        </span>
      )}
    </label>
  );
}

/**
 * Returns the aria-describedby value for an input rendered inside a Field.
 * Pass `htmlFor` (same as Field's htmlFor), `hasHint`, and `hasError`.
 * Spread the result onto the <input> element:
 *   <input id="email" {...fieldDescribedBy('email', !!hint, !!error)} />
 */
export function fieldDescribedBy(
  htmlFor: string,
  hasHint: boolean,
  hasError: boolean,
): { 'aria-describedby'?: string } {
  const ids = [
    hasHint ? `${htmlFor}-hint` : null,
    hasError ? `${htmlFor}-error` : null,
  ].filter(Boolean);
  return ids.length > 0 ? { 'aria-describedby': ids.join(' ') } : {};
}

export const inputStyle: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: 4,
  fontFamily: 'inherit',
  fontSize: 14,
};

export const buttonStyle: React.CSSProperties = {
  padding: '0.6rem 1.2rem',
  background: 'var(--accent)',
  // Dark navy ink on orange — white-on-orange fails contrast. Matches
  // .btn-primary in globals.css (Operator Console handoff Wave 0, 2026-07-13).
  color: '#15233a',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 500,
};

export const secondaryButtonStyle: React.CSSProperties = {
  padding: '0.6rem 1.2rem',
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  cursor: 'pointer',
};

export function PageHeader(props: { title: string; action?: ReactNode }) {
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1.5rem',
      }}
    >
      <h1 style={{ margin: 0 }}>{props.title}</h1>
      {props.action}
    </header>
  );
}
