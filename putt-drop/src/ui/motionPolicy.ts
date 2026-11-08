let savedReducedMotion = false;
let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

export function setReducedMotionPreference(on: boolean): void {
  savedReducedMotion = on;
}

export function reducedMotion(): boolean {
  if (typeof window !== "undefined") {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return true;
  }
  return savedReducedMotion;
}

export function bindReducedMotionListener(onChange?: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaListener = () => onChange?.();
  mediaQuery.addEventListener("change", mediaListener);
  return () => {
    if (mediaQuery && mediaListener) {
      mediaQuery.removeEventListener("change", mediaListener);
    }
    mediaQuery = null;
    mediaListener = null;
  };
}
