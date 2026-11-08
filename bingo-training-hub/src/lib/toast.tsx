import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

const Ctx = createContext<{ toasts: Toast[]; push: (text: string, tone?: Toast['tone']) => void; dismiss: (id: number) => void } | null>(null);
let n = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, tone: Toast['tone'] = 'ok') => {
      const id = n++;
      setToasts((t) => [...t.slice(-2), { id, text, tone }]);
      setTimeout(() => dismiss(id), 4200);
    },
    [dismiss]
  );
  return <Ctx.Provider value={{ toasts, push, dismiss }}>{children}</Ctx.Provider>;
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside provider');
  return c;
}
