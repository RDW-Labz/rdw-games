'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { type GalleryVisualState, galleryStateProps } from './gallery-state';

export type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  children: ReactNode;
  showDot?: boolean;
  forceState?: GalleryVisualState;
};

export function Chip({
  selected,
  removable,
  onRemove,
  children,
  showDot = true,
  disabled,
  className = '',
  type = 'button',
  forceState,
  ...rest
}: ChipProps) {
  const classes = [
    'console-v2-chip',
    'console-v2-pressable',
    selected ? 'console-v2-chip--selected' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      aria-pressed={selected || undefined}
      {...galleryStateProps(forceState)}
      {...rest}
    >
      {showDot ? <span className="console-v2-chip__dot" aria-hidden="true" /> : null}
      <span>{children}</span>
      {removable && onRemove ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }
          }}
          style={{ marginLeft: 'var(--console-space-1)', fontWeight: 'var(--console-weight-strong)' }}
        >
          ×
        </span>
      ) : null}
    </button>
  );
}
