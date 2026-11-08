import { Fragment, type ButtonHTMLAttributes, type ReactNode, type AnchorHTMLAttributes } from 'react';
import { STATUS, type TrainingStatus, dueLabel } from '@/lib/status';
import { useCountUp } from '@/lib/motion';
import { ArrowBlock, SketchArrow, StatusGlyph, Calendar } from './Glyph';

/* ---------------- Button ----------------
   Mono label that rolls up on hover; an icon tile that flips like a
   drafting-table hinge. Variants: primary (navy), cream, orange, ghost, danger. */
type Variant = 'primary' | 'cream' | 'orange' | 'ghost' | 'danger';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'sm';
  icon?: ReactNode | false;
  tile?: string; // tile colour behind the icon
  full?: boolean;
}

const tileFor: Record<Variant, string> = { primary: '#ec633d', cream: '#283f7d', orange: '#283f7d', ghost: 'transparent', danger: '#e76051' };

function Roll({ children }: { children: ReactNode }) {
  return (
    <span className="relative block overflow-hidden" style={{ height: '1.1em' }}>
      <span className="block transition-transform duration-[650ms] ease-joe-inout group-hover/btn:-translate-y-full">{children}</span>
      <span aria-hidden className="absolute left-0 top-full block transition-transform duration-[650ms] ease-joe-inout group-hover/btn:-translate-y-full">
        {children}
      </span>
    </span>
  );
}

function Tile({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="btn-icon text-white" style={{ background: color }}>
      <span className="absolute inset-0 origin-bottom scale-y-0 bg-black/15 transition-transform duration-[600ms] ease-joe-inout group-hover/btn:scale-y-100" />
      <span className="relative flex transition-transform duration-[650ms] ease-joe-inout group-hover/btn:translate-x-[160%]">{children}</span>
      <span aria-hidden className="absolute flex -translate-x-[160%] transition-transform duration-[650ms] ease-joe-inout group-hover/btn:translate-x-0">
        {children}
      </span>
    </span>
  );
}

export function Button({ variant = 'primary', size = 'md', icon, tile, full, className = '', children, ...rest }: BtnProps) {
  const ic = icon === false ? null : icon ?? <ArrowBlock size={size === 'sm' ? 13 : 16} />;
  return (
    <button {...rest} className={`group/btn btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${ic ? '' : 'btn-noicon'} ${full ? 'w-full' : ''} ${className}`}>
      {ic && <Tile color={tile ?? tileFor[variant]}>{ic}</Tile>}
      <Roll>{children}</Roll>
    </button>
  );
}

export function LinkButton({ variant = 'primary', size = 'md', icon, tile, className = '', children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: 'md' | 'sm'; icon?: ReactNode | false; tile?: string }) {
  const ic = icon === false ? null : icon ?? <ArrowBlock size={size === 'sm' ? 13 : 16} />;
  return (
    <a {...rest} className={`group/btn btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${ic ? '' : 'btn-noicon'} ${className}`}>
      {ic && <Tile color={tile ?? tileFor[variant]}>{ic}</Tile>}
      <Roll>{children}</Roll>
    </a>
  );
}

/* ---------------- Status tag ---------------- */
export function StatusTag({ status, compact = false }: { status: TrainingStatus; compact?: boolean }) {
  const m = STATUS[status];
  return (
    <span className="tag" style={{ color: m.ink }}>
      <span className="tag-dot text-white" style={{ background: m.color }}>
        <StatusGlyph glyph={m.glyph} size={10} />
      </span>
      {compact ? m.short : m.label}
    </span>
  );
}

export function DueTag({ due }: { due: string | null }) {
  const d = dueLabel(due);
  if (!d) return null;
  const c = d.tone === 'late' ? '#c8382f' : d.tone === 'soon' ? '#b8441f' : '#636363';
  return (
    <span className="tag" style={{ color: c, borderStyle: d.tone === 'later' ? 'dashed' : 'solid' }}>
      <span className="tag-dot" style={{ color: c }}>
        <Calendar size={11} />
      </span>
      {d.text}
    </span>
  );
}

/* ---------------- Ruler progress ----------------
   A scale ruler: ticks every 10%, filled with navy ink, with the
   percentage set in display type. */
