// A client-safe in-flight gate: `enter()` is true once until `leave()`.
//
// Used by the refund form so the second click of a double-click is dropped
// even when it lands in the same tick as the first, before React has rendered
// the disabled button. Lives on its own, with no Node imports, because the
// form is a client component: the claim keys next to it in refund-claim.ts use
// node:crypto and are server-only (that import broke the 2026-10-05 deploy).
export function inFlightGate(): { enter: () => boolean; leave: () => void; readonly busy: boolean } {
  let busy = false;
  return {
    enter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}
