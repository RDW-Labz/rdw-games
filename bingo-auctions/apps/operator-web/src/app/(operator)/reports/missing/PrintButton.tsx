'use client';

import { secondaryButtonStyle } from '@/components/Form';

export function PrintButton() {
  return (
    <button type="button" style={secondaryButtonStyle} onClick={() => window.print()}>
      Print
    </button>
  );
}
