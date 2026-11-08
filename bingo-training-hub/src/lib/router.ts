import { useEffect, useState } from 'react';

/* Tiny router (no dependency). Routes live in memory and are mirrored to the
   URL hash when the page is allowed to, so refresh + the back button keep your
   place in the real app. The embedded preview build (VITE_EMBED=1) writes
   links as plain "#r-a--b" names, because some hosts only pass simple hashes. */
const EMBED = import.meta.env.VITE_EMBED === '1';

const enc = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return EMBED ? '#r-' + parts.join('--') : '#/' + parts.join('/');
};
const parse = (h: string): string[] | null => {
  if (h.startsWith('#r-')) return h.slice(3).split('--').filter(Boolean);
  if (h === '' || h === '#' || h.startsWith('#/')) return h.replace(/^#\/?/, '').split('/').filter(Boolean);
  return null; // an in-page anchor like #quiz — not a route
};

let current: string[] = (typeof window !== 'undefined' && parse(window.location.hash)) || [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function set(parts: string[], push: boolean) {
  if (parts.join('/') === current.join('/')) return;
  current = parts;
  if (push) {
    try {
      history.pushState(null, '', enc(parts.join('/')));
    } catch {
      /* sandboxed frame: memory only */
    }
  }
  emit();
}

if (typeof window !== 'undefined') {
  const sync = () => {
    const p = parse(window.location.hash);
    if (p) set(p, false);
  };
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  // Route links are handled here so they never depend on the host navigating.
  window.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      const h = a?.getAttribute('href') ?? '';
      const p = h.startsWith('#/') || h.startsWith('#r-') ? parse(h) : null;
      if (!p) return;
      e.preventDefault();
      set(p, true);
    },
    true,
  );
}

export function useRoute(): string[] {
  const [parts, setParts] = useState<string[]>(current);
  useEffect(() => {
    const on = () => {
      setParts(current);
      window.scrollTo({ top: 0 });
    };
    subs.add(on);
    on();
    return () => {
      subs.delete(on);
    };
  }, []);
  return parts;
}

export function go(path: string) {
  set(path.split('/').filter(Boolean), true);
}

export function href(path: string) {
  return enc(path);
}
