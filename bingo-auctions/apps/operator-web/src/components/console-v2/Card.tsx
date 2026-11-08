import type { CSSProperties, ReactNode } from 'react';

export type CardProps = {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
};

export function Card({ children, style, className = '' }: CardProps) {
  return (
    <div className={`console-v2-card ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}
