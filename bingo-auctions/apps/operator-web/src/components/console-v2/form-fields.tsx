'use client';

import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { labelStyle } from './styles';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

function resolveGalleryState(forceHover?: boolean, forceFocus?: boolean, forceState?: GalleryVisualState): GalleryVisualState | undefined {
  if (forceState) return forceState;
  if (forceFocus) return 'focus';
  if (forceHover) return 'hover';
  return undefined;
}

type FieldShellProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  success?: string;
  required?: boolean;
  disabledReason?: string;
};

function fieldShell(
  props: FieldShellProps,
  control: (describedBy: string | undefined) => ReactNode,
  extra?: CSSProperties,
) {
  const describedBy = [
    props.hint ? `${props.id}-hint` : null,
    props.error ? `${props.id}-error` : null,
    props.success ? `${props.id}-success` : null,
    props.disabledReason ? `${props.id}-disabled` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div style={{ marginBottom: 'var(--console-space-4)', ...extra }}>
      <label htmlFor={props.id} style={labelStyle}>
        {props.label}
        {props.required ? (
          <span aria-hidden="true" style={{ color: 'var(--console-warning)' }}> *</span>
        ) : null}
      </label>
      {control(describedBy || undefined)}
      {props.hint ? (
        <p id={`${props.id}-hint`} style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0' }}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={`${props.id}-error`} role="alert" style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-danger)', margin: 'var(--console-space-1) 0 0' }}>
          {props.error}
        </p>
      ) : null}
      {props.success ? (
        <p id={`${props.id}-success`} style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-success)', margin: 'var(--console-space-1) 0 0' }}>
          {props.success}
        </p>
      ) : null}
      {props.disabledReason ? (
        <p id={`${props.id}-disabled`} style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0' }}>
          {props.disabledReason}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = FieldShellProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'style'> & {
    forceHover?: boolean;
    forceFocus?: boolean;
    forceState?: GalleryVisualState;
  };

export function TextField({
  id,
  label,
  hint,
  error,
  success,
  required,
  disabledReason,
  forceHover,
  forceFocus,
  forceState,
  disabled,
  readOnly,
  ...inputProps
}: TextFieldProps) {
  const inputStyle: CSSProperties = {
    width: '100%',
    ...(error ? { borderColor: 'var(--console-danger)' } : {}),
  };

  return fieldShell(
    { id, label, hint, error, success, required, disabledReason },
    (describedBy) => (
    <input
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      aria-required={required || undefined}
      disabled={disabled}
      readOnly={readOnly}
      className="console-v2-field console-v2-input-fill"
      style={inputStyle}
      {...galleryStateProps(resolveGalleryState(forceHover, forceFocus, forceState))}
      {...inputProps}
    />
    ),
  );
}

export type SelectFieldProps = FieldShellProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'style'> & {
    options: { value: string; label: string }[];
    forceHover?: boolean;
    forceFocus?: boolean;
    forceState?: GalleryVisualState;
  };

export function SelectField({
  id,
  label,
  hint,
  error,
  success,
  required,
  disabledReason,
  options,
  forceHover,
  forceFocus,
  forceState,
  disabled,
  ...selectProps
}: SelectFieldProps) {
  const selectStyle: CSSProperties = {
    width: '100%',
    ...(error ? { borderColor: 'var(--console-danger)' } : {}),
  };

  return fieldShell(
    { id, label, hint, error, success, required, disabledReason },
    (describedBy) => (
    <select
      id={id}
      disabled={disabled}
      aria-describedby={describedBy}
      className="console-v2-field console-v2-input-fill console-v2-filter-select"
      style={selectStyle}
      {...galleryStateProps(resolveGalleryState(forceHover, forceFocus, forceState))}
      {...selectProps}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
    ),
  );
}

export type CheckboxProps = {
  id: string;
  label: string;
  hint?: string;
  disabledReason?: string;
  forceFocus?: boolean;
  forceState?: GalleryVisualState;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'style'>;

export function Checkbox({ id, label, hint, disabledReason, forceFocus, forceState, disabled, ...rest }: CheckboxProps) {
  return (
    <div style={{ marginBottom: 'var(--console-space-4)' }}>
      <label
        htmlFor={id}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--console-space-2)',
          minHeight: 'var(--console-control-min)',
          fontSize: 'var(--console-text-base)',
          color: 'var(--console-ink)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          className="console-v2-checkbox"
          style={{
            width: '20px',
            height: '20px',
            accentColor: 'var(--console-action)',
          }}
          {...galleryStateProps(resolveGalleryState(undefined, forceFocus, forceState))}
          {...rest}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0 var(--console-space-6)' }}>
          {hint}
        </p>
      ) : null}
      {disabledReason ? (
        <p style={{ fontSize: 'var(--console-text-sm)', color: 'var(--console-ink-dim)', margin: 'var(--console-space-1) 0 0 var(--console-space-6)' }}>
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
