import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { gsap, reducedMotion } from '@/lib/motion';
import { Cross } from './Glyph';
import { Button, Hole } from './kit';

/* A sheet of paper slid onto the drafting table: it enters from the side,
   tilted, and settles at a 1° angle. Escape or the backdrop closes it. */
export function Modal({ open, onClose, title, kicker, wide, children, footer }: { open: boolean; onClose: () => void; title: string; kicker?: string; wide?: boolean; children: ReactNode; footer?: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    if (!open || !sheet.current || !back.current) return;
    closing.current = false;
    const mobile = window.innerWidth < 768;
    if (reducedMotion()) return;
    const tl = gsap.timeline();
    tl.fromTo(back.current, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'joe.out' }, 0);
    if (mobile) tl.fromTo(sheet.current, { yPercent: 110, rotate: -6 }, { yPercent: 0, rotate: 0, duration: 0.9, ease: 'joe.out' }, 0);
    else tl.fromTo(sheet.current, { x: '-110%', y: '10%', rotate: -20 }, { x: '0%', y: '0%', rotate: 0, duration: 1, ease: 'joe.out' }, 0);
    const under = sheet.current.parentElement?.querySelector('[data-under]');
    if (under && !mobile) tl.fromTo(under, { x: '-110%', rotate: -24 }, { x: '0%', rotate: 2.2, duration: 1.1, ease: 'joe.out' }, 0.04);
    return () => {
      tl.kill();
    };
  }, [open]);

  function close() {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion() || !sheet.current || !back.current) return onClose();
    const mobile = window.innerWidth < 768;
    const under = sheet.current.parentElement?.querySelector('[data-under]');
    const tl = gsap.timeline({ onComplete: onClose })
      .to(back.current, { opacity: 0, duration: 0.45, ease: 'joe.inOut' }, 0)
      .to(sheet.current, mobile ? { yPercent: 110, rotate: 4, duration: 0.6, ease: 'joe.in' } : { x: '-120%', rotate: -14, duration: 0.7, ease: 'joe.in' }, 0);
    if (under && !mobile) tl.to(under, { x: '-125%', rotate: -18, duration: 0.7, ease: 'joe.in' }, 0.05);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sheet.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])');
    first?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-center" role="dialog" aria-modal aria-label={title}>
      <div ref={back} onClick={close} className="absolute inset-0 bg-[#373737]/25 backdrop-blur-[4px]" />
      <div className={`relative w-full ${wide ? 'md:w-[min(860px,88vw)]' : 'md:w-[min(600px,88vw)]'}`}>
      <div data-under aria-hidden className="absolute inset-0 hidden border border-ink-rule/25 md:block" style={{ background: '#efe6d3', boxShadow: 'var(--shadow-sheet)', transform: 'rotate(2.2deg)', borderRadius: 2 }} />
      <div
        ref={sheet}
        className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden border border-ink-rule/30 md:max-h-[88vh]"
        style={{ background: 'var(--sheet-modal)', boxShadow: 'var(--shadow-sheet)', borderRadius: 2 }}
      >
        <div className="grain-local" style={{ opacity: 0.18 }} />
        <Hole className="left-4 top-4 hidden md:block" />
        <Hole className="bottom-4 left-4 hidden md:block" />
        <div className="relative flex items-start justify-between gap-4 px-6 pb-4 pt-6 md:px-14 md:pt-12">
          <div>
            {kicker && <div className="label mb-3">{kicker}</div>}
            <h2 className="title text-[28px] md:text-[36px]">{title}</h2>
          </div>
          <button data-close onClick={close} className="square-btn flex-none" aria-label="Close">
            <Cross size={14} />
          </button>
        </div>
        <div className="mx-6 rule-dot md:mx-14" />
        <ScrollBody>{children}</ScrollBody>
        {footer && <div className="relative grid grid-cols-[1fr_2fr] items-center gap-3 border-t border-dashed border-ink-dash/50 bg-[var(--sheet-modal)] px-6 py-4 md:flex md:flex-wrap md:justify-end md:px-14 md:py-5 [&>button]:w-full [&>button]:justify-center md:[&>button]:w-auto md:[&>button]:justify-start">{footer}</div>}
      </div>
      </div>
    </div>,
    document.body
  );
}

/* Scrollable sheet body with a paper fade + "more below" cue when it overflows. */
function ScrollBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 12);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6 md:px-14">
        {children}
      </div>
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center pb-2 transition-opacity duration-300 ${more ? 'opacity-100' : 'opacity-0'}`} style={{ background: 'linear-gradient(transparent, var(--sheet-modal) 70%)' }}>
        <span className="mono text-[11px] uppercase tracking-[0.06em] text-ink-2">More below ↓</span>
      </div>
    </div>
  );
}

/* Confirm dialog built on the same sheet (replaces browser confirm()). */
export function Confirm({ open, title, body, confirmLabel = 'Confirm', danger, busy, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      kicker="Please confirm"
      footer={
        <>
          <Button variant="cream" icon={false} onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'orange' : 'primary'} tile={danger ? '#283f7d' : undefined} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="lede text-[17px]">{body}</div>
    </Modal>
  );
}
