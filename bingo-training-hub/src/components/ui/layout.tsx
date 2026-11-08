import type { ReactNode } from 'react';
import { Display, Hand } from './kit';

/* Big centred page title with handwritten margin notes (the hero pattern).
   The left note sits above the first letters (dashed underline, like a margin
   label); the right note hangs off the title's right edge at x-height. */
export function PageHero({ title, left, right, kicker, children, size = 'xl' }: { title: string; left?: string; right?: string; kicker?: ReactNode; children?: ReactNode; size?: 'xl' | 'lg' }) {
  return (
    <header className={`relative mx-auto max-w-[1200px] px-5 text-center ${size === 'xl' ? 'pb-10 pt-[104px] md:pb-14 md:pt-[136px]' : 'pb-6 pt-[100px] md:pb-8 md:pt-[132px]'}`}>
      {kicker && (
        <div className="label mb-5 flex justify-center" data-rise>
          {kicker}
        </div>
      )}
      <div className="relative inline-block max-w-full">
        {left && (
          <span className="absolute -top-10 left-1 hidden lg:block">
            <Hand rot={-4} size={21} underline>
              {left}
            </Hand>
          </span>
        )}
        <Display text={title} className={size === 'xl' ? 'text-[clamp(52px,8vw,112px)]' : 'text-[clamp(42px,6.7vw,96px)]'} />
        {right && (
          <span className="absolute left-full top-[30%] ml-4 hidden w-[190px] text-left xl:block">
            <Hand rot={-5} size={19} arrow="left">
              {right}
            </Hand>
          </span>
        )}
      </div>
      {(left || right) && (
        <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-1 xl:hidden">
          {left && (
            <span className="lg:hidden">
              <Hand rot={-3} size={17}>
                {left}
              </Hand>
            </span>
          )}
          {right && (
            <Hand rot={-3} size={17}>
              {right}
            </Hand>
          )}
        </div>
      )}
      {children && (
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3" data-rise>
          {children}
        </div>
      )}
    </header>
  );
}

const TONES = {
  manila: { bg: '#dfcfb2', edge: '#c9b48c', ink: '#373737' },
  deep: { bg: '#d5c19d', edge: '#bba57c', ink: '#373737' },
  navy: { bg: '#20386c', edge: '#152a57', ink: '#ffffff' },
  cream: { bg: '#f3ece0', edge: '#d9cfbd', ink: '#373737' },
};

/* A manila folder with a labelled tab — the section container. Hard paper
   edges, no blur. */
export function Folder({ tab, tone = 'manila', children, className = '', inner = '', id, tight }: { tab: string; tone?: keyof typeof TONES; children: ReactNode; className?: string; inner?: string; id?: string; tight?: boolean }) {
  const t = TONES[tone];
  return (
    <section id={id} className={`relative mt-12 ${className}`} data-rise>
      <div className="absolute left-[4%] top-0 z-[1] flex h-[34px] min-w-[170px] -translate-y-[33px] items-center justify-center px-12">
        <svg viewBox="0 0 190 34" className="absolute inset-0 h-full w-full overflow-visible" preserveAspectRatio="none" aria-hidden>
          <path d="M0 34C10 34 14 30 18 22L26 8C30 2 34 0 42 0H148C156 0 160 2 164 8L172 22C176 30 180 34 190 34Z" fill={t.bg} stroke={t.edge} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d="M1 33.5H189" stroke={t.bg} strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="mono relative whitespace-nowrap pt-1 text-[12px] uppercase tracking-[0.06em]" style={{ color: tone === 'navy' ? 'rgba(255,255,255,.85)' : '#414141' }}>
          {tab}
        </span>
      </div>
      <div
        className={`relative overflow-hidden px-5 md:px-12 ${tight ? 'py-6 md:py-8' : 'py-8 md:py-12'} ${inner}`}
        style={{ background: t.bg, color: t.ink, borderRadius: 4, border: `1px solid ${t.edge}`, boxShadow: `0 2px 0 ${t.edge}` }}
      >
        <div className="grain-local" style={{ opacity: tone === 'navy' ? 0.25 : 0.4 }} />
        <div className="relative">{children}</div>
      </div>
    </section>
  );
}

export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-4 md:px-8 ${className}`}>{children}</div>;
}