export function Ruler({ value, label, tone = '#283f7d', height = 14, ticks = true }: { value: number; label?: string; tone?: string; height?: number; ticks?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full">
      <div className="relative w-full border border-ink-rule bg-sheet-2" style={{ height }}>
        <div className="absolute inset-y-0 left-0 transition-[width] duration-[1200ms] ease-joe-out" style={{ width: `${v}%`, background: tone }} />
        {v > 0 && v < 100 && <div className="absolute inset-y-[-4px] w-px bg-ink-strong transition-[left] duration-[1200ms] ease-joe-out" style={{ left: `${v}%` }} />}
      </div>
      {ticks && (
        <div className="relative mt-[3px] h-[7px]">
          {Array.from({ length: 21 }, (_, i) => (
            <span key={i} className="absolute top-0 w-px bg-ink-2" style={{ left: `${i * 5}%`, height: i % 2 === 0 ? 7 : 4, opacity: i % 2 === 0 ? 0.8 : 0.45 }} />
          ))}
        </div>
      )}
      {label && <div className="label mt-2">{label}</div>}
    </div>
  );
}

/* ---------------- Display text (char-split for the typewriter reveal) ---------------- */
export function Display({ text, as: Tag = 'h1', className = '', style }: { text: string; as?: 'h1' | 'h2' | 'h3' | 'div'; className?: string; style?: React.CSSProperties }) {
  const words = text.split(' ');
  return (
    <Tag className={`display ${className}`} style={style} data-chars aria-label={text}>
      {words.map((w, wi) => (
        <Fragment key={wi}>
          <span className="inline-block whitespace-nowrap" aria-hidden>
            {Array.from(w).map((c, ci) => (
              <span key={ci} className="ch inline-block">
                {c}
              </span>
            ))}
          </span>
          {wi < words.length - 1 && ' '}
        </Fragment>
      ))}
    </Tag>
  );
}

/* ---------------- Handwritten note ---------------- */
function handText(children: ReactNode): ReactNode {
  return children; // digits come from the HandDigits face (see index.css)
}

export function Hand({ children, rot = -4, arrow, className = '', size = 20, color, underline }: { children: ReactNode; rot?: number; arrow?: 'left' | 'right' | false; className?: string; size?: number; color?: string; underline?: boolean }) {
  return (
    <span data-hand data-rot={rot} className={`hand inline-flex items-center gap-2 ${className}`} style={{ transform: `rotate(${rot}deg)`, fontSize: size, color }}>
      {arrow === 'left' && <SketchArrow flip className="shrink-0" />}
      <span className={underline ? 'border-b border-dashed border-current pb-[3px]' : undefined}>{handText(children)}</span>
      {arrow === 'right' && <SketchArrow className="shrink-0" />}
    </span>
  );
}

/* ---------------- Initials stamp ---------------- */
export function Stamp({ name, size = 40, dim = false }: { name: string; size?: number; dim?: boolean }) {
  const initials = name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  const c = '#3e4d72';
  return (
    <span
      className="mono relative inline-flex flex-none items-center justify-center text-white"
      style={{ width: size, height: size, background: dim ? '#b9b2a6' : c, fontSize: size * 0.34, borderRadius: 2, boxShadow: '3px -2px 0 rgba(0,0,0,.1)' }}
      aria-hidden
    >
      {initials}
      <span className="absolute inset-[3px] border border-white/35" />
    </span>
  );
}

/* ---------------- Section heading ---------------- */
export function SectionHead({ n, title, note, right, id }: { n?: string | number; title: string; note?: string; right?: ReactNode; id?: string }) {
  return (
    <div id={id} className="mb-5 flex items-end justify-between gap-4">
      <div className="flex min-w-0 items-end gap-3">
        {n !== undefined && (
          <span className="mono flex h-7 min-w-7 items-center justify-center border border-ink-rule px-1 text-[12px] text-ink" style={{ borderRadius: 2 }}>
            {String(n).padStart(2, '0')}
          </span>
        )}
        <div className="min-w-0">
          {note && (
            <Hand rot={-3} size={15} className="mb-1 block">
              {note}
            </Hand>
          )}
          <h2 className="title truncate text-[26px] md:text-[32px]">{title}</h2>
        </div>
      </div>
      {right}
    </div>
  );
}

