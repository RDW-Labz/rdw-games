'use client';

// The one piece of this report that needs the browser. Everything else is
// server-rendered so the table is correct before any JS runs — which also
// means Ctrl-P works identically if this button is never clicked.

import { buttonStyle } from '@/components/Form';

export function PrintReportButton() {
  return (
    <button type="button" onClick={() => window.print()} style={buttonStyle}>
      Print
    </button>
  );
}
