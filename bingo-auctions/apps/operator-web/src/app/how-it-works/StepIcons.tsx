// StepIcons — small inline stroke glyphs for the /how-it-works step cards.
//
// Brand style: simple stroke-based glyphs, stroke ~1.75, round caps/joins,
// 24x24 viewBox, single color via currentColor so the caller sets color
// (orange accent for auction/bidder sections, cyan for pickup).
//
// Server-component safe: pure render, no hooks, no client APIs.

import type { ReactNode } from 'react';

export type StepIconName =
  | 'truck'
  | 'tag'
  | 'calendar'
  | 'gavel'
  | 'download'
  | 'search'
  | 'bolt'
  | 'card'
  | 'qr'
  | 'map'
  | 'box';

const GLYPHS: Record<StepIconName, ReactNode> = {
  truck: (
    <>
      <path d="M1 7.5A1.5 1.5 0 0 1 2.5 6H13a1 1 0 0 1 1 1v9H2a1 1 0 0 1-1-1V7.5z" />
      <path d="M14 9h3.4a1 1 0 0 1 .77.36l2.6 3.12a1 1 0 0 1 .23.64V15a1 1 0 0 1-1 1h-1" />
      <circle cx="6" cy="17.5" r="1.9" />
      <circle cx="16.5" cy="17.5" r="1.9" />
      <path d="M8 16h6.5" />
    </>
  ),
  tag: (
    <>
      <path d="M3 4a1 1 0 0 1 1-1h6.6a2 2 0 0 1 1.4.59l8.4 8.4a2 2 0 0 1 0 2.83l-5.58 5.59a2 2 0 0 1-2.83 0l-8.4-8.41A2 2 0 0 1 3 10.6V4z" />
      <circle cx="7.5" cy="7.5" r="1.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" />
    </>
  ),
  gavel: (
    <>
      <path d="m14 13-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10" />
      <path d="m16 16 6-6" />
      <path d="m8 8 6-6" />
      <path d="m9 7 8 8" />
      <path d="m21 11-8-8" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </>
  ),
  bolt: <path d="M13 2 3.5 13.5h6.3L8.8 22 20.5 9.5h-6.9L13 2z" />,
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </>
  ),
  qr: (
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
      <path d="M14 14h3v3h-3z" />
      <path d="M20.5 14v.01M14 20.5v.01M17.5 20.5h3" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  box: (
    <>
      <path d="M21 16V8l-9-5-9 5v8l9 5 9-5z" />
      <path d="m3 8 9 5 9-5" />
      <path d="M12 13v8" />
    </>
  ),
};

export function StepIcon({
  name,
  size = 28,
  color,
}: {
  name: StepIconName;
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      {GLYPHS[name]}
    </svg>
  );
}
