'use client';

// A <select> that applies itself.
//
// The inventory filter bar is a plain GET <form> with a submit button. Changing
// the warehouse dropdown therefore did nothing until you also clicked Search —
// so picking "Dodge City" left Harrison's 9,885 lots on screen and read as
// "the warehouse selector doesn't filter" (field report 2026-07-27). With a
// second location live that is not just confusing, it is dangerous: staff can
// believe they are looking at the inventory of a warehouse they are not.
//
// Filter dropdowns are expected to apply on change. This submits the enclosing
// form itself, so the URL still carries the state (shareable, back-button
// friendly) and the server component stays the single source of truth — no
// client-side filtering, no duplicated query logic.
//
// requestSubmit() (not submit()) so the form's own validation and any submit
// handlers still run, and so the button's formaction semantics are preserved.

import { useRef } from 'react';

export function FilterSelect({
  name,
  defaultValue,
  children,
  ariaLabel,
}: {
  name: string;
  defaultValue: string;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);

  return (
    <select
      ref={ref}
      name={name}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      onChange={() => {
        // Fall back to a normal submit if requestSubmit is unavailable (older
        // Safari). Without the fallback the dropdown would silently go back to
        // doing nothing on exactly the browser this was reported from.
        const form = ref.current?.form;
        if (!form) return;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }}
      style={{
        padding: '6px 10px',
        background: 'var(--bg-elev)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      {children}
    </select>
  );
}
