'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type ConsoleButtonVariant = 'primary-lime' | 'secondary' | 'ghost' | 'danger';
export type ConsoleButtonSize = 'md' | 'sm';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: ConsoleButtonVariant;
  size?: ConsoleButtonSize;
  loading?: boolean;
  forceState?: GalleryVisualState;
  className?: string;
  children: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
  variant = 'primary-lime',
  size = 'md',
  loading,
  forceState,
  disabled,
  children,
  className = '',
  type = 'button',
  ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const classes = [
    'console-v2-btn',
    'console-v2-pressable',
    `console-v2-btn--${variant}`,
    size === 'sm' ? 'console-v2-btn--sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-busy={loading || undefined}
      {...galleryStateProps(forceState)}
      {...rest}
    >
      {loading ? <span className="console-v2-btn__spinner" aria-hidden="true" /> : null}
      <span>{loading ? 'Working…' : children}</span>
    </button>
  );
});
