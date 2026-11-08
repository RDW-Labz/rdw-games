import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { href } from '@/lib/router';
import { gsap, reducedMotion } from '@/lib/motion';
import { useToast } from '@/lib/toast';
import { isDemo } from '@/lib/api';
import { LogoMark, Wordmark } from './Logo';
import { Check, Cross, Logout, Menu as MenuGlyph } from '@/components/ui/Glyph';
import { LinkButton } from '@/components/ui/kit';
import { IsoStack } from '@/components/art/IsoStack';

export interface NavItem {
  path: string;
  label: string;
  match: (route: string[]) => boolean;
}

/* Cursor coordinates, set like a CAD readout in the corner. */
export function Coords({ dark }: { dark: boolean }) {
  const x = useRef<HTMLSpanElement>(null);
  const y = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const on = (e: PointerEvent) => {
      if (x.current) x.current.textContent = e.clientX.toFixed(2);
      if (y.current) y.current.textContent = e.clientY.toFixed(2);
    };
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, []);
  return (
    <div className={`hand pointer-events-none fixed left-6 top-[30px] z-[60] hidden text-[11px] leading-[1.05] tabular transition-colors duration-500 lg:block ${dark ? 'text-white/80' : 'text-ink-3'}`} aria-hidden>
      <div>
        X <span ref={x} className={dark ? 'text-white' : 'text-[#414141]'}>0.00</span>
      </div>
      <div>
        Y <span ref={y} className={dark ? 'text-white' : 'text-[#414141]'}>0.00</span>
      </div>
    </div>
  );
}

