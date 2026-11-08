/* BinGo Training mark: a navy tile holding a lot crate drawn in white line,
   with an orange "passed" tag on its corner. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden className="flex-none">
      <rect x="0" y="0" width="30" height="30" rx="2" fill="#283f7d" />
      <path d="M6.5 12.5 15 8l8.5 4.5v9.2L15 26l-8.5-4.3z" fill="none" stroke="#fdf8f0" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M6.5 12.5 15 17l8.5-4.5M15 17v9" fill="none" stroke="#fdf8f0" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10.8 10.2l8.5 4.5" stroke="#fdf8f0" strokeWidth="1.2" opacity=".7" />
      <rect x="19" y="3" width="8" height="8" rx="1" fill="#ec633d" />
      <path d="M20.8 7.1l1.6 1.6 2.9-3" fill="none" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

export function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5 leading-none">
      <span className={`text-[18px] font-semibold tracking-[-0.045em] ${dark ? 'text-white' : 'text-ink-strong'}`}>BinGo</span>
      <span className={`hand text-[13px] ${dark ? 'text-white/70' : 'text-ink-2'}`} style={{ transform: 'rotate(-4deg)', display: 'inline-block' }}>
        training
      </span>
    </span>
  );
}
