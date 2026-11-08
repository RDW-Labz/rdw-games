/* Drafting glyphs — small, flat, geometric marks drawn for this system. */
import type { SVGProps } from 'react';

type G = SVGProps<SVGSVGElement> & { size?: number };
const S = ({ size = 16, children, ...p }: G & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden {...p}>
    {children}
  </svg>
);

export const Check = (p: G) => (
  <S {...p}>
    <path d="M3 8.4 6.4 11.6 13 4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </S>
);
export const Cross = (p: G) => (
  <S {...p}>
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </S>
);
export const Pen = (p: G) => (
  <S {...p}>
    <path d="M3 13l1-3.2L10.8 3l2.2 2.2L6.2 12 3 13Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M9.2 4.6l2.2 2.2" stroke="currentColor" strokeWidth="1.4" />
  </S>
);
export const Eye = (p: G) => (
  <S {...p}>
    <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </S>
);
export const Loop = (p: G) => (
  <S {...p}>
    <path d="M12.5 6.5A4.7 4.7 0 0 0 3.6 6M3.5 9.5A4.7 4.7 0 0 0 12.4 10" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12.8 3.2v3.4H9.4M3.2 12.8V9.4h3.4" stroke="currentColor" strokeWidth="1.5" />
  </S>
);
export const Empty = (p: G) => (
  <S {...p}>
    <rect x="4" y="4" width="8" height="8" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />
  </S>
);
export const Plus = (p: G) => (
  <S {...p}>
    <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.8" />
  </S>
);
export const Minus = (p: G) => (
  <S {...p}>
    <path d="M2.5 8h11" stroke="currentColor" strokeWidth="1.8" />
  </S>
);
/** Square arrow block (the drafting "go" mark). */
export const ArrowBlock = ({ size = 18, ...p }: G) => (
  <svg width={size} height={size} viewBox="0 0 19 19" aria-hidden {...p}>
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M18.8 18.2a.6.6 0 0 1-.6.6H.6a.6.6 0 0 1-.6-.6V.6C0 .3.3 0 .6 0h17.6c.3 0 .6.3.6.6zm-1.5-8.4a.5.5 0 0 0 0-.8L9.6 1.3a.5.5 0 0 0-.4-.2H2.4a.5.5 0 0 0-.4.9l7 7a.5.5 0 0 1 0 .7l-7 7a.5.5 0 0 0 .4.9h6.8a.5.5 0 0 0 .4-.2z"
    />
  </svg>
);
export const ArrowRight = (p: G) => (
  <S {...p}>
    <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </S>
);
export const ArrowDown = (p: G) => (
  <S {...p}>
    <path d="M8 2v11M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </S>
);
export const ArrowLeft = (p: G) => (
  <S {...p}>
    <path d="M14 8H3M7 4 3 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
  </S>
);
export const Chevron = ({ size = 12, ...p }: G) => (
  <svg width={size} height={(size * 10) / 12} viewBox="0 0 12 10" aria-hidden {...p}>
    <path fill="currentColor" d="M5.734 9.903a.414.414 0 0 0 .532 0l5.625-4.972A.3.3 0 0 0 12 4.699V.332c0-.296-.4-.444-.641-.232L6.266 4.602a.414.414 0 0 1-.532 0L.641.1C.408-.106 0 .042 0 .332V4.7c0 .09.036.174.11.232z" />
  </svg>
);
export const Hand = (p: G) => (
  <S {...p}>
    <path d="M5.5 8V3.2a1 1 0 0 1 2 0V7m0-3.6a1 1 0 0 1 2 0V7m0-2.6a1 1 0 0 1 2 0v4.8c0 2.6-1.7 4.3-4.1 4.3-1.6 0-2.6-.8-3.4-2.1L2.4 8.9a1 1 0 0 1 1.6-1.1L5.5 9.4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </S>
);
export const Play = (p: G) => (
  <S {...p}>
    <path d="M5 3.2v9.6L12.6 8 5 3.2Z" fill="currentColor" />
  </S>
);
export const Search = (p: G) => (
  <S {...p}>
    <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.5" />
    <path d="m10.4 10.4 3.4 3.4" stroke="currentColor" strokeWidth="1.5" />
  </S>
);
export const Trash = (p: G) => (
  <S {...p}>
    <path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 8.5h6l.6-8.5" stroke="currentColor" strokeWidth="1.4" />
  </S>
);
export const Edit = Pen;
export const Clock = (p: G) => (
  <S {...p}>
    <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 4.8V8l2.2 1.6" stroke="currentColor" strokeWidth="1.4" />
  </S>
);
export const Pin = (p: G) => (
  <S {...p}>
    <path d="M8 14.5s4.5-4.3 4.5-7.8a4.5 4.5 0 0 0-9 0c0 3.5 4.5 7.8 4.5 7.8Z" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="6.7" r="1.6" fill="currentColor" />
  </S>
);
export const Badge = (p: G) => (
  <S {...p}>
    <rect x="2.5" y="4" width="11" height="9" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6 4V2.5h4V4M5 8h6M5 10.5h3.5" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Grid = (p: G) => (
  <S {...p}>
    <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Users = (p: G) => (
  <S {...p}>
    <circle cx="6" cy="5.5" r="2.4" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8" stroke="currentColor" strokeWidth="1.3" />
    <path d="M10.5 3.4a2.3 2.3 0 0 1 0 4.4M12 9.9c1.2.5 2 1.7 2.2 3.6" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Book = (p: G) => (
  <S {...p}>
    <path d="M8 4.2C6.6 3.2 4.6 2.8 2.5 3v9.6c2.1-.2 4.1.2 5.5 1.2m0-9.6c1.4-1 3.4-1.4 5.5-1.2v9.6c-2.1-.2-4.1.2-5.5 1.2m0-9.6v9.6" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Clipboard = (p: G) => (
  <S {...p}>
    <rect x="3" y="3" width="10" height="11" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 2h4v2H6zM5.5 7.5h5M5.5 10h3.5" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Logout = (p: G) => (
  <S {...p}>
    <path d="M6.5 2.5h-4v11h4M10 5l3 3-3 3M13 8H6" stroke="currentColor" strokeWidth="1.4" />
  </S>
);
export const Menu = (p: G) => (
  <S {...p}>
    <path d="M2 5h12M2 11h12" stroke="currentColor" strokeWidth="1.5" />
  </S>
);
export const Calendar = (p: G) => (
  <S {...p}>
    <rect x="2.5" y="3.5" width="11" height="10" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.3" />
  </S>
);
export const Image = (p: G) => (
  <S {...p}>
    <rect x="2" y="3" width="12" height="10" stroke="currentColor" strokeWidth="1.3" />
    <path d="m3 12 3.5-4 2.5 2.6L11 8.5l2 2.5" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="10.5" cy="5.6" r="1" fill="currentColor" />
  </S>
);

/** Hand-drawn arrow used next to handwritten notes. */
export const SketchArrow = ({ className = '', flip = false }: { className?: string; flip?: boolean }) => (
  <svg viewBox="0 0 46 18" width="46" height="18" className={className} style={flip ? { transform: 'scaleX(-1)' } : undefined} aria-hidden>
    <path d="M1.5 10.5c8-2.2 21-3.8 39-1.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M34.5 4.2c2.6 1.6 5 3.2 7 4.9-2.2 1.2-4.7 2.6-7.2 4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const StatusGlyph = ({ glyph, size = 12 }: { glyph: 'empty' | 'x' | 'pen' | 'eye' | 'check' | 'loop'; size?: number }) => {
  const m = { empty: Empty, x: Cross, pen: Pen, eye: Eye, check: Check, loop: Loop }[glyph];
  const C = m;
  return <C size={size} />;
};