function NavPlate({ items, route, cta }: { items: NavItem[]; route: string[]; cta?: { label: string; path: string } }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const { profile, signOut } = useAuth();

  useEffect(() => setOpen(false), [route.join('/')]);
  useEffect(() => {
    if (!open || !menu.current || reducedMotion()) return;
    const links = menu.current.querySelectorAll('[data-m]');
    gsap.fromTo(menu.current, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 0.8, ease: 'joe.inOut' });
    gsap.fromTo(links, { opacity: 0, y: 14 }, { opacity: 1, y: 0, stagger: 0.05, delay: 0.25, duration: 0.8 });
  }, [open]);

  return (
    <>
      <div className="fixed inset-x-3 top-3 z-[70] flex justify-center lg:inset-x-0">
        <nav className="plate flex h-[52px] w-full items-center gap-2 px-2 lg:w-auto lg:gap-8 lg:pl-2 lg:pr-[6px]" aria-label="Main">
          <a href={href('')} className="flex items-center gap-2.5 pr-1">
            <LogoMark />
            <Wordmark />
          </a>
          <ul className="hidden items-center gap-6 lg:flex">
            {items.map((it) => (
              <li key={it.path}>
                <a href={href(it.path)} className="navlink" aria-current={it.match(route) ? 'page' : undefined}>
                  {it.label}
                  <span className="ul" />
                </a>
              </li>
            ))}
          </ul>
          <div className="ml-auto flex items-center gap-2">
            {cta && (
              <LinkButton href={href(cta.path)} size="sm" className="!hidden sm:!inline-flex" style={{ height: 40 }}>
                {cta.label}
              </LinkButton>
            )}
            <button onClick={() => setOpen((o) => !o)} className="mono flex h-10 min-w-[84px] items-center justify-center gap-2 border border-ink-rule/30 bg-sheet px-3 text-[13px] lg:hidden" style={{ borderRadius: 4 }} aria-expanded={open}>
              <span className="flex h-5 w-5 items-center justify-center bg-navy text-white" style={{ borderRadius: 2 }}>{open ? <Cross size={9} /> : <MenuGlyph size={10} />}</span>
              <span className="relative block h-[13px] w-[38px] overflow-hidden text-left">
                <span className={`block transition-transform duration-500 ease-joe-inout ${open ? '-translate-y-full' : ''}`}>Menu</span>
                <span className={`absolute left-0 top-full block transition-transform duration-500 ease-joe-inout ${open ? '-translate-y-full' : ''}`}>Close</span>
              </span>
            </button>
          </div>
        </nav>
      </div>
      {open && <div className="fixed inset-0 z-[64] bg-[#373737]/25 backdrop-blur-[3px] lg:hidden" onClick={() => setOpen(false)} />}
      {open && (
        <div ref={menu} className="fixed inset-x-3 top-[68px] z-[65] flex flex-col border border-ink-rule/30 px-6 pb-6 pt-6 lg:hidden" style={{ background: 'var(--sheet-modal)', boxShadow: 'var(--shadow-sheet)', borderRadius: 2 }}>
          <ul className="space-y-0">
            {items.map((it, i) => (
              <li key={it.path} data-m className="border-b border-dashed border-ink-dash/50 last:border-b-0">
                <a href={href(it.path)} className={`flex items-center justify-between py-3 ${it.match(route) ? 'text-ink' : 'text-ink/60'}`}>
                  <span className="title text-[32px]">{it.label}</span>
                  <span className="mono text-[12px] text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-6 space-y-4" data-m>
            {cta && (
              <LinkButton href={href(cta.path)} className="w-full justify-center">
                {cta.label}
              </LinkButton>
            )}
            <div className="flex items-center justify-between border-t border-dashed border-ink-dash/50 pt-4">
              <span className="hand text-[16px]">{profile?.full_name}</span>
              <button onClick={signOut} className="mono flex items-center gap-2 text-[13px] text-ink-2">
                <Logout size={14} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function UserNote({ dark }: { dark: boolean }) {
  const { profile, signOut } = useAuth();
  if (!profile) return null;
  return (
    <div className={`absolute right-6 top-[24px] z-[60] hidden items-center gap-3 transition-colors duration-500 lg:flex ${dark ? 'text-white' : 'text-ink'}`}>
      <span className="hand text-[15px]" style={{ color: 'inherit' }}>
        {profile.full_name}
        {profile.location ? ` · ${profile.location.split(',')[0]}` : ''}
      </span>
      <button onClick={signOut} title="Sign out" aria-label="Sign out" className={`flex h-8 w-8 items-center justify-center border transition-colors ${dark ? 'border-white/40 hover:bg-white/10' : 'border-ink-rule/30 bg-sheet hover:bg-white'}`} style={{ borderRadius: 2 }}>
        <Logout size={14} />
      </button>
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-[95] flex flex-col items-start gap-2 md:bottom-8 md:left-8 md:right-auto" aria-live="polite">
      {toasts.map((t, i) => (
        <div key={t.id} className="pointer-events-auto flex items-center gap-3 border border-ink-rule/30 bg-sheet px-3 py-2.5 pr-4" style={{ boxShadow: 'var(--shadow-sheet)', borderRadius: 2, transform: `rotate(${i % 2 ? 0.6 : -0.6}deg)`, animation: 'toast-in .7s cubic-bezier(.2,0,.1,1) both' }}>
          <span className="flex h-7 w-7 flex-none items-center justify-center text-white" style={{ background: t.tone === 'error' ? '#e76051' : t.tone === 'info' ? '#283f7d' : '#3b60c5', borderRadius: 2 }}>
            {t.tone === 'error' ? <Cross size={12} /> : <Check size={13} />}
          </span>
          <span className="mono text-[13px] text-ink-strong">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="ml-2 text-ink-3 hover:text-ink" aria-label="Dismiss">
            <Cross size={11} />
          </button>
        </div>
      ))}
      <style>{`@keyframes toast-in { from { opacity: 0; transform: translateX(-30px) rotate(-6deg); } }`}</style>
    </div>
  );
}

/* Footer: blueprint field with an embossed wordmark panel. */
function Footer() {
  return (
    <footer data-dark className="relative mt-24 overflow-hidden" style={{ background: '#064ab6' }}>
      <div
        className="absolute inset-0 opacity-60"
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.07) 0 1px, transparent 1px 14px), repeating-linear-gradient(-45deg, rgba(255,255,255,.07) 0 1px, transparent 1px 14px)' }}
      />
      <IsoStack className="relative mx-auto block w-[min(620px,92vw)] pt-10" />
      <div className="relative mx-auto -mt-2 w-[min(1160px,calc(100%-24px))] overflow-hidden px-6 pb-10 pt-12 md:px-16" style={{ background: '#162c68', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)' }}>
        <div className="relative grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <p className="title max-w-[420px] text-[24px] text-white md:text-[28px]">Learn the floor once. Do it right every shift.</p>
          <div className="text-[14px] leading-[1.6] text-white/85">
            <div className="mb-1 font-medium text-[#e76051]">Training</div>
            <a href={href('')} className="block hover:text-white">My training</a>
            <a href="mailto:training@bingoauctions.com" className="block hover:text-white">Ask a manager</a>
          </div>
          <div className="text-[14px] leading-[1.6] text-white/85">
            <div className="mb-1 font-medium text-[#e76051]">BinGo Auctions</div>
            <span className="block">Harrison, AR</span>
            <span className="block">Springdale, AR</span>
          </div>
        </div>
        <div className="relative mt-12 flex flex-wrap items-center justify-between gap-3 text-[12px] text-white/55">
          <span className="mono">© {new Date().getFullYear()} BinGo Auctions · Employee Training Hub{isDemo ? ' · demo data' : ''}</span>
          <span className="mono">Built by RDW Labz · Verrow AI</span>
        </div>
      </div>
    </footer>
  );
}

function useDarkUnder(x: number, y: number) {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const hit = document.elementsFromPoint(x, y).some((el) => el.closest('[data-dark]'));
      setDark((d) => (d === hit ? d : hit));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(check); };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    const t = setInterval(on, 800);
    on();
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); clearInterval(t); cancelAnimationFrame(raf); };
  }, [x, y]);
  return dark;
}

export function Shell({ items, route, cta, children }: { items: NavItem[]; route: string[]; cta?: { label: string; path: string }; children: ReactNode }) {
  const darkLeft = useDarkUnder(40, 40);
  const darkRight = useDarkUnder(typeof window !== 'undefined' ? window.innerWidth - 60 : 1200, 40);
  return (
    <div className="bg-grid relative min-h-screen">
      <div className="grain" />
      <Coords dark={darkLeft} />
      <UserNote dark={darkRight} />
      <NavPlate items={items} route={route} cta={cta} />
      <main className="relative">{children}</main>
      <Footer />
      <Toasts />
      {isDemo && (
        <div className="pointer-events-none fixed bottom-3 right-3 z-[60] hidden md:block">
          <span className="hand inline-block rotate-[-3deg] bg-sheet px-2 py-1 text-[13px] text-signal-orange2" style={{ boxShadow: 'var(--shadow-plate)' }}>
            Demo data
          </span>
        </div>
      )}
    </div>
  );
}