/* ---------------- Stat plate ---------------- */
export function Stat({ value, label, tone = '#373737', note, onClick, active }: { value: number; label: string; tone?: string; note?: string; onClick?: () => void; active?: boolean }) {
  const ref = useCountUp(value);
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      data-rise
      aria-pressed={onClick ? !!active : undefined}
      className={`group relative flex min-h-[88px] flex-col justify-between overflow-hidden p-3.5 text-left transition-transform duration-500 ease-joe-out md:min-h-[132px] md:p-4 ${onClick ? 'hover:-translate-y-[2px]' : ''} ${active ? 'sheet' : 'sheet-flat'}`}
    >
      {active && <span className="absolute inset-x-0 top-0 h-[4px]" style={{ background: tone === '#373737' ? '#283f7d' : tone }} />}
      <div className="flex items-center justify-between">
        <span className="label" style={active ? { color: '#212121' } : undefined}>{label}</span>
        {active ? (
          <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] text-ink-2">
            <span className="h-2 w-2" style={{ background: tone, borderRadius: 1 }} /> showing
          </span>
        ) : (
          <span className="h-3 w-3" style={{ background: tone, borderRadius: 1 }} />
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span ref={ref} className="display tabular text-[40px] md:text-[64px]" style={{ color: tone === '#373737' ? '#373737' : tone, letterSpacing: '-0.04em' }}>
          0
        </span>
        {note && <span className="hand mb-1 text-right text-[13px] md:mb-2 md:text-[14px]">{note}</span>}
      </div>
    </Comp>
  );
}

/* ---------------- Form bits ---------------- */
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="field-label">
        <span>{label}</span>
        {hint && <span className="normal-case tracking-normal text-ink-3">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Toggle({ checked, onChange, label, sub }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 text-left">
      <span className="relative h-[26px] w-[48px] flex-none transition-colors duration-300" style={{ background: checked ? '#283f7d' : '#c1baae', borderRadius: 13, boxShadow: 'inset 0 1px 2px rgba(0,0,0,.18)' }}>
        <span className="absolute top-[3px] h-[20px] w-[20px] bg-white transition-[left] duration-500 ease-joe-out" style={{ left: checked ? 25 : 3, borderRadius: 10, boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
      </span>
      <span className="mono w-7 flex-none text-[11px] uppercase tracking-[0.06em]" style={{ color: checked ? '#283f7d' : '#8b8b8b' }}>
        {checked ? 'On' : 'Off'}
      </span>
      <span>
        <span className="block text-[15px] font-medium tracking-tightish text-ink">{label}</span>
        {sub && <span className="block text-[13px] text-ink-2">{sub}</span>}
      </span>
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="relative flex h-12 border border-ink-rule/30 bg-sheet-2 p-1" style={{ borderRadius: 4 }} role="tablist">
      <span
        className="absolute bottom-1 top-1 bg-navy transition-[left] duration-500 ease-joe-out"
        style={{ width: `calc((100% - 8px) / ${options.length})`, left: `calc(4px + ${idx} * (100% - 8px) / ${options.length})`, borderRadius: 2, boxShadow: '3px -2px 0 rgba(0,0,0,.12)' }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`mono relative z-[1] flex-1 text-[13px] transition-colors duration-300 ${o.value === value ? 'text-white' : 'text-ink-2 hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Empty + loading ---------------- */
export function EmptyNote({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <div className="sheet-flat relative flex flex-col items-center px-6 py-12 text-center" data-rise>
      <svg width="88" height="64" viewBox="0 0 88 64" className="mb-5 text-ink-2" aria-hidden>
        <rect x="10" y="14" width="68" height="44" fill="none" stroke="currentColor" strokeDasharray="4 3" />
        <path d="M10 14 26 4h52l-0 10" fill="none" stroke="currentColor" />
        <path d="M30 36h28M36 44h16" stroke="currentColor" />
      </svg>
      <p className="title text-[22px]">{title}</p>
      {note && <Hand className="mt-3" rot={-2} size={16}>{note}</Hand>}
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function LoadingSheet({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sheet-flat flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

/* Pin / tape decoration for pinned sheets */
export function Tape({ className = '', rot = -6 }: { className?: string; rot?: number }) {
  return <span aria-hidden className={`absolute h-5 w-16 ${className}`} style={{ background: 'rgba(236, 226, 205, 0.85)', transform: `rotate(${rot}deg)`, boxShadow: '0 1px 0 rgba(0,0,0,.06)', backgroundImage: 'repeating-linear-gradient(90deg, rgba(0,0,0,.03) 0 2px, transparent 2px 5px)' }} />;
}

export function Hole({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`absolute h-3 w-3 rounded-full bg-paper ${className}`} style={{ boxShadow: 'inset 1px 1px 0 rgba(0,0,0,.25), 0 0 0 1px #3f3f3f33' }} />;
}
